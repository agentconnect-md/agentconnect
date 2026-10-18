import type { MemoryEntryContent } from '@agentconnect.md/protocol'
import { ApiError } from '@/lib/api'

/** What a failed memory entry call tells the reader. */
export function memoryEntryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CONFLICT' || error.code === 'STALE_BINDING')
      return 'Memory changed. Your draft is kept; reload the saved version before editing again.'
    if (error.code === 'CURSOR_EXPIRED') return 'This list expired. Refresh memory to start again.'
    if (error.code === 'TOO_LARGE') return 'This change is too large to save here. Reduce its size and try again.'
    if (error.code === 'AMBIGUOUS_WRITE')
      return 'The change could not be confirmed. Check saved memory before making another change.'
    if (error.status === 403) return 'You no longer have permission to change this memory.'
    if (error.status === 503) return 'Memory is temporarily unavailable. Try loading it again.'
  }
  return error instanceof Error ? error.message : 'Memory is unavailable.'
}

/** A Markdown link opens a sibling only through a ref the read already annotated; refs are never guessed. */
export function linkedMemoryRef(document: MemoryEntryContent, name: string): string | undefined {
  const label = name.replace(/\.md$/, '')
  return [...(document.links ?? []), ...(document.backlinks ?? [])].find((edge) => edge.ref && edge.label === label)
    ?.ref
}
