/**
 * `SlackEventDedup` — bounded, TTL'd event-identity dedup for the shared Slack HTTP
 * ingress. Slack redelivers the same Events API envelope (same composite app,
 * workspace, and `event_id`, with an
 * incremented `X-Slack-Retry-Num`) whenever it doesn't see a fast 200 — a retry a
 * relay pod already ack'd, or one another pod behind the same LB handled. Marking
 * the identity on first sight and answering 200 on a repeat keeps one user message from
 * fanning out to the daemon twice. State is bounded by a hard-cap flush (the daemon
 * dedup-map precedent) so a hostile/id-churning stream can't grow it without bound.
 */
import type { Clock } from '@agentconnect.md/connection'

export interface SlackEventDedupOpts {
  /** How long a seen id stays deduped (default 5 min — Slack's retry horizon). */
  ttlMs?: number
  /** Max tracked ids before the map is flushed (default 50_000). */
  maxEntries?: number
}

export class SlackEventDedup {
  private readonly seenAt = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(
    private readonly clock: Clock,
    opts: SlackEventDedupOpts = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000
    this.maxEntries = opts.maxEntries ?? 50_000
  }

  /** True iff `identity` was seen (and not expired); otherwise marks it and returns
   *  false. An absent identity is never deduped (some envelopes carry no event id). */
  seen(identity: string | undefined): boolean {
    if (!identity) return false
    const now = this.clock.now()
    const expiry = this.seenAt.get(identity)
    if (expiry !== undefined && expiry > now) return true
    if (this.seenAt.size >= this.maxEntries) this.seenAt.clear()
    this.seenAt.set(identity, now + this.ttlMs)
    return false
  }
}
