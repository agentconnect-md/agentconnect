/**
 * `CpRoutingLayer` — the daemon's persisted CP-layer routing state. Holds
 * per-session assignments (route/assign) keyed by sessionKey and the global
 * rules (route/update), versioned by `routingEpoch`. `converge` applies the
 * register/ok reconcile snapshot. Every mutation persists via the injected io.
 */
import type { RouteAssign, RouteUpdate } from '@agentconnect.md/protocol'
import { cpRulesFromAssign, cpRulesFromUpdate, sessionKeyStr, type CpRule } from './routing-rule.js'

export interface CpRoutingSnapshot {
  routingEpoch: number
  assignments: Record<string, CpRule[]> // keyed by sessionKeyStr
  globalRules: CpRule[]
}

export interface CpRoutingIo {
  load(): CpRoutingSnapshot | undefined | Promise<CpRoutingSnapshot | undefined>
  save(s: CpRoutingSnapshot): void | Promise<void>
}

export class CpRoutingLayer {
  routingEpoch = 0
  private assignments = new Map<string, CpRule[]>()
  private globalRules: CpRule[] = []

  constructor(private readonly io: CpRoutingIo) {}

  /** Rehydrate from the persisted snapshot. Explicit, not constructor work, so the io can read
   *  an async store; a layer that is never hydrated simply starts empty. */
  async hydrate(): Promise<void> {
    const s = await this.io.load()
    if (!s) return
    this.routingEpoch = s.routingEpoch
    this.assignments = new Map(Object.entries(s.assignments))
    this.globalRules = s.globalRules
  }

  upsertAssign(a: RouteAssign): void {
    this.assignments.set(sessionKeyStr(a.sessionKey), cpRulesFromAssign(a, this.routingEpoch))
    this.persist()
  }

  applyUpdate(u: RouteUpdate): void {
    if (u.routingEpoch < this.routingEpoch) return // stale — idempotent re-apply guard
    this.routingEpoch = u.routingEpoch
    this.globalRules = cpRulesFromUpdate(u)
    this.persist()
  }

  // Intentionally converges ONLY `assignments`: the register/ok reconcile snapshot carries no
  // route/update global rules — those have their own epoch lifecycle via `applyUpdate`.
  converge(snap: { routingEpoch: number; assignments: RouteAssign[]; drop: { assignments: string[] } }): void {
    this.routingEpoch = snap.routingEpoch
    this.assignments = new Map(
      snap.assignments.map((a) => [sessionKeyStr(a.sessionKey), cpRulesFromAssign(a, snap.routingEpoch)])
    )
    for (const k of snap.drop.assignments) this.assignments.delete(k)
    this.persist()
  }

  effectiveRules(): CpRule[] {
    return [...[...this.assignments.values()].flat(), ...this.globalRules]
  }

  private persist(): void {
    // Persistence is a write-behind of in-memory state; a Promise-returning io settles on its own.
    void Promise.resolve(
      this.io.save({
        routingEpoch: this.routingEpoch,
        assignments: Object.fromEntries(this.assignments),
        globalRules: this.globalRules
      })
    ).catch(() => undefined)
  }
}
