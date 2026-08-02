// Home's dashboard row budget.
//
// The dashboard is one left card (Recent) beside a stack of two (Agents you use,
// Scheduled runs), and all three have to end on the same line with no half-drawn row
// and no dead strip inside a card. That falls out of one identity: every row is pinned
// to DASH_ROW_H and every card costs the same fixed chrome — its own two borders plus
// the head (2 + 45) — so the right column's SECOND card, gutter included, costs
// 2 + 45 + 16 = 63px, i.e. EXACTLY one row. The columns match when the left card shows
// one row MORE than the right column shows in total:
//
//     47 + (n+1)·63  ==  (47 + a·63) + 16 + (47 + c·63)   for a + c == n
//
// Hence 63 as the row height, not a rounder number — it is what the second card's
// chrome measures. Changing the grid's `gap-4`, the card border, or `.cardhead` padding
// changes it.

/** Every dashboard row, in all three cards. */
export const DASH_ROW_H = 63
/** What a card costs before its first row: its own two borders plus the head. */
export const CARD_CHROME_H = 47
/** The gutter between the right column's two cards (the grid's `gap-4`). */
export const CARD_GAP_H = 16
export const MAX_AGENT_ROWS = 4
export const MAX_CRON_ROWS = 3
/** Mobile stacks the cards, so there is nothing to align — a plain content cap. */
export const MOBILE_SESSION_ROWS = 6
/** Row equivalents of the right column at its floor (one agent + one schedule). No
 *  left card shorter than this can meet it, which is the whole sparse-state case. */
export const MIN_RIGHT_COLUMN_ROWS = 3

export interface DashboardRows {
  /** Rows the Recent card asks for. It renders `min(this, sessions available)`. */
  sessionRows: number
  agentRows: number
  cronRows: number
  /** False when the org has fewer sessions than `sessionRows`, so the left card can't
   *  reach the right column. Home then lets it keep its natural height (`self-start`)
   *  rather than stretching a mostly-empty card down to a line it didn't earn. */
  aligned: boolean
}

/**
 * Pick each card's row count.
 *
 * Two facts drive it. The viewport caps how many rows fit at all, and the identity
 * above fixes the left card at one row more than the right column's total. So: trim
 * the right column — schedules first, in two passes down to a 2-row floor before
 * either list is taken to one — until the matching left card fits, then let
 * `sessionRows` follow from what survived.
 *
 * Deliberately NOT part of the trim: how many sessions the org actually has. Trimming
 * against a thin session list would shrink the other two cards to chase an alignment
 * they can't reach anyway — a quiet org would see one agent instead of four on a
 * full-height window. The right column's floor is MIN_RIGHT_COLUMN_ROWS row
 * equivalents, so an org with fewer sessions than that simply cannot square up; that
 * is reported as `aligned: false` rather than papered over.
 *
 * @param availableHeight leftover viewport height for the grid; null ⇒ no cap.
 * @param sessions/agents/crons how many rows each card HAS to draw. An empty card
 *   still draws its placeholder row, so agents and crons cost a row either way — but
 *   sessions are the one list whose shortfall the layout cannot absorb.
 */
export function dashboardRowBudget({
  availableHeight,
  sessions,
  agents,
  crons
}: {
  availableHeight: number | null
  sessions: number
  agents: number
  crons: number
}): DashboardRows {
  let a = Math.min(MAX_AGENT_ROWS, Math.max(1, agents))
  let c = Math.min(MAX_CRON_ROWS, Math.max(1, crons))
  const capacity =
    availableHeight === null
      ? Number.POSITIVE_INFINITY
      : Math.max(MIN_RIGHT_COLUMN_ROWS, Math.floor((availableHeight - CARD_CHROME_H) / DASH_ROW_H))
  for (const floor of [2, 1]) {
    while (a + c + 1 > capacity && c > floor) c--
    while (a + c + 1 > capacity && a > floor) a--
  }
  const sessionRows = a + c + 1
  return { sessionRows, agentRows: a, cronRows: c, aligned: Math.max(1, sessions) >= sessionRows }
}
