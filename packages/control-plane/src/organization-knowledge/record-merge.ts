// Mechanical merges of several copies of one organization file into the record (assistant-mode.md §5.16 "Migration").
import {
  ORGANIZATION_MAX_BYTES,
  ORGANIZATION_SUMMARY_LINES,
  MEMBER_ENTRY_LINES,
  parseMembersDirectory,
  renderMembersDirectory,
  type MembersDirectoryEntry
} from '@agentconnect.md/protocol'

/** One copy of a file and when it was last written; the newest is the base. */
export interface RecordCopy {
  text: string
  at: Date
}

// A fact line's tail: its source and date, then its markers.
const TAIL = /\s+\((?:"[^"\n]+"|[^()"\n]+), (\d{4}-\d{2}-\d{2})\)(?:\s+\((?:web|inferred)\))*\s*$/

/** A line's fact without its bullet, source and date, compared without case. */
function factKey(line: string): string {
  return line
    .replace(/^\s*[-*]\s+/, '')
    .replace(TAIL, '')
    .trim()
    .toLowerCase()
}

function factDate(line: string): string {
  return TAIL.exec(line)?.[1] ?? ''
}

const newestFirst = (copies: readonly RecordCopy[]) => [...copies].sort((a, b) => b.at.getTime() - a.at.getTime())
const byDateDesc = (a: string, b: string) => (factDate(a) < factDate(b) ? 1 : factDate(a) > factDate(b) ? -1 : 0)

/** The frontmatter and title lines a file opens with, and the rest. */
function splitHead(text: string): { head: string[]; body: string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let at = 0
  if (lines[0] === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
    if (end > 0) at = end + 1
  }
  while (at < lines.length && lines[at]!.trim() === '') at++
  if (at < lines.length && /^#\s/.test(lines[at]!)) at++
  return { head: lines.slice(0, at), body: lines.slice(at) }
}

interface AboutDoc {
  head: string[]
  summary: string[]
  sections: Map<string, string[]>
}

function splitAbout(text: string): AboutDoc {
  const { head, body } = splitHead(text)
  const doc: AboutDoc = { head, summary: [], sections: new Map() }
  let section: string[] = doc.summary
  for (const line of body) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      section = doc.sections.get(heading[1]!) ?? []
      doc.sections.set(heading[1]!, section)
    } else if (line.trim() !== '') section.push(line)
  }
  return doc
}

function renderAbout(doc: AboutDoc): string {
  const out = [...doc.head]
  if (out.length && doc.summary.length) out.push('')
  out.push(...doc.summary)
  for (const [name, lines] of doc.sections) out.push('', `## ${name}`, ...lines)
  return `${out.join('\n').replace(/^\n+/, '')}\n`
}

/** About: the newest copy is the base; the others' lines it lacks join the same section, the summary kept at ten lines and the file within 16 KB by dropping the oldest-dated extras. */
export function mergeAbout(copies: readonly RecordCopy[]): string {
  const [base, ...others] = newestFirst(copies).map((copy) => splitAbout(copy.text))
  if (!base) return ''
  const known = new Set([...base.summary, ...[...base.sections.values()].flat()].map(factKey))
  const added: { section: string | null; line: string }[] = []
  for (const other of others)
    for (const [section, lines] of [[null, other.summary] as const, ...other.sections]) {
      for (const line of lines) {
        const key = factKey(line)
        if (known.has(key)) continue
        known.add(key)
        added.push({ section, line })
      }
    }
  added.sort((a, b) => byDateDesc(a.line, b.line))
  const build = (extras: typeof added) => {
    const doc: AboutDoc = { head: base.head, summary: [...base.summary], sections: new Map() }
    for (const [name, lines] of base.sections) doc.sections.set(name, [...lines])
    for (const { section, line } of extras) {
      if (section === null) {
        if (doc.summary.length < ORGANIZATION_SUMMARY_LINES) doc.summary.push(line)
      } else {
        const lines = doc.sections.get(section) ?? []
        lines.push(line)
        doc.sections.set(section, lines)
      }
    }
    return renderAbout(doc)
  }
  let extras = added
  let text = build(extras)
  while (extras.length && new TextEncoder().encode(text).byteLength > ORGANIZATION_MAX_BYTES) {
    extras = extras.slice(0, -1)
    text = build(extras)
  }
  return text
}

// A first look's place-file link is not part of the record's line (§5.16 "Channels keeps purposes only").
const PLACE_LINK = /\s*\[\[[^\]\n]*\]\]/g

/** Channels: lines unioned by `#name`, the newest date winning, every place-file link dropped. */
export function mergeChannels(copies: readonly RecordCopy[]): string {
  const ordered = newestFirst(copies)
  const base = ordered[0]
  if (!base) return ''
  const { head } = splitHead(base.text)
  const lines = new Map<string, string>()
  for (const copy of ordered)
    for (const raw of splitHead(copy.text).body) {
      const line = raw.replace(PLACE_LINK, '')
      const name = /^#([^\s:#][^:]*?)\s*:/.exec(line)?.[1]?.toLowerCase()
      if (!name) continue
      const current = lines.get(name)
      if (current === undefined || factDate(line) > factDate(current)) lines.set(name, line)
    }
  const out = [...head]
  if (out.length && lines.size) out.push('')
  out.push(...lines.values())
  return `${out.join('\n')}\n`
}

/** People: entries unioned by key and lines by field and text, each entry at ten lines by dropping the oldest-dated extras; an opted-out key's entry goes. */
export function mergePeople(copies: readonly RecordCopy[], optedOut: ReadonlySet<string>): string {
  const [base, ...others] = newestFirst(copies).map((copy) => parseMembersDirectory(copy.text))
  if (!base) return ''
  const entries: MembersDirectoryEntry[] = base.entries
    .filter((entry) => !entry.key || !optedOut.has(entry.key))
    .map((entry) => ({ ...entry, lines: entry.lines.filter((line) => line.trim() !== '') }))
  const byKey = new Map(entries.flatMap((entry) => (entry.key ? [[entry.key, entry] as const] : [])))
  const added = new Map<string, string[]>()
  for (const other of others)
    for (const entry of other.entries) {
      if (!entry.key || optedOut.has(entry.key)) continue
      const lines = entry.lines.filter((line) => line.trim() !== '')
      const target = byKey.get(entry.key)
      if (!target) {
        const fresh = { ...entry, lines }
        entries.push(fresh)
        byKey.set(entry.key, fresh)
        continue
      }
      const known = new Set(target.lines.map(factKey))
      const extra = added.get(entry.key) ?? []
      for (const line of lines)
        if (!known.has(factKey(line)) && !extra.some((e) => factKey(e) === factKey(line))) extra.push(line)
      added.set(entry.key, extra)
    }
  for (const [key, extra] of added) {
    const target = byKey.get(key)!
    const room = Math.max(0, MEMBER_ENTRY_LINES - target.lines.length)
    target.lines = [...target.lines, ...extra.sort(byDateDesc).slice(0, room)]
  }
  for (const entry of entries) entry.lines = [...entry.lines, '']
  const preamble = [...base.preamble]
  while (preamble.length && preamble[preamble.length - 1]!.trim() === '') preamble.pop()
  if (preamble.length && entries.length) preamble.push('')
  return `${renderMembersDirectory({ preamble, entries }).replace(/\n+$/, '')}\n`
}
