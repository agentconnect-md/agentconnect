import type { Clock } from '@agentconnect.md/connection'
import { sandboxSubjectAgentId, type SandboxSubject } from './sandbox-identity.js'

/** Allocator for the per-subject shim-binding generation; the daemon store is the durable one. */
export interface LaunchGenerations {
  nextSandboxGeneration(subject: string): Promise<number>
}

/** Per-subject launch state the driver keeps: the Sandbox it bound and which launch it is. */
export interface Launch {
  /** What the pod is claimed for: the agent, or one of its confined sessions (sandbox-identity.ts). */
  subject: SandboxSubject
  agentId: string
  sandboxName: string
  sandboxUid: string
  claimUid: string
  generation: number
  /** When this member started holding the launch; the idle floor when no activity is recorded. */
  since: number
}

export interface LaunchRegistryDeps {
  generations: LaunchGenerations
  clock: Clock
}

/**
 * Which subjects this member holds a Sandbox for, and whether it still may.
 *
 * Three subject-keyed maps that only make sense together: the launches themselves — the sole
 * subject → sandboxName translation layer — the monotonic release fence an acquisition compares
 * itself against, and the in-flight takeover re-derivations that dedupe concurrent adopters.
 *
 * The registry owns those primitives only. Invalidating a launch alongside the driver's session
 * and workspace-root state is one invariant spanning both, so its ORCHESTRATION stays in the
 * `K8sDriver` methods that own the other halves.
 */
export class LaunchRegistry {
  private readonly launches = new Map<string, Launch>()
  /** Takeover re-derivations in flight, per subject; a concurrent acquisition waits for the answer. */
  private readonly adopting = new Map<string, Promise<Launch | undefined>>()
  /** Bumped by `bumpRelease`; an acquisition in flight across a bump records nothing. */
  // Never cleaned, deliberately: a fence that forgot a departed subject would let a request issued
  // before its release record a launch after it. The entry is two numbers keyed by a subject.
  private readonly releases = new Map<string, number>()

  constructor(private readonly deps: LaunchRegistryDeps) {}

  // The allocation is a durable round trip, so a concurrent launch can resolve out of order — an
  // older generation never overwrites a newer one, keeping the recorded launch the highest.
  async recordLaunch(
    subject: SandboxSubject,
    sandboxName: string,
    sandboxUid: string,
    claimUid = sandboxUid
  ): Promise<Launch> {
    // Allocated from durable install-wide state, not from this process: the pod this launch is
    // about to dial may have been bound by a member that has since been rolled away.
    const generation = await this.deps.generations.nextSandboxGeneration(subject)
    const current = this.launches.get(subject)
    if (current && current.generation > generation) return current
    const launch: Launch = {
      subject,
      agentId: sandboxSubjectAgentId(subject),
      sandboxName,
      sandboxUid,
      claimUid,
      generation,
      since: this.deps.clock.now()
    }
    this.launches.set(subject, launch)
    return launch
  }

  /** Drop the cached launch, reporting the one that was there so the caller can settle its holds. */
  forgetLaunch(subject: string): Launch | undefined {
    const launch = this.launches.get(subject)
    this.launches.delete(subject)
    return launch
  }

  currentLaunch(subject: string): Launch | undefined {
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
    return this.releases.get(subject) ?? 0
  }

  /** The subject left this member: every launch acquisition that crossed the bump records nothing. */
  bumpRelease(subject: string): void {
    this.releases.set(subject, this.releaseFence(subject) + 1)
  }

  stillServed(subject: string, releasedAt: number): boolean {
    return this.releaseFence(subject) === releasedAt
  }

  assertStillServed(subject: string, releasedAt: number): void {
    if (!this.stillServed(subject, releasedAt)) {
      throw new Error(`sandbox ${subject} left this member while it was being acquired`)
    }
  }

  /** A takeover re-derivation in flight, or undefined — the same answer from the cluster. */
  adoptInFlight(subject: string): Promise<Launch | undefined> | undefined {
    return this.adopting.get(subject)
  }

  /** Single-flight the takeover re-derivation, handing `derive` the fence snapshot to compare against. */
  adopt(subject: string, derive: (releasedAt: number) => Promise<Launch | undefined>): Promise<Launch | undefined> {
    const inFlight = this.adopting.get(subject)
    if (inFlight) return inFlight
    const run = (async (): Promise<Launch | undefined> => {
      const existing = this.launches.get(subject)
      if (existing) return existing
      const releasedAt = this.releaseFence(subject)
      return await derive(releasedAt)
    })().finally(() => {
      if (this.adopting.get(subject) === run) this.adopting.delete(subject)
    })
    this.adopting.set(subject, run)
    return run
  }
}
