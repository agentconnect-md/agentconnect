// Pinned sessions — the session rail floats them above the rest so a run you keep
// coming back to stays one click away.
//
// A pin is a per-DEVICE console preference, stored in localStorage next to
// `ac-theme` and `ac.rail-collapsed` — deliberately NOT control-plane state:
//   - the CP holds orchestration metadata, not per-user UI preference rows, and a
//     pin buys nothing on the message path;
//   - with `OIDC_ISSUER` unset the CP's devAuth stub admits everyone as ONE
//     identity, so a server-side pin would be shared by every user of that
//     deployment — visibly wrong, and the no-auth default;
//   - the rail is desktop-only (mobile navigates sessions through the app bar),
//     so there is no cross-device pin to sync in the first place.
// If cross-device pins are ever wanted, this module is the whole seam: swap the
// reads/writes for a CP-backed hook and the rail is unchanged.
//
// Pins are stored as one flat id list (not keyed by agent) — the rail is already
// agent-filtered, so an id only ever surfaces on the agent it belongs to. Ids of
// deleted sessions therefore never match anything; `pruneSessionPins` keeps the
// list from growing without bound.

/** localStorage key holding the pinned session ids, newest pin first. */
export const SESSION_PINS_KEY = 'ac.pinned-sessions'

/** Hard cap on stored ids. Older pins fall off the end rather than accumulating
 *  forever in a browser that never revisits the sessions they belong to. */
export const SESSION_PINS_MAX = 200

/** The stored ids, newest pin first. `[]` on SSR, malformed JSON, or blocked storage. */
export function readSessionPins(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(SESSION_PINS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Tolerate anything a past version (or another tab) wrote: keep the strings,
    // drop the rest, and de-duplicate so a corrupted list still renders once.
    return dedupe(parsed.filter((id): id is string => typeof id === 'string' && id !== ''))
  } catch {
    return []
  }
}

/** Persist `ids` (newest first, capped). Silently no-ops when storage is blocked. */
export function writeSessionPins(ids: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_PINS_KEY, JSON.stringify(dedupe(ids).slice(0, SESSION_PINS_MAX)))
  } catch {
    /* private mode / storage disabled — the pin still applies for this page view */
  }
}

/** `ids` with `sessionId` pinned (newest first) or unpinned. Pure — persist via
 *  `writeSessionPins`, so the caller can update React state from the same value. */
export function toggleSessionPin(ids: string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? ids.filter((id) => id !== sessionId) : [sessionId, ...ids]
}

/** Drop stored ids that are not in `knownIds`, but ONLY when the list is over the
 *  cap. Sessions outside the currently loaded page are legitimately unknown, so
 *  pruning eagerly would silently unpin a session the moment it fell off the
 *  first page — the cap is what makes forgetting safe. */
export function pruneSessionPins(ids: string[], knownIds: Iterable<string>): string[] {
  if (ids.length <= SESSION_PINS_MAX) return ids
  const known = new Set(knownIds)
  const kept = ids.filter((id) => known.has(id))
  // Never let pruning empty the list: if none of the stored ids are on this page,
  // keep the newest cap-worth instead of discarding every pin the user made.
  return (kept.length > 0 ? kept : ids).slice(0, SESSION_PINS_MAX)
}

/** Split `sessions` into the pinned ones (in pin order, newest pin first) and the
 *  rest (input order preserved). */
export function partitionPinned<T extends { id: string }>(
  sessions: T[],
  pinnedIds: string[]
): { pinned: T[]; rest: T[] } {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const pinned: T[] = []
  const seen = new Set<string>()
  for (const id of pinnedIds) {
    const hit = byId.get(id)
    if (hit && !seen.has(id)) {
      pinned.push(hit)
      seen.add(id)
    }
  }
  return { pinned, rest: sessions.filter((s) => !seen.has(s.id)) }
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)]
}
