import type { PlanEntry } from '@agentconnect.md/protocol'

/** The shape an ACP `plan` update arrives in — every field optional on the wire. */
type RawPlanEntry = { content?: string; status?: string; priority?: string }

/**
 * Normalize one ACP `plan` update into the entry list. Both consumers read it through here
 * so the persisted transcript row and the live webchat stream can never disagree about what
 * the turn's plan was: an entry with no text of its own is dropped rather than rendered as a
 * blank line, and a missing status reads as not-yet-started.
 */
export function planEntriesOf(update: unknown): PlanEntry[] {
  const raw = (update as { entries?: RawPlanEntry[] } | null)?.entries
  if (!Array.isArray(raw)) return []
  const entries: PlanEntry[] = []
  for (const entry of raw) {
    const content = typeof entry?.content === 'string' ? entry.content : ''
    if (!content.trim()) continue
    entries.push({
      content,
      status: typeof entry.status === 'string' && entry.status ? entry.status : 'pending',
      ...(typeof entry.priority === 'string' && entry.priority ? { priority: entry.priority } : {})
    })
  }
  return entries
}

/** The plan row's one-line label: `Plan · <completed>/<total>`. */
export function planSummary(entries: PlanEntry[]): string {
  return `Plan · ${entries.filter((entry) => entry.status === 'completed').length}/${entries.length}`
}
