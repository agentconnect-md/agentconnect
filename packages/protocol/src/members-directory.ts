// The people directory's grammar, shared by the daemon that writes it and the Control Plane that reads and clears it (assistant-mode.md §5.17).

/** The directory: one entry per person, in the agent's shared memory layer. */
export const MEMBERS_DIRECTORY_FILE = 'members.md'

/** The opt-out marker, in the agent's memory tree beside the person layers: outside every store, so no memory tool, listing or dream reaches it. */
export const MEMBERS_OPT_OUT_PATH = 'people/.directory-opt-out.json'

/** A person's identity key: `user:<consoleUserId>`, or `<platform>:<tenant>:<memberId>` where only the tenant may hold a colon. */
const IDENTITY_KEY = /^(?:user:[^\s:`]+|[a-z][a-z0-9_-]*:[^\s`]+:[^\s:`]+)$/

/** The key an entry's heading carries in backticks at its end. */
const KEY_AT_END = /`([^`\s]+)`\s*$/

// Whatever whitespace the shape check accepts after the marker, kept so a rewrite leaves the line as written.
const HEADING = /^(##\s+)(.*)$/

/** Whether a string is an identity key an entry may be keyed by. */
export function isMemberIdentityKey(key: string): boolean {
  return key.length <= 512 && IDENTITY_KEY.test(key)
}

/** One entry: its heading after `## `, the identity key that heading ends in, and the lines up to the next heading. */
export interface MembersDirectoryEntry {
  heading: string
  key?: string
  lines: string[]
  /** The heading's marker as written, `## ` unless it was other whitespace. */
  marker?: string
}

/** The directory as lines: whatever precedes the first entry (its header and title), then the entries. */
export interface MembersDirectory {
  preamble: string[]
  entries: MembersDirectoryEntry[]
}

/** The identity key a heading ends in, when it is one. */
export function membersEntryKey(heading: string): string | undefined {
  const key = KEY_AT_END.exec(heading)?.[1]
  return key !== undefined && isMemberIdentityKey(key) ? key : undefined
}

/** Split the file into its preamble and its entries; a frontmatter block is preamble, and rendering it back is exact. */
export function parseMembersDirectory(text: string): MembersDirectory {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let at = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    at = end < 0 ? lines.length : end + 1
  }
  const preamble = lines.slice(0, at)
  const entries: MembersDirectoryEntry[] = []
  for (; at < lines.length; at++) {
    const line = lines[at]!
    const match = HEADING.exec(line)
    if (match) {
      const heading = match[2]!
      const key = membersEntryKey(heading)
      entries.push({
        heading,
        ...(key ? { key } : {}),
        ...(match[1] !== '## ' ? { marker: match[1]! } : {}),
        lines: []
      })
    } else if (entries.length > 0) entries[entries.length - 1]!.lines.push(line)
    else preamble.push(line)
  }
  return { preamble, entries }
}

/** The file's text again, from its parts. */
export function renderMembersDirectory(directory: MembersDirectory): string {
  return [
    ...directory.preamble,
    ...directory.entries.flatMap((e) => [`${e.marker ?? '## '}${e.heading}`, ...e.lines])
  ].join('\n')
}

/** The text without the entries keyed by any of `keys`, and which of those keys had one. */
export function withoutMembersEntries(text: string, keys: readonly string[]): { text: string; removed: string[] } {
  const drop = new Set(keys)
  const directory = parseMembersDirectory(text)
  const removed = new Set<string>()
  const entries = directory.entries.filter((entry) => {
    if (entry.key === undefined || !drop.has(entry.key)) return true
    removed.add(entry.key)
    return false
  })
  if (removed.size === 0) return { text, removed: [] }
  return { text: renderMembersDirectory({ ...directory, entries }), removed: [...removed] }
}

/** The opt-out marker could not be read, so nobody can be told apart from someone who opted out. */
export class MembersOptOutUnreadableError extends Error {
  constructor() {
    super('the directory opt-out record cannot be read')
    this.name = 'MembersOptOutUnreadableError'
  }
}

/** The marker's keys, each with the date it was cleared; an absent marker is empty, a malformed one throws. */
export function parseMembersOptOut(json: string | null | undefined): Map<string, string> {
  if (json === null || json === undefined || json.trim() === '') return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new MembersOptOutUnreadableError()
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new MembersOptOutUnreadableError()
  const out = new Map<string, string>()
  for (const [key, at] of Object.entries(keys)) if (typeof at === 'string') out.set(key, at)
  return out
}

/** The marker's text, keys sorted so an unchanged set writes the same bytes. */
export function renderMembersOptOut(keys: ReadonlyMap<string, string>): string {
  const sorted = Object.fromEntries([...keys].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return `${JSON.stringify({ version: 1, keys: sorted }, null, 2)}\n`
}
