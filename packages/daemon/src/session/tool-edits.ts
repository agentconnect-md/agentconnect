// File edits an ACP tool call reports as `diff` content; only metadata travels on chat events.
export interface ToolEdit {
  path: string
  created: boolean
  added: number
  removed: number
  beforeBytes?: number
  afterBytes: number
}

const MAX_EDITS = 16
const MAX_PATH = 4096

interface DiffItem {
  type: 'diff'
  path: string
  oldText?: string | null
  newText: string
}

function diffItems(content: unknown): DiffItem[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (item): item is DiffItem =>
      !!item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'diff' &&
      typeof (item as { path?: unknown }).path === 'string' &&
      (item as { path: string }).path.length > 0 &&
      (item as { path: string }).path.length <= MAX_PATH &&
      typeof (item as { newText?: unknown }).newText === 'string' &&
      ((item as { oldText?: unknown }).oldText == null || typeof (item as { oldText?: unknown }).oldText === 'string')
  )
}

// Line-multiset counts are a display hint; clients compute the real diff from the two snapshots.
function lineStats(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>()
  const lines = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : [])
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lines(after)) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added++
  }
  let removed = 0
  for (const left of counts.values()) removed += left
  return { added, removed }
}

export function toolEditsOf(update: { content?: unknown }): ToolEdit[] | undefined {
  const items = diffItems(update.content)
  if (!items.length) return undefined
  return items.slice(0, MAX_EDITS).map((item) => {
    const before = item.oldText ?? ''
    return {
      path: item.path,
      created: item.oldText == null,
      ...lineStats(before, item.newText),
      ...(item.oldText == null ? {} : { beforeBytes: Buffer.byteLength(item.oldText) }),
      afterBytes: Buffer.byteLength(item.newText)
    }
  })
}

// Reads one side of an edit back out of a persisted tool body; a created file has no before side.
export function toolEditText(body: unknown, path: string, side: 'before' | 'after'): string | undefined {
  const content = body && typeof body === 'object' ? (body as { content?: unknown }).content : undefined
  const item = diffItems(content)
    .slice(0, MAX_EDITS)
    .find((candidate) => candidate.path === path)
  if (!item) return undefined
  return side === 'after' ? item.newText : (item.oldText ?? undefined)
}
