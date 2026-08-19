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
}

export interface ParsedMemory {
  header: MemoryHeader
  body: string
  /** False when the file had no frontmatter at all (the legacy shape). */
  hadHeader: boolean
  /** The header's raw lines, verbatim. Stamping patches these rather than
   *  re-serializing, so nested blocks, comments, and quoting all survive. */
  headerLines: string[]
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
    return { header: {}, body: text, hadHeader: false, headerLines: [] }
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
  if (end === -1) return { header: {}, body: text, hadHeader: false, headerLines: [] }

  const headerLines = lines.slice(1, end)
  const header: MemoryHeader = {}
  for (const line of headerLines) {
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
    } else if (KNOWN.has(key)) {
      header[key as 'name' | 'description' | 'modified'] = value
    }
  }
  return {
    header,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n/, ''),
    hadHeader: true,
    headerLines
  }
}

/** Quote only when a plain YAML scalar would be ambiguous: a `key: value` split
 *  (`: `), a trailing colon, an inline comment (` #`), a leading indicator, or edge
 *  whitespace. An ISO timestamp's colons are safe and stay unquoted. */
function quoteIfNeeded(value: string): string {
  return /^[\s"'[{&*!|>%@`-]|: |:$| #|\s$/.test(value) ? JSON.stringify(value) : value
}

/**
 * Render a frontmatter block for a file being created. Values go through the same
 * scalar-quoting rule as a stamp, so a description containing `: `, ` #`, or a
 * leading YAML indicator cannot produce invalid or truncated frontmatter.
 */
export function buildMemoryHeader(fields: { description?: string; type?: MemoryEntryType }): string {
  const lines: string[] = []
  if (fields.description) lines.push(`description: ${quoteIfNeeded(fields.description.replace(/\s+/g, ' ').trim())}`)
  if (fields.type) lines.push(`type: ${fields.type}`)
  return lines.length > 0 ? `${FENCE}\n${lines.join('\n')}\n${FENCE}\n\n` : ''
}

/** Coerce a model-supplied string to one of our types, or undefined if it is not one. */
export function asMemoryEntryType(value: unknown): MemoryEntryType | undefined {
  return typeof value === 'string' && (MEMORY_ENTRY_TYPES as readonly string[]).includes(value)
    ? (value as MemoryEntryType)
    : undefined
}

/** The `name` slug for a topic file (`deploys.md` → `deploys`). */
export function memoryNameForTopic(topicName: string): string {
  return topicName.replace(/\.md$/i, '')
}

/** Replace a top-level `key:` line in the raw header, or append one if absent. */
function patchHeaderLine(lines: string[], key: string, value: string): string[] {
  const rendered = `${key}: ${quoteIfNeeded(value)}`
  const at = lines.findIndex((line) => !/^\s/.test(line) && new RegExp(`^${key}:`).test(line))
  if (at === -1) return [...lines, rendered]
  const next = [...lines]
  next[at] = rendered
  return next
}

/**
 * Keep a written file's header truthful: fill in `name` from the filename and stamp
 * `modified`. Only touches a file that ALREADY has a header — we never force
 * frontmatter onto a plain note the agent wrote by hand.
 *
 * The patch is line-level on purpose. Re-serializing from the parsed model would
 * silently drop anything the model does not represent — a nested `metadata:` block
 * (which is exactly how Claude Code writes its own memories), comments, blank lines,
 * or a key we chose not to interpret. Rewriting only the two lines we own keeps every
 * ordinary write lossless.
 */
export function stampMemoryHeader(topicName: string, text: string, modifiedIso: string): string {
  const parsed = parseMemoryFrontmatter(text)
  if (!parsed.hadHeader) return text
  let lines = patchHeaderLine(parsed.headerLines, 'name', memoryNameForTopic(topicName))
  lines = patchHeaderLine(lines, 'modified', modifiedIso)
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n\n${parsed.body.replace(/^\n+/, '')}`
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

/**
 * The ONE description of the memory file format and its upkeep rules. Every trigger
 * that writes memory — an ordinary turn, per-turn distillation, a dream — must teach
 * the same shape, so this text is shared rather than restated. Restating it is how
 * the three prompts drifted apart in the first place.
 */
export const MEMORY_FORMAT_GUIDANCE =
  'ONE FILE = ONE FACT, named in short kebab-case. Start each topic file with a header, then the body:\n' +
  '---\n' +
  'description: one line saying what this holds — it is how a future session decides to open it\n' +
  'type: user | feedback | project | reference\n' +
  '---\n' +
  '`user`: who the people here are — role, expertise, preferences. `feedback`: guidance about how to work, ' +
  'corrections and confirmed approaches alike; include WHY and how to apply it. `project`: ongoing work, goals, ' +
  'or constraints not derivable from the code or git history; write dates absolute, never "yesterday". ' +
  '`reference`: pointers to external resources — URLs, dashboards, tickets.\n' +
  'Link related memories inline as `[[topic-name]]` (no `.md`), and link liberally: a `[[name]]` with no file ' +
  'behind it yet is a marker for something worth writing later, not an error.\n' +
  'Never store what the repository already records — code structure, past fixes, git history, CLAUDE.md — or ' +
  'what only matters to the conversation in front of you.'
