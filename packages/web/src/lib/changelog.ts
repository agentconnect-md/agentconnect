// The console "What's new" feed, shown in the rail-footer help menu's changelog
// modal. This is the ONLY place to edit it — add a new entry at the TOP (newest
// first) to publish a release note. Each item's optional `kind` renders a small
// colored tag (New / Improved / Fixed); omit it for a plain bullet. An empty
// array is fine — the modal then shows a "nothing yet" state.

export type ChangeKind = 'new' | 'improved' | 'fixed'

export interface ChangelogItem {
  kind?: ChangeKind
  text: string
}

export interface ChangelogEntry {
  /** Historical release label — a version, date, or milestone name (e.g. "1.4", "July 2026"). */
  version: string
  /** Human date shown beside the version. */
  date: string
  items: ChangelogItem[]
}

// ⇩ Edit below. Newest entry first. (Seeded with the current release as an example
//    of the shape — replace the copy with your own wording.)
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.4',
    date: 'July 2026',
    items: [
      {
        kind: 'new',
        text: 'A Help & resources menu in the sidebar — docs, MCP connector setup, and keyboard shortcuts, all a click away.'
      },
      { kind: 'new', text: 'Daemons now show when a newer version is available in your release channel.' }
    ]
  }
]
