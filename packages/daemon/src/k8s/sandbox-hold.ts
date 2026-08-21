import type { SandboxHoldReason } from '@agentconnect.md/protocol'

/**
 * Leases that keep a cluster agent's pod out of the idle sweep while a console page is watching it.
 *
 * In memory and nowhere else, like every other keep-alive in this daemon: a lease that outlived the
 * process holding it would pin a pod for a page nobody has open. Each renewal is a fresh deadline,
 * so the whole release mechanism is "stop asking" — the page closing, the tab going to the
 * background, or the machine sleeping all end the hold within one TTL with nothing to unset.
 *
 * The TTL is deliberately several times the console's renewal cadence: one dropped poll (a slow
 * daemon, a re-render, a network blip) must not suspend a pod out from under a page that is still
 * open and still dirty.
 */
export const SANDBOX_HOLD_TTL_MS = 180_000

export interface SandboxHoldDeps {
  now: () => number
  ttlMs?: number
  log?: { debug?: (message: string) => void }
}

export class SandboxHolds {
  private readonly held = new Map<string, { until: number; reasons: SandboxHoldReason[] }>()

  constructor(private readonly deps: SandboxHoldDeps) {}

  /** Extend (or start) this agent's hold. Reasons are replaced, not merged: they describe the state
   *  the LAST poll observed, and a reason that has since gone away must stop being reported. */
  renew(agentId: string, reasons: SandboxHoldReason[]): number {
    const ttlMs = this.deps.ttlMs ?? SANDBOX_HOLD_TTL_MS
    this.held.set(agentId, { until: this.deps.now() + ttlMs, reasons: [...reasons] })
    return ttlMs
  }

  /** Drop the hold — the poll found nothing worth holding for. Not the same as letting it lapse:
   *  a clean tree should be suspendable on the sweep's own schedule, not one TTL later. */
  release(agentId: string): void {
    this.held.delete(agentId)
  }

  /** Whether the sweep must leave this agent's pod alone. Expiry is evaluated on read rather than on
   *  a timer of its own — the sweep is the only caller that cares, and it already runs on a tick. */
  holds(agentId: string): boolean {
    const entry = this.held.get(agentId)
    if (!entry) return false
    if (entry.until > this.deps.now()) return true
    this.held.delete(agentId)
    return false
  }

  /** What the live hold is for, for the sweep's log line; empty when nothing holds this agent. */
  reasons(agentId: string): SandboxHoldReason[] {
    return this.holds(agentId) ? [...(this.held.get(agentId)?.reasons ?? [])] : []
  }
}
