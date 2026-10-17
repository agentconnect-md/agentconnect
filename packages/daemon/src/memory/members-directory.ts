// The people directory's person rules (assistant-mode.md §5.17): whom an entry of members.md may be about, on whose turn, and who opted out.
import {
  MEMBERS_DIRECTORY_FILE,
  MEMBERS_OPT_OUT_PATH,
  membersEntryKey,
  parseMembersDirectory,
  parseMembersOptOut,
  renderMembersDirectory,
  renderMembersOptOut,
  withoutMembersEntries,
  type MembersDirectoryEntry
} from '@agentconnect.md/protocol'
import { MemoryEntriesError } from './entries/contract.js'
import {
  MEMORY_DIRNAME,
  PERSON_MEMORY_DIRNAME,
  withMemoryDirLock,
  writeMemoryFileHoldingLock,
  type MemoryFs,
  type MemoryHistorySink
} from './store.js'

export { MEMBERS_DIRECTORY_FILE, withoutMembersEntries }

/** Who is writing the directory, from trusted session facts only. */
export type MembersWriter =
  /** A first look of an internal public channel, or organization research: it writes about the people whose messages its round read, by the places it read them in. */
  | { kind: 'builder'; seen: ReadonlyMap<string, ReadonlySet<string>> }
  /** An internal public channel's long session on a turn a person typed: the keys of who sent it and who it mentions. */
  | { kind: 'conversation'; senders: ReadonlySet<string>; mentioned: ReadonlySet<string>; place?: string }
  /** A person's own DM or console conversation: their entry only, keyed `keys[0]`, in their own words. */
  | { kind: 'own'; keys: readonly string[] }
  /** Anything else may not write the directory, for this reason. */
  | { kind: 'refused'; reason: string }

/** The live answers the rules need; every one fails closed. */
export interface MembersLookups {
  /** Whether the key's person is a current member of the organization; false when it cannot be confirmed. */
  member(key: string): Promise<boolean>
  /** The console key a platform identity is linked to; undefined when it is not, or for a console key. */
  consoleKey(key: string): Promise<string | undefined>
  /** The opted-out keys; rejects when the marker cannot be read. */
  optedOut(): Promise<ReadonlyMap<string, string>>
}

/** What a write admitted changes beside the file once it has landed: keys to mark opted out, keys whose marker lifts. */
export interface MembersEffects {
  optOut: string[]
  lift: string[]
}

function refuse(reason: string): never {
  throw new MemoryEntriesError('FORBIDDEN', `members.md: ${reason} Nothing was saved.`)
}
function invalid(reason: string): never {
  throw new MemoryEntriesError('INVALID_ARGUMENT', `members.md: ${reason} Nothing was saved.`)
}

/** An entry as a refusal names it: its heading, cut short. */
const named = (entry: MembersDirectoryEntry): string =>
  `"## ${entry.heading.length > 80 ? `${entry.heading.slice(0, 79)}…` : entry.heading}"`

/** The entry's text as compared across a write: heading and lines, trailing blank lines dropped. */
function entryText(entry: MembersDirectoryEntry): string {
  return [entry.heading, ...entry.lines].join('\n').replace(/\s+$/, '')
}

/** The source and date a line ends in, as `(source, YYYY-MM-DD)` before an optional `(inferred)`; the shape check owns the rest. */
export function lineSource(line: string): string | undefined {
  return /\(([^()]+),\s*\d{4}-\d{2}-\d{2}\)(?:\s*\(inferred\))?\s*$/.exec(line)?.[1]?.trim()
}

const placeName = (name: string): string => name.trim().replace(/^#/, '').toLowerCase()

/** The lines of `now` not in `before`, counted, so a repeated line is new only once more than it was. */
function newLines(before: MembersDirectoryEntry | undefined, now: MembersDirectoryEntry): string[] {
  const left = new Map<string, number>()
  for (const line of before?.lines ?? []) left.set(line.trim(), (left.get(line.trim()) ?? 0) + 1)
  const added: string[] = []
  for (const line of now.lines) {
    const text = line.trim()
    if (!text) continue
    const n = left.get(text) ?? 0
    if (n > 0) left.set(text, n - 1)
    else added.push(text)
  }
  return added
}

/** Entries by key, a keyless one by its whole text so an unchanged one still matches; a key used twice is refused. */
function byKey(
  entries: readonly MembersDirectoryEntry[],
  refuseDuplicates: boolean
): Map<string, MembersDirectoryEntry> {
  const map = new Map<string, MembersDirectoryEntry>()
  for (const entry of entries) {
    const id = entry.key ?? `\u0000${entryText(entry)}`
    if (map.has(id) && refuseDuplicates && entry.key) invalid(`two entries are keyed \`${entry.key}\`; merge them.`)
    map.set(id, entry)
  }
  return map
}

/** One write of members.md against the person rules, and the marker changes it implies; throws the first rule it breaks. */
export async function checkMembersWrite(
  before: string | null,
  after: string | null,
  writer: MembersWriter,
  lookups: MembersLookups
): Promise<MembersEffects> {
  if (writer.kind === 'refused') refuse(writer.reason)
  const was = byKey(before === null ? [] : parseMembersDirectory(before).entries, false)
  const now = byKey(after === null ? [] : parseMembersDirectory(after).entries, true)
  const changed = [...now].filter(([id, entry]) => {
    const old = was.get(id)
    return !old || entryText(old) !== entryText(entry)
  })
  const removed = [...was].filter(([id]) => !now.has(id)).map(([, entry]) => entry)
  const effects: MembersEffects = { optOut: [], lift: [] }
  if (changed.length === 0 && removed.length === 0) return effects

  const own = writer.kind === 'own' ? new Set(writer.keys) : undefined
  for (const entry of removed) {
    if (writer.kind === 'builder') continue
    if (own) {
      if (!entry.key || !own.has(entry.key)) refuse(`here only your own entry may change, not ${named(entry)}.`)
      continue
    }
    if (writer.kind === 'conversation' && !(await onTurn(entry.key, writer, lookups)))
      refuse(`${named(entry)} is about someone not on this turn, so it stays.`)
  }

  const optedOut = await lookups.optedOut().catch(() => refuse('the record of who opted out cannot be read now.'))
  // A marked platform identity also marks the console account it is now linked to, so linking alone undoes no clear.
  const linkedMarks = new Map<string, string[]>()
  for (const marked of optedOut.keys()) {
    if (marked.startsWith('user:')) continue
    const linked = await lookups.consoleKey(marked)
    if (linked) linkedMarks.set(linked, [...(linkedMarks.get(linked) ?? []), marked])
  }
  // Every marked key that is this person's: the key itself, the console account it is linked to, and that account's other marks.
  const marksOf = (key: string, consoleKey: string | undefined): string[] => {
    const account = consoleKey ?? (key.startsWith('user:') ? key : undefined)
    const keys = [key, ...(account ? [account, ...(linkedMarks.get(account) ?? [])] : [])]
    return [...new Set(keys)].filter((k) => optedOut.has(k))
  }
  for (const [, entry] of changed) {
    const key = entry.key
    if (!key)
      invalid(
        `${named(entry)} ends in no identity key; end its heading with the person's key in backticks, as \`slack:T0EXAMPLE:U0EXAMPLE\`.`
      )
    if (writer.kind === 'own') {
      if (!writer.keys.includes(key))
        refuse(`here only your own entry may change, keyed \`${writer.keys[0]}\`, not ${named(entry)}.`)
      if (key !== writer.keys[0])
        invalid(
          `write your entry under \`${writer.keys[0]}\`, the account your identities share, and remove ${named(entry)}.`
        )
    }
    const consoleKey = await lookups.consoleKey(key)
    if (consoleKey && consoleKey !== key)
      invalid(`${named(entry)} belongs to someone who linked a console account; key it \`${consoleKey}\` instead.`)
    if (writer.kind === 'builder') builderLines(entry, key, was.get(key), writer)
    if (!(await lookups.member(key))) refuse(`${named(entry)} is not about a member of the organization.`)
    if (!own && marksOf(key, consoleKey).length > 0)
      refuse(
        `the person of ${named(entry)} cleared their entry, so nothing is written about them until they write it themselves.`
      )
    if (writer.kind === 'conversation') {
      if (!(await onTurn(key, writer, lookups)))
        refuse(`${named(entry)} is about someone not on this turn. ${turnKeys(writer)}`)
      const sender = writer.senders.has(key)
      for (const line of newLines(was.get(key), entry)) {
        const source = lineSource(line)
        if (source === undefined) continue
        if (source.toLowerCase() === 'self') {
          if (!sender)
            invalid(
              `"${line}" is sourced self, but its person did not say it here; source it #${writer.place ?? 'this-place'}.`
            )
        } else if (writer.place === undefined || placeName(source) !== placeName(writer.place))
          invalid(
            writer.place === undefined
              ? `"${line}" can be sourced only self here, since this place's name is not known yet.`
              : `"${line}" must be sourced #${writer.place}, where it was said${sender ? ', or self' : ''}.`
          )
      }
    }
    if (own) {
      for (const line of newLines(was.get(key), entry)) {
        const source = lineSource(line)
        if (source !== undefined && source.toLowerCase() !== 'self')
          invalid(`"${line}" must be sourced self: here you write only what the person says of themselves.`)
      }
      // Writing their entry again lifts every mark they carry, linked identities included, so relinking keeps it.
      const lifted = [...marksOf(key, consoleKey), ...[...own].filter((k) => optedOut.has(k))]
      effects.lift.push(...new Set(lifted))
    }
  }
  // Removing one's own entry, leaving none, is "forget me": every key they are known by is marked.
  if (writer.kind === 'own' && removed.length > 0 && ![...now.values()].some((e) => e.key && own?.has(e.key)))
    effects.optOut.push(...writer.keys)
  return effects
}

/** A builder writes about someone only where its round read their messages, each new line sourced by such a place; an older entry keeps its other sources. */
function builderLines(
  entry: MembersDirectoryEntry,
  key: string,
  old: MembersDirectoryEntry | undefined,
  writer: Extract<MembersWriter, { kind: 'builder' }>
): void {
  const places = writer.seen.get(key)
  if (!old && !places)
    refuse(`${named(entry)} is about someone whose messages this round did not read. ${seenKeys(writer)}`)
  const where = [...(places ?? [])].map((p) => `#${p}`).join(', ')
  for (const line of newLines(old, entry)) {
    const source = lineSource(line)
    if (source === undefined) continue
    if (source.toLowerCase() === 'self')
      invalid(
        `"${line}" is sourced self, but its person said nothing to you here; source it by the place you read it in.`
      )
    const seenHere = places !== undefined && [...places].some((p) => placeName(p) === placeName(source))
    if (source.startsWith('#') ? !seenHere : !old)
      invalid(
        places
          ? `"${line}" must be sourced by a place where this round read their messages: ${where}.`
          : `"${line}" must be sourced by a place where this round read their messages, and it read none of theirs. ${seenKeys(writer)}`
      )
  }
}

/** The people a builder's refusal offers, so the model can key an entry it may write. */
function seenKeys(writer: Extract<MembersWriter, { kind: 'builder' }>): string {
  const keys = [...writer.seen]
    .slice(0, 20)
    .map(([k, places]) => `\`${k}\` (${[...places].map((p) => `#${p}`).join(', ')})`)
  if (keys.length === 0) return "This round read no one's messages, so it adds no one."
  return `This round read messages from: ${keys.join(', ')}${writer.seen.size > 20 ? ` and ${writer.seen.size - 20} more` : ''}.`
}

const MAX_SEEN_ROUNDS = 64
const MAX_SEEN_KEYS = 5000

/** The people each builder round read messages from, with the places it read them in; kept in memory, so a restart forgets a round. */
export class DirectorySeen {
  private readonly rounds = new Map<string, Map<string, Set<string>>>()

  /** Note a person, by every key they are known by, as read in one place during a round. */
  record(round: string, keys: readonly string[], place: string): void {
    let seen = this.rounds.get(round)
    if (!seen) {
      seen = new Map()
      this.rounds.set(round, seen)
      if (this.rounds.size > MAX_SEEN_ROUNDS) this.rounds.delete(this.rounds.keys().next().value!)
    }
    for (const key of keys) {
      if (!seen.has(key) && seen.size >= MAX_SEEN_KEYS) continue
      seen.set(key, (seen.get(key) ?? new Set()).add(place))
    }
  }

  /** Whom a round has read so far. */
  of(round: string | undefined): ReadonlyMap<string, ReadonlySet<string>> {
    return (round !== undefined && this.rounds.get(round)) || new Map()
  }
}

/** Whether the key's person sent or was mentioned on the turn, directly or through the console account it is linked to. */
async function onTurn(
  key: string | undefined,
  writer: Extract<MembersWriter, { kind: 'conversation' }>,
  lookups: MembersLookups
): Promise<boolean> {
  if (!key) return false
  const at = (k: string) => writer.senders.has(k) || writer.mentioned.has(k)
  if (at(key)) return true
  const consoleKey = await lookups.consoleKey(key)
  return consoleKey !== undefined && at(consoleKey)
}

/** The keys a conversation's refusal offers, so the model can key an entry it may write. */
function turnKeys(writer: Extract<MembersWriter, { kind: 'conversation' }>): string {
  const keys = [
    ...[...writer.senders].map((k) => `\`${k}\` (sent this)`),
    ...[...writer.mentioned].filter((k) => !writer.senders.has(k)).map((k) => `\`${k}\` (mentioned)`)
  ]
  return keys.length ? `This turn's people: ${keys.join(', ')}.` : 'Nobody on this turn can be told.'
}

/** The one standing line a person's own DM or console conversation gets about their directory entry. */
export function membersOwnEntryGuidance(key: string): string {
  return (
    `${MEMBERS_DIRECTORY_FILE} in shared memory is the organization's directory of people's work facts. When the person ` +
    `here asks what you know about them, show their entry, keyed \`${key}\`, and what their own memory holds; at their ` +
    `request change or remove that entry and nothing else, with the entry tools and layer "shared", each line ending ` +
    `"(self, YYYY-MM-DD)". Removing it ("forget me") keeps them out of the directory until they write their entry again.`
  )
}

/** The marker's keys in the agent's memory tree; rejects when it is malformed. */
export async function readMembersOptOut(tree: MemoryFs): Promise<Map<string, string>> {
  return parseMembersOptOut((await tree.readFile(MEMBERS_OPT_OUT_PATH))?.content)
}

/** Add keys to the marker and lift others, under the marker's own lock; unchanged keys write nothing. */
export async function updateMembersOptOut(
  tree: MemoryFs,
  change: { add?: readonly string[]; remove?: readonly string[] },
  now: Date
): Promise<void> {
  if (!change.add?.length && !change.remove?.length) return
  await withMemoryDirLock(tree.subdir(PERSON_MEMORY_DIRNAME), async () => {
    const keys = await readMembersOptOut(tree)
    let dirty = false
    for (const key of change.add ?? [])
      if (!keys.has(key)) {
        keys.set(key, now.toISOString().slice(0, 10))
        dirty = true
      }
    for (const key of change.remove ?? []) dirty = keys.delete(key) || dirty
    if (dirty) await tree.writeFile(MEMBERS_OPT_OUT_PATH, renderMembersOptOut(keys))
  })
}

/** Rewrite the shared store's members.md under its lock; `edit` returns the new text, or undefined to leave it. */
async function editMembersFile(
  tree: MemoryFs,
  history: MemoryHistorySink,
  edit: (text: string) => string | undefined
): Promise<boolean> {
  return await withMemoryDirLock(tree, async () => {
    const current = await tree.readFile(`${MEMORY_DIRNAME}/${MEMBERS_DIRECTORY_FILE}`)
    if (!current) return false
    const next = edit(current.content)
    if (next === undefined || next === current.content) return false
    await writeMemoryFileHoldingLock(tree, MEMBERS_DIRECTORY_FILE, next, current.mtime, 'console', history)
    return true
  })
}

/** Remove the entries keyed by `keys` and mark `mark` opted out; whether any entry was there. */
export async function clearMembers(
  tree: MemoryFs,
  history: MemoryHistorySink,
  keys: readonly string[],
  mark: readonly string[],
  now: Date
): Promise<boolean> {
  // The marker first: a write racing the clear is then refused, never left standing.
  await updateMembersOptOut(tree, { add: mark }, now)
  return await editMembersFile(tree, history, (text) => {
    const result = withoutMembersEntries(text, keys)
    return result.removed.length ? result.text : undefined
  })
}

/** On linking, a marker on either key marks both and drops their entries; else the platform-keyed entry moves to the console key, or goes if one is there. */
export async function relinkMembers(
  tree: MemoryFs,
  history: MemoryHistorySink,
  from: string,
  to: string,
  now: Date
): Promise<void> {
  const marked = await readMembersOptOut(tree)
  if (marked.has(from) || marked.has(to)) {
    await clearMembers(tree, history, [from, to], [from, to], now)
    return
  }
  await editMembersFile(tree, history, (text) => relinkedMembers(text, from, to))
}

/** The directory with the platform-keyed entry moved to the console key, or dropped when one is there; undefined when there is none. */
export function relinkedMembers(text: string, from: string, to: string): string | undefined {
  const directory = parseMembersDirectory(text)
  const moving = directory.entries.find((entry) => entry.key === from)
  if (!moving) return undefined
  const kept = directory.entries.some((entry) => entry.key === to)
  const entries = kept
    ? directory.entries.filter((entry) => entry !== moving)
    : directory.entries.map((entry) => (entry === moving ? rekeyed(entry, to) : entry))
  return renderMembersDirectory({ ...directory, entries })
}

/** The same entry, its heading ending in another key. */
function rekeyed(entry: MembersDirectoryEntry, key: string): MembersDirectoryEntry {
  const heading = entry.heading.replace(/`[^`\s]+`\s*$/, `\`${key}\``)
  return { ...entry, heading, ...(membersEntryKey(heading) === key ? { key } : {}) }
}

/** The keys of every entry the directory holds now. */
export async function membersKeys(tree: MemoryFs): Promise<string[]> {
  const file = await tree.readFile(`${MEMORY_DIRNAME}/${MEMBERS_DIRECTORY_FILE}`)
  return file ? membersKeysOf(file.content) : []
}

/** The keys of every entry a directory's text holds. */
export function membersKeysOf(text: string): string[] {
  return parseMembersDirectory(text).entries.flatMap((entry) => (entry.key ? [entry.key] : []))
}
