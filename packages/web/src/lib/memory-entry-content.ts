import type { MemoryEntryContent } from '@agentconnect.md/protocol'

// Never make a partial document editable, including malformed or expired continuation chains.
export async function readCompleteMemoryEntry(
  read: (cursor?: string) => Promise<MemoryEntryContent | null>,
  maxBytes: number
): Promise<MemoryEntryContent | null> {
  let cursor: string | undefined
  let first: MemoryEntryContent | undefined
  let text = ''
  let bytes = 0
  const seen = new Set<string>()
  for (let page = 0; page < 128; page++) {
    const part = await read(cursor)
    if (!part) {
      if (first) throw new Error('Memory changed while loading. Reload it before editing.')
      return null
    }
    if (first && part.entry.revision !== first.entry.revision)
      throw new Error('Memory changed while loading. Reload it before editing.')
    first ??= part
    bytes += new TextEncoder().encode(part.text).byteLength
    if (bytes > Math.min(maxBytes, 4 * 1024 * 1024)) throw new Error('This memory is too large to open in the editor.')
    text += part.text
    if (part.complete) return { ...first, text, complete: true, nextContentCursor: undefined }
    if (!part.nextContentCursor || seen.has(part.nextContentCursor))
      throw new Error('Memory could not be loaded completely. Reload it before editing.')
    cursor = part.nextContentCursor
    seen.add(cursor)
  }
  throw new Error('Memory could not be loaded completely. Reload it before editing.')
}
