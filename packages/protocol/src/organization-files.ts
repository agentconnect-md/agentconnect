// The organization files' shapes (assistant-mode.md §5.15, §5.16), shared by the daemon that writes them and the Control Plane that checks console edits.

export const ORGANIZATION_FILE = 'organization.md'
export const CHANNELS_FILE = 'channels.md'
export const MEMBERS_FILE = 'members.md'
export const ORGANIZATION_FILES = [ORGANIZATION_FILE, CHANNELS_FILE, MEMBERS_FILE] as const
export type OrganizationFile = (typeof ORGANIZATION_FILES)[number]

/** organization.md's own sections, in their usual order; any may be missing. */
export const ORGANIZATION_SECTIONS = ['Products and customers', 'How it works', 'Repositories and systems'] as const
/** Lines organization.md's summary may hold before its first section. */
export const ORGANIZATION_SUMMARY_LINES = 10
export const ORGANIZATION_MAX_BYTES = 16 * 1024
/** The fields a members.md entry's lines start with (§5.17). */
export const MEMBER_FIELDS = ['Role', 'Works on', 'Knows about', 'Ask about'] as const
export type MemberField = (typeof MEMBER_FIELDS)[number]
export const MEMBER_ENTRY_LINES = 10

/** Who a fact line rests on: an internal place, a knowledge entry, a repository, the person themself, or a web page. */
export type FactSource =
  | { kind: 'channel'; name: string }
  | { kind: 'knowledge'; title: string }
  | { kind: 'repository'; path: string; part?: string }
  | { kind: 'self' }
  | { kind: 'web'; url: string }

/** One fact line: its text before the source, the source and date, and its markers; `line` counts from 1 in the whole file. */
export interface FactLine {
  line: number
  text: string
  source: FactSource
  date: string
  inferred: boolean
  web: boolean
}

/** One members.md entry: its heading's name and handles, and its lines (the seam the directory's person rules read). */
export interface MemberEntry {
  line: number
  name: string
  handles: string[]
  /** The person's identity key the heading ends in, in backticks; the person rules require it (§5.17). */
  key?: string
  facts: (FactLine & { field: MemberField })[]
}

export type ParsedOrganizationFile =
  | { file: typeof ORGANIZATION_FILE; facts: FactLine[] }
  | { file: typeof CHANNELS_FILE; channels: (FactLine & { channel: string })[] }
  | { file: typeof MEMBERS_FILE; entries: MemberEntry[] }

export type OrganizationFileParse = { ok: true; parsed: ParsedOrganizationFile } | { ok: false; refusal: string }

/** A check of a write's final text before it is stored: a one-line refusal, or undefined to let it through. */
export type MemoryTextCheck = (topic: string, text: string) => string | undefined

/** The organization file a topic names, compared without case so a case-insensitive home cannot slip past. */
export function organizationFileOf(topic: string): OrganizationFile | undefined {
  const name = topic.replace(/^.*\//, '').toLowerCase()
  return ORGANIZATION_FILES.find((file) => file === name)
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
// The tail every fact line ends in: "(<source>, <YYYY-MM-DD>)", then "(web)" and "(inferred)" as they apply.
const TAIL = /^(.*\S)\s+\(("[^"\n]+"|[^()"\n]+), (\d{4}-\d{2}-\d{2})\)((?:\s+\((?:web|inferred)\))*)\s*$/
const HEADING = /^#{1,6}\s/
const CHANNEL_SOURCE = /^#[^\s,#][^,]*$/
const REPOSITORY_SOURCE = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?: ([A-Za-z0-9_.-]+))?$/
const WEB_SOURCE = /^https?:\/\/\S+$/
const SOURCE_FORMS =
  'a #channel, a "knowledge entry title", an owner/repo path, self, or a web address followed by (web)'

class ShapeError extends Error {}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength

function realDate(date: string): boolean {
  if (!DATE.test(date)) return false
  const at = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === date
}

function sourceOf(raw: string): FactSource | undefined {
  const value = raw.trim()
  if (value === 'self') return { kind: 'self' }
  if (value.startsWith('"'))
    return value.length > 2 && value.endsWith('"') ? { kind: 'knowledge', title: value.slice(1, -1) } : undefined
  if (CHANNEL_SOURCE.test(value)) return { kind: 'channel', name: value.slice(1).trim() }
  if (WEB_SOURCE.test(value)) return { kind: 'web', url: value }
  const repo = REPOSITORY_SOURCE.exec(value)
  if (repo) return { kind: 'repository', path: repo[1]!, ...(repo[2] ? { part: repo[2] } : {}) }
  return undefined
}

/** One fact line, or a ShapeError saying what is wrong with it. */
function factOf(line: number, content: string): FactLine {
  // Only a line ending in ")" can carry a tail, so the backtracking match never runs on one that cannot.
  const tail = content.endsWith(')') ? TAIL.exec(content) : null
  if (!tail)
    throw new ShapeError(
      `does not end with its source and date, as "(#release-train, 2026-10-17)"; a source is ${SOURCE_FORMS}`
    )
  const [, text, rawSource, date, rawMarkers] = tail
  const source = sourceOf(rawSource!)
  if (!source) throw new ShapeError(`names "${rawSource!.trim()}" as its source, which is none of ${SOURCE_FORMS}`)
  if (!realDate(date!)) throw new ShapeError(`has "${date}", which is not a real YYYY-MM-DD date`)
  const markers = [...rawMarkers!.matchAll(/\((web|inferred)\)/g)].map((m) => m[1]!)
  if (new Set(markers).size !== markers.length)
    throw new ShapeError('repeats a marker; (web) and (inferred) appear at most once each')
  const web = markers.includes('web')
  if (source.kind === 'web' && !web) throw new ShapeError('has a web address as its source, so it also ends with (web)')
  if (source.kind !== 'web' && web) throw new ShapeError('says (web), but its source is not a web address')
  return { line, text: text!, source, date: date!, inferred: markers.includes('inferred'), web }
}

/** The body's lines with their line numbers in the whole file, after any frontmatter header. */
function bodyLines(text: string): { line: number; content: string }[] {
  const all = text.split('\n').map((content) => content.replace(/\r$/, ''))
  // A frontmatter header is an opening "---" line closed by another; the body starts after it.
  let start = 0
  if (all[0] === '---') start = all.findIndex((content, i) => i > 0 && content.trimEnd() === '---') + 1
  return all.slice(start).map((content, i) => ({ line: start + i + 1, content }))
}

/** The body's lines with an optional opening "# " title dropped; each file may start with one. */
function untitled(lines: { line: number; content: string }[]): { line: number; content: string }[] {
  const first = lines.findIndex((l) => l.content.trim() !== '')
  return first !== -1 && /^#\s/.test(lines[first]!.content) ? lines.filter((_, i) => i !== first) : lines
}

function parseOrganization(text: string): FactLine[] {
  const facts: FactLine[] = []
  const seen = new Set<string>()
  let section: string | undefined
  let summary = 0
  for (const { line, content } of untitled(bodyLines(text))) {
    if (content.trim() === '') continue
    if (HEADING.test(content)) {
      const name = /^##\s+(.+?)\s*$/.exec(content)?.[1]
      if (!name || !(ORGANIZATION_SECTIONS as readonly string[]).includes(name))
        throw lineError(
          line,
          content,
          `is a heading organization.md does not have; its only sections are ${ORGANIZATION_SECTIONS.map((s) => `"## ${s}"`).join(', ')}`
        )
      if (seen.has(name)) throw lineError(line, content, 'repeats a section; each appears at most once')
      seen.add(name)
      section = name
      continue
    }
    if (section === undefined && ++summary > ORGANIZATION_SUMMARY_LINES)
      throw lineError(
        line,
        content,
        `is line ${summary} of the summary before the first section; it holds at most ${ORGANIZATION_SUMMARY_LINES}`
      )
    facts.push(fact(line, content, content.replace(/^\s*[-*]\s+/, '')))
  }
  return facts
}

function parseChannels(text: string): (FactLine & { channel: string })[] {
  const channels: (FactLine & { channel: string })[] = []
  const lines = new Map<string, number>()
  for (const { line, content } of untitled(bodyLines(text))) {
    if (content.trim() === '') continue
    const place = /^#([^\s:#][^:]*?)\s*:\s+\S/.exec(content)
    if (!place)
      throw lineError(line, content, 'is not one place\'s line, "#name: what it is for (<source>, <YYYY-MM-DD>)"')
    const key = place[1]!.toLowerCase()
    const earlier = lines.get(key)
    if (earlier !== undefined)
      throw lineError(line, content, `repeats #${place[1]} from line ${earlier}; keep one line per place`)
    lines.set(key, line)
    channels.push({ ...fact(line, content), channel: place[1]! })
  }
  return channels
}

function parseMembers(text: string): MemberEntry[] {
  const entries: MemberEntry[] = []
  let entry: MemberEntry | undefined
  let count = 0
  for (const { line, content } of untitled(bodyLines(text))) {
    if (content.trim() === '') continue
    if (HEADING.test(content)) {
      const heading = /^##\s+(\S.*?)\s+\(([^()]+)\)(?:\s+`([^`\s]+)`)?\s*$/.exec(content)
      const handles = heading?.[2]!.split(',').map((h) => h.trim())
      if (!heading || !handles || handles.some((h) => h === ''))
        throw lineError(
          line,
          content,
          'is not an entry\'s heading, "## <display name> (<handles>) `<key>`", e.g. "## Alice (@alice on Slack) `slack:T0EXAMPLE:U0ALICE`"'
        )
      entry = { line, name: heading[1]!, handles, ...(heading[3] ? { key: heading[3] } : {}), facts: [] }
      entries.push(entry)
      count = 0
      continue
    }
    if (!entry)
      throw lineError(
        line,
        content,
        'is outside any entry; members.md holds only entries, each "## <display name> (<handles>)" and its lines'
      )
    if (++count > MEMBER_ENTRY_LINES)
      throw lineError(
        line,
        content,
        `is line ${count} of ${entry.name}'s entry; an entry has at most ${MEMBER_ENTRY_LINES}`
      )
    const field = MEMBER_FIELDS.find((f) => content.startsWith(`${f}:`))
    if (!field) throw lineError(line, content, `starts with none of ${MEMBER_FIELDS.map((f) => `${f}:`).join(', ')}`)
    entry.facts.push({ ...fact(line, content), field })
  }
  return entries
}

// A bulleted line is judged without its bullet and quoted as written.
function fact(line: number, content: string, body = content): FactLine {
  try {
    return factOf(line, body.trim())
  } catch (error) {
    if (error instanceof ShapeError) throw lineError(line, content, error.message)
    throw error
  }
}

class LineError extends Error {}

function lineError(line: number, content: string, problem: string): LineError {
  const excerpt = content.trim().length > 80 ? `${content.trim().slice(0, 77)}...` : content.trim()
  return new LineError(`line ${line} "${excerpt}" ${problem}`)
}

/** Parse an organization file's final text; a file that does not fit names its first failing line. */
export function parseOrganizationFile(file: OrganizationFile, text: string): OrganizationFileParse {
  if (file === ORGANIZATION_FILE && utf8Bytes(text) > ORGANIZATION_MAX_BYTES)
    return {
      ok: false,
      refusal: `${file} is ${utf8Bytes(text).toLocaleString('en-US')} bytes, over its 16 KB limit; shorten it. Nothing was saved.`
    }
  try {
    const parsed: ParsedOrganizationFile =
      file === ORGANIZATION_FILE
        ? { file, facts: parseOrganization(text) }
        : file === CHANNELS_FILE
          ? { file, channels: parseChannels(text) }
          : { file, entries: parseMembers(text) }
    return { ok: true, parsed }
  } catch (error) {
    if (error instanceof LineError)
      return { ok: false, refusal: `${file} ${error.message}. Nothing was saved; fix that line and save again.` }
    throw error
  }
}

/** The shapes' refusal for a write's final text into the shared layer; any other topic passes. */
export const organizationFileRefusal: MemoryTextCheck = (topic, text) => {
  const file = organizationFileOf(topic)
  if (!file) return undefined
  const result = parseOrganizationFile(file, text)
  return result.ok ? undefined : result.refusal
}
