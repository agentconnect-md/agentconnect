// Detail-crumb resolution for the console shell's top bar (and the mobile push-screen
// app bar, which reuses the same title).
//
// The shell derives a push title by looking the route id up in the console data lists.
// Those lists hold only what has actually been fetched — `allSessions` is the loaded
// cursor pages (50 rows each) — so a deep link, or a parent/child link, to a session
// outside them finds nothing and falls back to the section label. That fallback also
// collapses the crumb entirely (`show === false`), which used to take the session's
// status badge down with it.
//
// So a detail view that hydrates its own row (SessionDetailView, via fetchSessionDetail)
// publishes it through a CrumbSlot. The slot wins over the list lookup and, on its own,
// forces the detail crumb open.

/** What a detail view publishes to the shell while mounted. */
export interface CrumbSlot {
  title: string
  status: string
  statusLabel: string
}

export function detailCrumb(
  sectionLabel: string,
  listTitle?: string,
  slotTitle?: string
): { title: string; show: boolean } {
  const title = slotTitle || listTitle || sectionLabel
  // A slot title is authoritative even when it happens to equal the section label
  // (a session literally named "Sessions"), so it opens the crumb by itself.
  return { title, show: Boolean(slotTitle) || title !== sectionLabel }
}
