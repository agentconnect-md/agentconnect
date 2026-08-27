import type { Clock } from '@agentconnect.md/connection'

/** Allocator for the per-agent shim-binding generation; the daemon store is the durable one. */
export interface LaunchGenerations {
  nextSandboxGeneration(agentId: string): Promise<number>
}

/** Per-agent launch state the driver keeps: the Sandbox it bound and which launch it is. */
export interface Launch {
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
 * Which agents this member holds a Sandbox for, and whether it still may.
 *
 * Three agentId-keyed maps that only make sense together: the launches themselves — the sole
 * agentId → sandboxName translation layer — the monotonic release fence an acquisition compares
 * itself against, and the in-flight takeover re-derivations that dedupe concurrent adopters.
 *
 * The registry owns those primitives only. Invalidating a launch alongside the driver's session
 * and workspace-root state is one invariant spanning both, so its ORCHESTRATION stays in the
 * `K8sDriver` methods that own the other halves.
 */
export class LaunchRegistry {
  private readonly launches = new Map<string, Launch>()
  /** Takeover re-derivations in flight, per agent; a concurrent acquisition waits for the answer. */
  private readonly adopting = new Map<string, Promise<Launch | undefined>>()
  /** Bumped by `bumpRelease`; an acquisition in flight across a bump records nothing. */
  // Never cleaned, deliberately: a fence that forgot a departed agent would let a request issued
  // before its release record a launch after it. The entry is two numbers keyed by an agent id.
  private readonly releases = new Map<string, number>()

  constructor(private readonly deps: LaunchRegistryDeps) {}

  // The allocation is a durable round trip, so a concurrent launch can resolve out of order — an
  // older generation never overwrites a newer one, keeping the recorded launch the highest.
  async recordLaunch(agentId: string, sandboxName: string, sandboxUid: string, claimUid = sandboxUid): Promise<Launch> {
    // Allocated from durable install-wide state, not from this process: the pod this launch is
    // about to dial may have been bound by a member that has since been rolled away.
    const generation = await this.deps.generations.nextSandboxGeneration(agentId)
    const current = this.launches.get(agentId)
    if (current && current.generation > generation) return current
    const launch: Launch = { agentId, sandboxName, sandboxUid, claimUid, generation, since: this.deps.clock.now() }
    this.launches.set(agentId, launch)
    return launch
  }

  /** Drop the cached launch, reporting the one that was there so the caller can settle its holds. */
  forgetLaunch(agentId: string): Launch | undefined {
    const launch = this.launches.get(agentId)
    this.launches.delete(agentId)
    return launch
  }

  currentLaunch(agentId: string): Launch | undefined {
    return this.launches.get(agentId)
  }

  /** Agents this daemon holds a Sandbox for, and since when — the idle sweep's candidates. */
  launchedAgents(): Array<{ agentId: string; since: number }> {
    return [...this.launches.values()].map(({ agentId, since }) => ({ agentId, since }))
  }

  /** Snapshot the fence BEFORE an await; compare it AFTER. Read-compare-act, in that order. */
  releaseFence(agentId: string): number {
    return this.releases.get(agentId) ?? 0
  }

  /** The agent left this member: every launch acquisition that crossed the bump records nothing. */
  bumpRelease(agentId: string): void {
    this.releases.set(agentId, this.releaseFence(agentId) + 1)
  }

  stillServed(agentId: string, releasedAt: number): boolean {
    return this.releaseFence(agentId) === releasedAt
  }

  assertStillServed(agentId: string, releasedAt: number): void {
    if (!this.stillServed(agentId, releasedAt)) {
      throw new Error(`agent ${agentId} left this member while its sandbox was being acquired`)
    }
  }

  /** A takeover re-derivation in flight, or undefined — the same answer from the cluster. */
  adoptInFlight(agentId: string): Promise<Launch | undefined> | undefined {
    return this.adopting.get(agentId)
  }

  /** Single-flight the takeover re-derivation, handing `derive` the fence snapshot to compare against. */
  adopt(agentId: string, derive: (releasedAt: number) => Promise<Launch | undefined>): Promise<Launch | undefined> {
    const inFlight = this.adopting.get(agentId)
    if (inFlight) return inFlight
    const run = (async (): Promise<Launch | undefined> => {
      const existing = this.launches.get(agentId)
      if (existing) return existing
      const releasedAt = this.releaseFence(agentId)
      return await derive(releasedAt)
    })().finally(() => {
      if (this.adopting.get(agentId) === run) this.adopting.delete(agentId)
    })
    this.adopting.set(agentId, run)
    return run
  }
}
