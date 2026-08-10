// Pinned sessions — the dock's Sessions panel floats them above the rest so a run you keep coming back to stays one click away; a pin is a session bookmark, not an agent-list preference, so the list is GLOBAL across agents and opening one restores that session and with it its current place in the related-session tree.

/** One pinned session and the organization in which it can be opened. */
export interface SessionPin {
  id: string
  /** The org this pin opens in — scope for HYDRATION only, so one org's inaccessible ids cannot spend another's budget, never scope on the bookmark. Empty for pre-scope rows. */
  orgId: string
}

/** localStorage key, newest pin first — a per-DEVICE console preference stored beside `ac-theme` and `ac.rail-collapsed` (components/console/Shell.tsx), deliberately not CP state: the CP holds orchestration metadata rather than per-user UI preference rows, a pin buys nothing on the message path, and with `OIDC_ISSUER` unset (the no-auth default) devAuth admits everyone as ONE identity, so a server-side pin would be shared deployment-wide. Swapping these reads/writes for a CP-backed hook is the whole seam if cross-device pins are ever wanted. */
export const SESSION_PINS_KEY = 'ac.pinned-sessions'

/** Hard cap on stored pins: forgetting is by RECENCY only, since a pin missing from a page is unknown, not proof the session was deleted. */
export const SESSION_PINS_MAX = 200

/** How many off-page pinned rows the panel fetches individually. A list holds a handful; the cap only stops a pathological fan-out — pins beyond it still persist and render once they are on the loaded page. */
export const SESSION_PIN_HYDRATE_MAX = 12

/** The stored pins, newest first. `[]` on SSR, malformed JSON, or blocked storage. Legacy `string[]` / `{ id, agentId }` rows read as unscoped. */
export function readSessionPins(): SessionPin[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(SESSION_PINS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Tolerate anything a past version or another tab wrote: keep what parses as a pin, de-duplicated so a corrupt list renders once.
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

/** `pins` with `sessionId` pinned (newest first) or unpinned. Pure — persist via `writeSessionPins`, and set React state from the same value. */
export function toggleSessionPin(pins: SessionPin[], sessionId: string, orgId: string): SessionPin[] {
  return pins.some((p) => p.id === sessionId)
    ? pins.filter((p) => p.id !== sessionId)
    : [{ id: sessionId, orgId }, ...pins]
}

/** Ids hydratable in `orgId`, newest pin first. A legacy unscoped entry still lifts a row already listed but is never fetched: its org is unrecoverable locally, and the detail endpoint answers 404 for unauthorized as well as missing. */
export function pinnedIdsForOrg(pins: SessionPin[], orgId: string): string[] {
  return orgId ? pins.filter((p) => p.orgId === orgId).map((p) => p.id) : []
}

/** The pin ids a row answers to: every member of its conversation, or itself. The newest member moves, so its own id alone would come loose. */
export function sessionPinIds(row: { id: string; memberSessionIds?: string[] }): string[] {
  return row.memberSessionIds?.length ? row.memberSessionIds : [row.id]
}

/** Split `sessions` into the pinned ones (pin order) and the rest (input order). Matches on id alone, so a legacy unscoped pin still groups. */
export function partitionPinned<T extends { id: string }>(
  sessions: T[],
  pins: SessionPin[],
  /** Which stored ids claim a row — {@link sessionPinIds} for a list that carries conversations, whose representative id moves. */
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
