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
// The list is GLOBAL across agents. A pin is a session bookmark, not an agent-list
// preference: opening it restores that session and therefore its current position
// in the related-session tree. Each entry keeps its organization only so one org's
// inaccessible ids cannot consume another org's hydration budget; it does not scope
// the bookmark to an agent. The rail fetches the handful of pinned rows that are not
// on the loaded page (see SESSION_PIN_HYDRATE_MAX).
//
// Forgetting is by RECENCY ONLY: `writeSessionPins` keeps the newest
// SESSION_PINS_MAX entries and drops the tail. Nothing here ever infers that a
// session was deleted — a pin absent from a loaded page is unknown, not stale, and
// the console has no cheap proof of deletion (the detail endpoint answers 404 for
// unauthorized as well as missing). Growth is bounded by the cap instead.

/** One pinned session and the organization in which it can be opened. */
export interface SessionPin {
  id: string
  /** Empty only for entries written before organization scope was recorded. */
  orgId: string
}

/** localStorage key holding the pinned sessions, newest pin first. */
export const SESSION_PINS_KEY = 'ac.pinned-sessions'

/** Hard cap on stored pins. Older pins fall off the end rather than accumulating
 *  forever in a browser that never revisits the sessions they belong to. */
export const SESSION_PINS_MAX = 200

/** How many pinned rows the rail will fetch individually when they are not on the
 *  loaded page. A rail holds a handful of pins in practice; the cap only stops a
 *  pathological list from fanning out into hundreds of requests. Pins beyond it
 *  still persist — they render once they are on the loaded page. */
export const SESSION_PIN_HYDRATE_MAX = 12

/** The stored pins, newest first. `[]` on SSR, malformed JSON, or blocked storage.
 *  Accepts the legacy flat `string[]` shape and prior `{ id, agentId }` / `{ id }`
 *  rows as unscoped pins. */
export function readSessionPins(): SessionPin[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(SESSION_PINS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Tolerate anything a past version (or another tab) wrote: keep what parses as
    // a pin, drop the rest, and de-duplicate so a corrupted list renders once.
    return dedupe(parsed.map(asPin).filter((pin): pin is SessionPin => pin !== null))
  } catch {
    return []
  }
}

/** Persist `pins` (newest first, capped). Silently no-ops when storage is blocked. */
export function writeSessionPins(pins: SessionPin[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SESSION_PINS_KEY, JSON.stringify(dedupe(pins).slice(0, SESSION_PINS_MAX)))
  } catch {
    /* private mode / storage disabled — the pin still applies for this page view */
  }
}

/** `pins` with `sessionId` pinned (newest first) or unpinned. Pure — persist via
 *  `writeSessionPins`, so the caller can update React state from the same value. */
export function toggleSessionPin(pins: SessionPin[], sessionId: string, orgId: string): SessionPin[] {
  return pins.some((p) => p.id === sessionId)
    ? pins.filter((p) => p.id !== sessionId)
    : [{ id: sessionId, orgId }, ...pins]
}

/** Ids that can be hydrated in `orgId`, newest pin first. Legacy unscoped entries
 *  still lift rows already present in the rail, but are not fetched speculatively:
 *  their organization cannot be recovered from local storage and 404 is ambiguous. */
export function pinnedIdsForOrg(pins: SessionPin[], orgId: string): string[] {
  return orgId ? pins.filter((p) => p.orgId === orgId).map((p) => p.id) : []
}

/** Split `sessions` into the pinned ones (in pin order, newest pin first) and the
 *  rest (input order preserved). Matches on id alone, so a legacy pin whose
 *  organization was never recorded still groups correctly once its row appears. */
/** The stored-pin ids a row answers to: every member of its conversation, or just
 *  itself for an ordinary session. A conversation is identified in a list by its
 *  newest member, and that moves whenever another participant answers — so a pin
 *  recorded against the row's own id alone would come loose on ordinary activity. */
export function sessionPinIds(row: { id: string; memberSessionIds?: string[] }): string[] {
  return row.memberSessionIds?.length ? row.memberSessionIds : [row.id]
}

export function partitionPinned<T extends { id: string }>(
  sessions: T[],
  pins: SessionPin[],
  // Which stored ids claim a row. A conversation row stands for several member
  // sessions and is identified by whichever is newest, so matching on its `id`
  // alone would silently drop the pin the moment another participant answered.
  idsOf: (row: T) => readonly string[] = (row) => [row.id]
): { pinned: T[]; rest: T[] } {
  const byId = new Map<string, T>()
  for (const session of sessions) {
    for (const id of idsOf(session)) if (!byId.has(id)) byId.set(id, session)
  }
  const pinned: T[] = []
  const seen = new Set<T>()
  for (const { id } of pins) {
    const hit = byId.get(id)
    if (hit && !seen.has(hit)) {
      pinned.push(hit)
      seen.add(hit)
    }
  }
  return { pinned, rest: sessions.filter((s) => !seen.has(s)) }
}

function asPin(entry: unknown): SessionPin | null {
  if (typeof entry === 'string') return entry ? { id: entry, orgId: '' } : null
  if (!entry || typeof entry !== 'object') return null
  const { id, orgId } = entry as { id?: unknown; orgId?: unknown }
  if (typeof id !== 'string' || !id) return null
  return { id, orgId: typeof orgId === 'string' ? orgId : '' }
}

function dedupe(pins: SessionPin[]): SessionPin[] {
  const seen = new Set<string>()
  return pins.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
}
