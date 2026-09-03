import type { SandboxHoldReason } from '@agentconnect.md/protocol'

/**
 * Leases that keep one cluster POD out of the idle sweep while a console page is watching it.
 *
 * Keyed by sandbox SUBJECT, not by agent: an isolated session's work lives on its own pod (§11), so a
 * lease taken on a dirty session tree must hold that pod and no other — keyed by agent, one dirty page
 * pinned every sibling session pod of the agent, and the sweep judged them all on it. The agent's own
 * pod IS the agent id as a subject, so nothing about the agent-pod path changed.
 *
 * In memory and nowhere else, like every other keep-alive in this daemon: a lease that outlived the
 * process holding it would pin a pod for a page nobody has open. Each renewal is a fresh deadline,
 * so the whole release mechanism is "stop asking" — the page closing, the tab going to the
 * background, or the machine sleeping all end the hold within one TTL with nothing to unset.
 *
 * Leases are per HOLDER under one agent, not one lease per agent, because the facts they are taken
 * on are per SESSION: a page reads its own session's worktree. With a single agent-wide entry, a
 * second page polling a CLEAN session erased the still-live lease of a page watching a DIRTY one and
 * the pod could be suspended out from under it — last poll wins. Now each page renews and releases
 * only its own holder, and the sweep asks whether ANY of them is live.
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

/** The console page a lease belongs to — its session id, or {@link AGENT_WIDE_HOLDER} for a poll
 *  that named no session and therefore speaks for the agent rather than one worktree. */
export const AGENT_WIDE_HOLDER = '<agent>'

export class SandboxHolds {
  private readonly held = new Map<string, Map<string, { until: number; reasons: SandboxHoldReason[] }>>()

  constructor(private readonly deps: SandboxHoldDeps) {}

  /** Extend (or start) this HOLDER's lease on one pod. Reasons are replaced, not merged: they
   *  describe the state the LAST poll observed, and one that has since gone away must stop being
   *  reported. Other holders are untouched — this page speaks only for itself. */
  renew(subject: string, holder: string, reasons: SandboxHoldReason[]): number {
    const ttlMs = this.deps.ttlMs ?? SANDBOX_HOLD_TTL_MS
    const byHolder = this.held.get(subject) ?? new Map()
    byHolder.set(holder, { until: this.deps.now() + ttlMs, reasons: [...reasons] })
    this.held.set(subject, byHolder)
    return ttlMs
  }

  /** Drop this HOLDER's lease — its poll found nothing worth holding for. Not the same as letting it
   *  lapse: a tree that just went clean should be suspendable on the sweep's own schedule, not one TTL
   *  later. Any other page's live lease survives, which is the whole point of keying by holder. */
  release(subject: string, holder: string): void {
    const byHolder = this.held.get(subject)
    if (!byHolder) return
    byHolder.delete(holder)
    if (byHolder.size === 0) this.held.delete(subject)
  }

  /** Drop EVERY lease on this pod — it is gone or asleep, so no page's facts about it survive. */
  releaseAll(subject: string): void {
    this.held.delete(subject)
  }

  /** Whether the sweep must leave this pod alone: true while ANY holder's lease on it is live.
   *  Expiry is evaluated on read rather than on a timer of its own — the sweep is the only caller
   *  that cares, and it already runs on a tick. */
  holds(subject: string): boolean {
    return this.live(subject).length > 0
  }

  /** What the live leases are for, for the sweep's log line — the union across holders, deduped, so
   *  two dirty pages read as one `uncommitted-files` rather than two. Empty when nothing holds. */
  reasons(subject: string): SandboxHoldReason[] {
    return [...new Set(this.live(subject).flatMap((entry) => entry.reasons))]
  }

  /** The unexpired leases, pruning the rest on the way past. */
  private live(subject: string): Array<{ until: number; reasons: SandboxHoldReason[] }> {
    const byHolder = this.held.get(subject)
    if (!byHolder) return []
    const now = this.deps.now()
    for (const [holder, entry] of byHolder) if (entry.until <= now) byHolder.delete(holder)
    if (byHolder.size === 0) {
      this.held.delete(subject)
      return []
    }
    return [...byHolder.values()]
  }
}
