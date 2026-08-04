/**
 * The **message-ordering strategy** (`cursorOrdering`, audit Appendix A class c,
 * stage S3).
 *
 * ONE question is asked in seven places across the session manager and the CP
 * session reader: *does this platform's message id carry a native total order,
 * and how do two ids compare under it?* Every one of those sites spelled the
 * answer as `platform === 'slack'` next to a Slack-timestamp parser, so adding a
 * platform with ordered ids meant finding all seven — and forgetting one leaves a
 * read cursor that silently skips or re-delivers messages.
 *
 * WHY NOT THE MANIFEST. `messageIdOrdering` looks like a §5 manifest axis and is
 * not one: the manifest's rule is that a field is earned by a PRE-DISPATCH read,
 * and every read here happens inside a turn that already exists (assembling one
 * activation's prompt, paging one session's transcript). It is a daemon strategy
 * function (§7.4), registered per platform in the daemon's platform module layer,
 * exactly like `threadKeyForPost` and `sessionLinkSourceFor`.
 *
 * FAIL-CLOSED BY ABSENCE. `messageOrderingFor` returns `undefined` for a platform
 * with no native ordering — which is every platform but Slack today — and the
 * type system then forces each call site to state what "no order" means there.
 * There is deliberately NO neutral default object: a comparator that quietly
 * answers 0 would turn "these ids are not comparable" into "these ids are equal",
 * and the cursor bug that follows is invisible. Absence is the loud arm; every
 * caller's `undefined` branch is today's non-Slack behavior, unchanged — ids are
 * opaque, nothing is re-sorted, and the read cursor advances to the trigger.
 *
 * A PLATFORM SUPPLIES ONE THING: how to read a coordinate out of one of its
 * message ids. The total order, the synthetic-coordinate rule and the cutoff test
 * are shared, because they are DAEMON facts (legacy anchored cron/hook turns
 * persisted a UUID as the read cursor regardless of platform), not platform ones.
 */

/** How one platform's native message ids order and compare. */
export interface MessageOrdering {
  /** This id's native ordering coordinate, or `null` when it carries none — a
   *  synthetic or legacy coordinate (an anchored cron/hook UUID, a locally
   *  minted transcript key) that the platform never issued. */
  coordinate(id: string): bigint | null
  /** Total order over this platform's ids. Coordinate-less ids sort BEFORE real
   *  ones: a real follow-up must never look older than the synthetic cursor that
   *  created its thread. Two coordinate-less ids fall back to a stable string
   *  order so the comparator stays total. */
  compare(a: string, b: string): number
  /** Is `id` inside a wall-clock `cutoff` (at or before it)? A coordinate-less id
   *  is always inside: it cannot be compared with a wall-clock marker safely, so
   *  a snapshot must keep it rather than silently drop it. */
  withinCutoff(id: string, cutoff: string): boolean
}

/** Derive a full ordering from the only per-platform fact — its coordinate
 *  parser. Keeping the null rules here (rather than in each platform's arm)
 *  means a second ordered platform inherits the legacy-cursor behavior the
 *  daemon already depends on instead of re-deciding it. */
function orderingByCoordinate(coordinate: (id: string) => bigint | null): MessageOrdering {
  const compare = (a: string, b: string): number => {
    const am = coordinate(a)
    const bm = coordinate(b)
    if (am === null && bm === null) return a.localeCompare(b)
    if (am === null) return -1
    if (bm === null) return 1
    return am < bm ? -1 : am > bm ? 1 : 0
  }
  return {
    coordinate,
    compare,
    withinCutoff: (id, cutoff) => coordinate(id) === null || compare(id, cutoff) <= 0
  }
}

/** Slack's canonical message id is decimal seconds with microsecond precision
 *  (`1700000000.123456`). Parsed to an integer microsecond count and compared as
 *  BigInt, because `Number` cannot represent every microsecond at today's epoch —
 *  and because lexical order over the raw string is wrong the moment two ids
 *  differ in fractional digit count. */
function slackTsMicros(id: string): bigint | null {
  const m = /^(\d+)\.(\d{1,6})$/.exec(id)
  if (!m) return null
  return BigInt(m[1]!) * 1_000_000n + BigInt(m[2]!.padEnd(6, '0'))
}

/**
 * A `Map`, not an object literal, so lookup is total for EVERY string rather than
 * every string that is not an `Object.prototype` key — the same fail-closed
 * reasoning the §5 manifest registry carries.
 */
const ORDERINGS = new Map<string, MessageOrdering>([['slack', orderingByCoordinate(slackTsMicros)]])

/** The ordering strategy for `platform`, or `undefined` when its message ids
 *  carry no native order. Callers must handle the `undefined` arm explicitly —
 *  see the fail-closed note above. */
export function messageOrderingFor(platform: string): MessageOrdering | undefined {
  return ORDERINGS.get(platform)
}

/** Whether `platform`'s message ids order natively at all. For readers that only
 *  need the boolean — the CP session reader pages a transcript chronologically
 *  exactly when display order can diverge from mutation order, which is exactly
 *  when the platform can hand the daemon an out-of-order id. */
export function hasNativeMessageOrder(platform: string): boolean {
  return ORDERINGS.has(platform)
}
