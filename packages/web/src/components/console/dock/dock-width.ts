// The dock's width contract: the per-org preference a reader drags, and the applied width `fitDockWidth` bends out of it.

/** One org's remembered width, clamped when written. Scope is per ENTRY, so the whole preference stays one key to read or clear. */
export interface DockWidthEntry {
  orgId: string
  width: number
}

/** localStorage key for the remembered widths, MRU first. Per-device for the reasons the pins are (lib/session-pins.ts). */
export const DOCK_WIDTHS_KEY = 'ac.dock-width'

/** Narrowest usable dock: below it the strip cannot hold five tabs and the Git rows lose their +/− counts. */
export const DOCK_WIDTH_MIN = 380

/** Widest a reader may ASK for — a ceiling on the preference, granted in full only past 1696px of viewport. */
export const DOCK_WIDTH_MAX = 760

/** What a reader who never dragged gets, and the answer to every unreadable stored value. */
export const DOCK_WIDTH_DEFAULT = 480

/** Hard cap on remembered orgs: older entries fall off rather than accumulate in a browser that visits many orgs once. */
export const DOCK_WIDTHS_MAX = 20

/** Narrowest transcript the inline dock may leave standing — the 880px body is a maximum, not an entitlement. */
export const DOCK_BODY_FLOOR = 640

/** Chrome the two columns never get: 240 rail (EXPANDED — a media query cannot see it collapsed) + 60 padding + 26 gap − 30 bleed. */
export const DOCK_INLINE_CHROME = 240 + 60 + 26 - 30

/** Smallest viewport that honestly fits chrome + the minimum dock + the transcript floor, hence `--breakpoint-wide` in globals.css. */
export const DOCK_WIDE_MIN = DOCK_INLINE_CHROME + DOCK_WIDTH_MIN + DOCK_BODY_FLOOR

/** Custom property the applied width is delivered through, so the width on screen is never something React owns in server markup. */
export const DOCK_WIDTH_PROPERTY = '--dock-width'

/** `value` brought inside the contract. A non-finite input is no width at all, so it reads as "no preference" and yields the default. */
export function clampDockWidth(value: number): number {
  if (!Number.isFinite(value)) return DOCK_WIDTH_DEFAULT
  return Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, Math.round(value)))
}

/** `orgId`'s width, clamped. Never throws — first paint depends on it, so anything unreadable answers the default. */
export function readDockWidth(orgId: string): number {
  const entries = readEntries()
  // An empty `orgId` is every first paint, before `activeOrg` lands; MRU beats a default that shifts the body an effect later.
  const hit = entries.find((entry) => entry.orgId === orgId) ?? (orgId ? undefined : entries[0])
  return hit ? clampDockWidth(hit.width) : DOCK_WIDTH_DEFAULT
}

/** Widest dock `viewportWidth` holds with the floor standing. Below `wide:` (and on SSR's 0) it is an overlay and withholds nothing. */
export function dockWidthCeiling(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth < DOCK_WIDE_MIN) return DOCK_WIDTH_MAX
  return Math.max(DOCK_WIDTH_MIN, viewportWidth - DOCK_INLINE_CHROME - DOCK_BODY_FLOOR)
}

/** `width` bent to fit `viewportWidth`. The stored preference is untouched, so a dock dragged wide on a monitor only yields on a laptop. */
export function fitDockWidth(width: number, viewportWidth: number): number {
  return Math.min(clampDockWidth(width), dockWidthCeiling(viewportWidth))
}

// Hand-rolled rather than shipped from the functions above: this runs as source text before any bundle, so it can only use what the page already has.
/** Pre-paint script: `fitDockWidth(readDockWidth(''), innerWidth)` on the root, before console markup is parsed. SSR has no storage, so no render can do this. */
export const DOCK_WIDTH_INIT =
  // Unreadable storage answers the DEFAULT, exactly as `readDockWidth` does — setting nothing would leave the unfitted stylesheet value to be corrected later.
  `try{var r='';try{r=localStorage.getItem(${JSON.stringify(DOCK_WIDTHS_KEY)})||''}catch(e){}var l=[];try{l=JSON.parse(r)||[]}catch(e){}` +
  `var w=0,t,i=0;for(;Array.isArray(l)&&i<l.length&&!w;i++){t=l[i];if(t&&typeof t.orgId==='string'&&typeof t.width==='number'&&isFinite(t.width))` +
  `w=Math.min(${DOCK_WIDTH_MAX},Math.max(${DOCK_WIDTH_MIN},Math.round(t.width)))}` +
  `var v=window.innerWidth,c=v>=${DOCK_WIDE_MIN}?Math.max(${DOCK_WIDTH_MIN},v-${DOCK_INLINE_CHROME}-${DOCK_BODY_FLOOR}):${DOCK_WIDTH_MAX};` +
  `document.documentElement.style.setProperty('${DOCK_WIDTH_PROPERTY}',Math.min(w||${DOCK_WIDTH_DEFAULT},c)+'px')}catch(e){}`

/** Remember `width` for `orgId`, clamped and moved to the front — per org, so a dock dragged wide for a repo-heavy org stays there. */
export function writeDockWidth(orgId: string, width: number): void {
  if (typeof window === 'undefined') return
  const next = [{ orgId, width: clampDockWidth(width) }, ...readEntries().filter((e) => e.orgId !== orgId)]
  try {
    window.localStorage.setItem(DOCK_WIDTHS_KEY, JSON.stringify(next.slice(0, DOCK_WIDTHS_MAX)))
  } catch {
    /* private mode / storage disabled — the width still applies for this page view */
  }
}

/** Every stored entry, most recent first. `[]` on SSR or anything unreadable. */
function readEntries(): DockWidthEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(DOCK_WIDTHS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Tolerate anything a past version or another tab wrote: keep what parses as an entry, and the first of each org.
    return dedupe(parsed.map(asEntry).filter((entry): entry is DockWidthEntry => entry !== null))
  } catch {
    return []
  }
}

function asEntry(entry: unknown): DockWidthEntry | null {
  if (!entry || typeof entry !== 'object') return null
  const { orgId, width } = entry as { orgId?: unknown; width?: unknown }
  if (typeof orgId !== 'string' || typeof width !== 'number' || !Number.isFinite(width)) return null
  return { orgId, width }
}

function dedupe(entries: DockWidthEntry[]): DockWidthEntry[] {
  const seen = new Set<string>()
  return entries.filter((e) => (seen.has(e.orgId) ? false : (seen.add(e.orgId), true)))
}
