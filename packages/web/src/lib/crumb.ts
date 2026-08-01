// Detail-title resolution for the mobile push-screen app bar. (Desktop v2 has no top
// bar at all, so the badge this returns is currently unused there — the session page
// renders its own title + status row. The badge stays because the resolution rule is
// the same one a title strip would need, and dropping it would lose the id guard.)
//
// The shell derives a push title by looking the route id up in the console data lists.
// Those lists hold only what has actually been fetched — `allSessions` is the loaded
// cursor pages (50 rows each) — so a deep link, or a parent/child link, to a session
// outside them finds nothing and falls back to the section label. That fallback also
// collapses the crumb entirely (`show === false`), which would take the session's
// status badge down with it.
//
// So a detail view that hydrates its own row (SessionDetailView, via fetchSessionDetail)
// publishes it through a CrumbSlot. The slot wins over the list lookup and, on its own,
// forces the detail crumb open.
//
// The slot lives in shell state, and on client navigation the shell renders the new
// route BEFORE the old view's effect cleanup clears it — so it carries the route id it
// describes and is ignored on any other route. Without that check, navigating from
// session A to session B (or to an agent/daemon detail) paints A's title and badge on
// B for a commit.

/** What a detail view publishes to the shell while mounted. */
export interface CrumbSlot {
  /** Route id this slot describes — the shell ignores it anywhere else. */
  id: string
  title: string
  status: string
  statusLabel: string
}

export function detailCrumb(
  sectionLabel: string,
  routeId?: string,
  listTitle?: string,
  slot?: CrumbSlot | null
): { title: string; show: boolean; badge?: CrumbSlot } {
  const badge = slot && routeId && slot.id === routeId ? slot : undefined
  const title = badge?.title || listTitle || sectionLabel
  // A slot title is authoritative even when it happens to equal the section label
  // (a session literally named "Sessions"), so it opens the crumb by itself.
  return { title, show: Boolean(badge) || title !== sectionLabel, badge }
}
