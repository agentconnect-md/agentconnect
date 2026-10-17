// The organization record's text rules the Control Plane applies to console edits (assistant-mode.md §5.16): the shape check and People's entries by key.
import {
  membersEntryKey,
  parseMembersDirectory,
  parseOrganizationFile,
  renderMembersDirectory,
  type KnowledgeRecordFile
} from '@agentconnect.md/protocol'
import type { OrganizationKnowledgeKind, OrganizationRecordKind } from '../persistence/ports.js'
import { RECORD_FILES } from '../persistence/repositories/organization-record.repo.js'

export function isRecordKind(kind: OrganizationKnowledgeKind): kind is OrganizationRecordKind {
  return kind !== 'entry'
}

export function recordFileOf(kind: OrganizationRecordKind): KnowledgeRecordFile {
  return RECORD_FILES[kind]
}

/** The shape refusal for a record entry's new text, or undefined when it fits. */
export function recordShapeRefusal(kind: OrganizationRecordKind, text: string): string | undefined {
  const parsed = parseOrganizationFile(recordFileOf(kind), text)
  return parsed.ok ? undefined : parsed.refusal
}

/** Every People entry's key, in order. */
export function peopleKeys(text: string): string[] {
  return parseMembersDirectory(text).entries.flatMap((entry) => (entry.key ? [entry.key] : []))
}

/** The keys an edit takes out of People, which the edit marks opted out. */
export function removedPeopleKeys(before: string, after: string): string[] {
  const kept = new Set(peopleKeys(after))
  return [...new Set(peopleKeys(before))].filter((key) => !kept.has(key))
}

/** The keys an edit adds or changes an entry for. */
export function changedPeopleKeys(before: string, after: string): string[] {
  const old = new Map(
    parseMembersDirectory(before).entries.map((e) => [e.key, [e.heading, ...e.lines].join('\n').trim()])
  )
  return parseMembersDirectory(after).entries.flatMap((e) =>
    e.key && old.get(e.key) !== [e.heading, ...e.lines].join('\n').trim() ? [e.key] : []
  )
}

/** One entry's text as the console shows it: its heading and lines. */
export function peopleEntries(text: string, keys?: ReadonlySet<string>): { key: string; text: string }[] {
  return parseMembersDirectory(text).entries.flatMap((entry) =>
    entry.key && (!keys || keys.has(entry.key))
      ? [{ key: entry.key, text: [`## ${entry.heading}`, ...entry.lines].join('\n').trim() }]
      : []
  )
}

/** The block's single entry and the key its heading ends in, or why it is not one. */
export function parsePeopleBlock(block: string): { key: string } | { refusal: string } {
  const parsed = parseMembersDirectory(block)
  if (parsed.entries.length !== 1 || parsed.preamble.some((line) => line.trim() !== ''))
    return { refusal: 'send exactly one entry: its "## <name> (<handles>) `<key>`" heading and its lines' }
  const key = membersEntryKey(parsed.entries[0]!.heading)
  return key ? { key } : { refusal: "the entry's heading must end in its identity key in backticks" }
}

/** People's text with the entries keyed by `remove` dropped and `block` put in its key's place, or appended. */
export function replacePeopleEntries(
  text: string,
  remove: readonly string[],
  block?: { key: string; text: string }
): string {
  const directory = parseMembersDirectory(text)
  const drop = new Set(remove.filter((key) => key !== block?.key))
  let entries = directory.entries.filter((entry) => !(entry.key && drop.has(entry.key)))
  if (block) {
    const parsed = parseMembersDirectory(block.text.trim()).entries[0]!
    const replacement = { ...parsed, lines: [...trimTrailing(parsed.lines), ''] }
    const at = entries.findIndex((entry) => entry.key === block.key)
    // One entry per key: the first keeps its place, any later one goes.
    entries = entries.filter((entry, i) => entry.key !== block.key || i === at)
    if (at >= 0) entries[at] = replacement
    else {
      const last = entries[entries.length - 1]
      if (last && last.lines[last.lines.length - 1]?.trim() !== '') last.lines = [...last.lines, '']
      if (!last && directory.preamble[directory.preamble.length - 1]?.trim() !== '') directory.preamble.push('')
      entries.push(replacement)
    }
  }
  return `${renderMembersDirectory({ ...directory, entries }).replace(/\n+$/, '')}\n`
}

function trimTrailing(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end--
  return lines.slice(0, end)
}
