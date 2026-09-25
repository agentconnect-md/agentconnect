import type { Clock } from '@agentconnect.md/connection'
import { sandboxSubjectAgentId, type SandboxSubject } from './sandbox-subject.js'

/** Allocator for the per-subject shim-binding generation; the daemon store is the durable one. */
export interface LaunchGenerations {
  nextSandboxGeneration(subject: string): Promise<number>
}

/** Per-subject launch state every shim driver keeps: which incarnation it bound and which launch it is. */
export interface Launch {
  /** What the pod is claimed for: the agent, or one of its confined sessions (sandbox-identity.ts). */
  subject: SandboxSubject
  agentId: string
  /** The incarnation the shim binding is fenced on — `SpawnRecord.sandboxUid`. */
  sandboxUid: string
  generation: number
  /** When this member started holding the launch; the idle floor when no activity is recorded. */
  since: number
}

export interface LaunchRegistryDeps {
  generations: LaunchGenerations
  clock: Clock
  /** Dynamic ownership gate, checked again after the awaited generation allocation. */
  servesAgent?: (agentId: string) => boolean
}

// Cache launches and fence pending publication and adoption across local releases.
export class LaunchRegistry<L extends Launch = Launch> {
  private readonly launches = new Map<string, L>()
  private readonly publishing = new Map<string, { releasedAt: number; sandboxUid: string; run: Promise<L> }>()
  /** Takeover re-derivations in flight, per subject; a concurrent acquisition waits for the answer. */
  private readonly adopting = new Map<string, { releasedAt: number; run: Promise<L | undefined> }>()
  /** Bumped by `bumpRelease`; an acquisition in flight across a bump records nothing. */
  // Never cleaned, deliberately: a fence that forgot a departed subject would let a request issued
  // before its release record a launch after it. The entry is two numbers keyed by a subject.
  private readonly releases = new Map<string, number>()

  constructor(private readonly deps: LaunchRegistryDeps) {}

  // Concurrent acquisitions of one incarnation share its generation and work holds.
  async recordLaunch(
    subject: SandboxSubject,
    sandboxUid: string,
    extension: Omit<L, keyof Launch>,
    beforePublish?: (launch: L) => Promise<void>
  ): Promise<L> {
    const releasedAt = this.releaseFence(subject)
    const existing = this.launches.get(subject)
    if (existing?.sandboxUid === sandboxUid) return existing
    const publishing = this.publishing.get(subject)
    if (publishing?.sandboxUid === sandboxUid && this.stillServed(subject, publishing.releasedAt)) {
      return publishing.run
    }
    const run = this.publishLaunch(subject, sandboxUid, extension, releasedAt, beforePublish).finally(() => {
      if (this.publishing.get(subject)?.run === run) this.publishing.delete(subject)
    })
    this.publishing.set(subject, { releasedAt, sandboxUid, run })
    return run
  }

  private async publishLaunch(
    subject: SandboxSubject,
    sandboxUid: string,
    extension: Omit<L, keyof Launch>,
    releasedAt: number,
    beforePublish?: (launch: L) => Promise<void>
  ): Promise<L> {
    // Durable allocation can outlive this member's ownership, so recheck before publishing.
    const generation = await this.deps.generations.nextSandboxGeneration(subject)
    this.assertStillServed(subject, releasedAt)
    const current = this.launches.get(subject)
    if (current && current.generation > generation) return current
    const launch = {
      ...extension,
      subject,
      agentId: sandboxSubjectAgentId(subject),
      sandboxUid,
      generation,
      since: this.deps.clock.now()
    } as L
    if (beforePublish) {
      await beforePublish(launch)
      this.assertStillServed(subject, releasedAt)
      const current = this.launches.get(subject)
      if (current && current.generation > generation) return current
    }
    this.launches.set(subject, launch)
    return launch
  }

  /** Drop the cached launch, reporting the one that was there so the caller can settle its holds. */
  forgetLaunch(subject: string): L | undefined {
    const launch = this.launches.get(subject)
    this.launches.delete(subject)
    return launch
  }

  currentLaunch(subject: string): L | undefined {
    return this.launches.get(subject)
  }

  /** Subjects this daemon holds a Sandbox for, and since when — the idle sweep's candidates. */
  launched(): Array<{ subject: SandboxSubject; agentId: string; since: number }> {
    return [...this.launches.values()].map(({ subject, agentId, since }) => ({ subject, agentId, since }))
  }

  /** Every subject of the agent this member holds a launch for — its own pod's and its session pods'. */
  subjectsOf(agentId: string): SandboxSubject[] {
    return [...this.launches.values()].filter((launch) => launch.agentId === agentId).map((launch) => launch.subject)
  }

  /** Snapshot the fence BEFORE an await; compare it AFTER. Read-compare-act, in that order. */
  releaseFence(subject: string): number {
    const agentId = sandboxSubjectAgentId(subject)
    // Releasing an agent also fences session acquisitions that have not published a launch yet.
    return (this.releases.get(subject) ?? 0) + (agentId === subject ? 0 : (this.releases.get(agentId) ?? 0))
  }

  /** The subject left this member: every launch acquisition that crossed the bump records nothing. */
  bumpRelease(subject: string): void {
    this.releases.set(subject, (this.releases.get(subject) ?? 0) + 1)
  }

  stillServed(subject: string, releasedAt: number): boolean {
    return (
      this.releaseFence(subject) === releasedAt && (this.deps.servesAgent?.(sandboxSubjectAgentId(subject)) ?? true)
    )
  }

  assertStillServed(subject: string, releasedAt: number): void {
    if (!this.stillServed(subject, releasedAt)) {
      throw new Error(`sandbox ${subject} left this member while it was being acquired`)
    }
  }

  /** A takeover re-derivation in flight, or undefined — the same answer from the cluster. */
  adoptInFlight(subject: string): Promise<L | undefined> | undefined {
    const attempt = this.adopting.get(subject)
    return attempt && this.stillServed(subject, attempt.releasedAt) ? attempt.run : undefined
  }

  /** Single-flight the takeover re-derivation, handing `derive` the fence snapshot to compare against. */
  adopt(subject: string, derive: (releasedAt: number) => Promise<L | undefined>): Promise<L | undefined> {
    const inFlight = this.adoptInFlight(subject)
    if (inFlight) return inFlight
    const releasedAt = this.releaseFence(subject)
    const run = (async (): Promise<L | undefined> => {
      const existing = this.launches.get(subject)
      if (existing) return existing
      return await derive(releasedAt)
    })().finally(() => {
      if (this.adopting.get(subject)?.run === run) this.adopting.delete(subject)
    })
    this.adopting.set(subject, { releasedAt, run })
    return run
  }
}
