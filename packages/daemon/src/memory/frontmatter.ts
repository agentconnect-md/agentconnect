/**
 * Memory file headers — a small YAML frontmatter block at the top of each topic
 * file (Claude Code's agent-memory shape, #41):
 *
 *   ---
 *   name: deploys
 *   description: How we ship — pipeline owns deploys, never run them by hand
 *   type: project
 *   modified: 2026-08-19T12:00:00.000Z
 *   ---
 *   body…
 *
 * `description` is the recall key: the generated index carries it so the agent can
 * choose which topic to open WITHOUT reading every file. `name` is the node id that
 * `[[name]]` body links point at. Headerless files stay valid — everything here
 * degrades to "no header, whole text is the body".
 */

/** What a memory records. Mirrors the Claude Code taxonomy. */
export const MEMORY_ENTRY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryEntryType = (typeof MEMORY_ENTRY_TYPES)[number]

export interface MemoryHeader {
  name?: string
  description?: string
  type?: MemoryEntryType
  modified?: string
  /** Any other key the agent wrote — preserved verbatim so a stamp never drops data. */
  extra?: Record<string, string>
}

export interface ParsedMemory {
  header: MemoryHeader
  body: string
  /** False when the file had no frontmatter at all (the legacy shape). */
  hadHeader: boolean
}

const FENCE = '---'
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/
const KNOWN = new Set(['name', 'description', 'type', 'modified'])

function unquote(raw: string): string {
  const value = raw.trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** Split a memory file into its header and body. Never throws: a malformed or
 *  absent header just yields an empty header and the original text as the body. */
export function parseMemoryFrontmatter(text: string): ParsedMemory {
  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) {
    return { header: {}, body: text, hadHeader: false }
  }
  const lines = text.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === FENCE) {
      end = i
      break
    }
  }
  // An unterminated fence is not a header — treat the whole file as body.
  if (end === -1) return { header: {}, body: text, hadHeader: false }

  const header: MemoryHeader = {}
  const extra: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    // Nested YAML (a `metadata:` block) is not part of our flat shape; skip its children.
    if (/^\s/.test(line)) continue
    const match = KEY_LINE.exec(line)
    if (!match) continue
    const key = match[1]!
    const value = unquote(match[2]!)
    if (!value) continue
    if (key === 'type') {
      if ((MEMORY_ENTRY_TYPES as readonly string[]).includes(value)) header.type = value as MemoryEntryType
      else extra[key] = value
    } else if (KNOWN.has(key)) {
      header[key as 'name' | 'description' | 'modified'] = value
    } else {
      extra[key] = value
    }
  }
  if (Object.keys(extra).length > 0) header.extra = extra
  return {
    header,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n/, ''),
    hadHeader: true
  }
}

function quoteIfNeeded(value: string): string {
  return /^[\s"']|[:#]|\s$/.test(value) ? JSON.stringify(value) : value
}

/** Render a header + body back into file text. An empty header emits no fence. */
export function serializeMemoryFrontmatter(header: MemoryHeader, body: string): string {
  const lines: string[] = []
  if (header.name) lines.push(`name: ${quoteIfNeeded(header.name)}`)
  if (header.description) lines.push(`description: ${quoteIfNeeded(header.description)}`)
  if (header.type) lines.push(`type: ${header.type}`)
  if (header.modified) lines.push(`modified: ${header.modified}`)
  for (const [key, value] of Object.entries(header.extra ?? {})) lines.push(`${key}: ${quoteIfNeeded(value)}`)
  if (lines.length === 0) return body
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n\n${body.replace(/^\n+/, '')}`
}

/** The `name` slug for a topic file (`deploys.md` → `deploys`). */
export function memoryNameForTopic(topicName: string): string {
  return topicName.replace(/\.md$/i, '')
}

/**
 * Keep a written file's header truthful: fill in `name` from the filename and stamp
 * `modified`. Only touches a file that ALREADY has a header, or one the writer gave
 * a description — we never force frontmatter onto a plain note the agent wrote by hand.
 */
export function stampMemoryHeader(topicName: string, text: string, modifiedIso: string): string {
  const parsed = parseMemoryFrontmatter(text)
  if (!parsed.hadHeader) return text
  const header: MemoryHeader = { ...parsed.header, name: memoryNameForTopic(topicName), modified: modifiedIso }
  return serializeMemoryFrontmatter(header, parsed.body)
}

/**
 * Resolve a memory reference to a topic file name. Accepts a `[[wikilink]]`, a bare
 * name, or an ordinary `file.md`, so a link the agent read in one memory can be passed
 * straight back to `readMemory`.
 */
export function memoryRefToTopic(ref: string): string {
  const link = /^\s*\[\[(.+?)\]\]\s*$/.exec(ref)
  const bare = (link ? link[1]! : ref).trim()
  // Only a plain topic slug gets the extension. Anything else — a path, a dotfile
  // such as the reserved `.history` sidecar — passes through untouched so the path
  // validator still sees (and rejects) exactly what the caller asked for.
  // Unwrap the link either way, so the validator judges the real target and can
  // reject it by name (`[[.history]]` must fail as `.history`, not as a stray file).
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bare)) return link ? bare : ref.trim()
  return /\.md$/i.test(bare) ? bare : `${bare}.md`
}

/** Every `[[name]]` target in a body, de-duplicated, in first-appearance order. */
export function memoryLinkTargets(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(/\[\[([^\]\n]{1,120})\]\]/g)) {
    const name = match[1]!.trim()
    if (name) found.add(name)
  }
  return [...found]
}
