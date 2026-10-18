// The organization record as an assistant-mode agent's shared layer sees it (assistant-mode.md §5.16): organization.md, channels.md and members.md served from knowledge.
import type {
  KnowledgeRecordConflict,
  KnowledgeRecordOk,
  KnowledgeRecordReadReq,
  KnowledgeRecordWriteReq,
  KnowledgeRecordWriterKind
} from '@agentconnect.md/protocol'
import { MemoryEntriesError } from './entries/contract.js'
import type { MemoryFs, MemoryFsEntry, MemoryFsFile, MemoryFsFileStat, MemoryFsWriteOptions } from './fs.js'
import { parseMemoryFrontmatter } from './frontmatter.js'
import {
  CHANNELS_FILE,
  MEMBERS_FILE,
  ORGANIZATION_FILE,
  ORGANIZATION_FILES,
  organizationFileOf,
  parseOrganizationFile,
  type OrganizationFile
} from './organization-files.js'
import { MEMORY_DIRNAME } from './store.js'

/** One record entry: its knowledge revision and when it was written, its text, and the keys People's opt-out holds. */
export interface RecordEntry {
  revision: number
  updatedAt: string
  content: string
  optOut: string[]
}

/** What a write of one record entry carries beside its text: who wrote it and the opt-out keys it marks or lifts. */
export interface RecordWrite {
  baseRevision: number
  content: string
  writerKind: KnowledgeRecordWriterKind
  optOut: { mark: string[]; lift: string[] }
}

/** The record of one agent's organization, reached through the Control Plane. */
export interface OrganizationRecordPort {
  read(file: OrganizationFile): Promise<RecordEntry>
  /** The new revision, or the current entry when `baseRevision` is stale. */
  write(
    file: OrganizationFile,
    write: RecordWrite
  ): Promise<{ revision: number; updatedAt: string } | { conflict: RecordEntry }>
}

/** The Control Plane calls a port makes. */
export interface OrganizationRecordClient {
  knowledgeRecordRead(payload: KnowledgeRecordReadReq): Promise<KnowledgeRecordOk>
  knowledgeRecordWrite(
    payload: KnowledgeRecordWriteReq
  ): Promise<{ ok: KnowledgeRecordOk } | { conflict: KnowledgeRecordConflict }>
}

/** The Control Plane does not keep the record right now (not connected, or not advertising it); nothing is read or written. */
export class RecordUnavailableError extends MemoryEntriesError {
  constructor() {
    super('UNAVAILABLE', 'the organization record is not available right now')
    this.name = 'RecordUnavailableError'
  }
}

const CACHE_MS = 15_000

/** One agent's port: reads are kept briefly so a turn's listing and reads cost one round trip per file. */
export class OrganizationRecordCache implements OrganizationRecordPort {
  private readonly entries = new Map<OrganizationFile, { entry: RecordEntry; at: number }>()

  constructor(
    private readonly agentId: string,
    private readonly client: () => OrganizationRecordClient,
    private readonly now: () => number = Date.now
  ) {}

  async read(file: OrganizationFile): Promise<RecordEntry> {
    const cached = this.entries.get(file)
    if (cached && this.now() - cached.at < CACHE_MS) return cached.entry
    const ok = await this.client().knowledgeRecordRead({ agentId: this.agentId, file })
    return this.keep(file, {
      revision: ok.revision,
      updatedAt: ok.updatedAt,
      content: ok.content ?? '',
      optOut: ok.optOut ?? []
    })
  }

  async write(
    file: OrganizationFile,
    write: RecordWrite
  ): Promise<{ revision: number; updatedAt: string } | { conflict: RecordEntry }> {
    this.entries.delete(file)
    const answer = await this.client().knowledgeRecordWrite({ agentId: this.agentId, file, ...write })
    if ('conflict' in answer) {
      const { revision, updatedAt, content, optOut } = answer.conflict
      return { conflict: this.keep(file, { revision, updatedAt, content, optOut }) }
    }
    // People's opt-out changed with it, so the next read of any entry asks again.
    if (write.optOut.mark.length || write.optOut.lift.length) this.entries.clear()
    return { revision: answer.ok.revision, updatedAt: answer.ok.updatedAt }
  }

  private keep(file: OrganizationFile, entry: RecordEntry): RecordEntry {
    this.entries.set(file, { entry, at: this.now() })
    return entry
  }
}

/** Refusal of a whole-file write of a record entry: the record is changed only with the entry tools. */
export const RECORD_ENTRY_TOOLS_ONLY = (file: string) =>
  `${file} in shared memory is the organization record, changed only with the entry tools: read its text and revision with getMemoryEntry, then save it with updateMemoryEntry and that revision. Nothing was saved.`

/** Refusal of a read of People in a conversation with people from outside the organization (§5.16). */
export const PEOPLE_WITHHELD = `${MEMBERS_FILE}, the organization's directory of people, is not read in a conversation with people from outside the organization, or one whose audience is not known yet.`

/** Refusal of a read of People by an agent its readers leave out. */
export const PEOPLE_NOT_VISIBLE = `${MEMBERS_FILE}, the organization's directory of people, is not visible to this agent; an organization owner chooses which agents read it.`

/** Whether the Control Plane refused a read because the entry is not visible to the agent. */
export function notVisible(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'SCOPE_DENIED'
}

/** The entry, or undefined where People is withheld from this session or not visible to the agent. */
async function readable(
  record: OrganizationRecordPort,
  file: OrganizationFile,
  withOutsiders: boolean
): Promise<RecordEntry | undefined> {
  if (file === MEMBERS_FILE && withOutsiders) return undefined
  try {
    return await record.read(file)
  } catch (err) {
    if ((file === MEMBERS_FILE && notVisible(err)) || err instanceof RecordUnavailableError) return undefined
    throw err
  }
}

/** Refusal of a console change of a record name: the record lives on the Knowledge page, not the Memory page. */
export const RECORD_ON_KNOWLEDGE_PAGE = (file: string) =>
  `${file} is the organization record, kept on the Knowledge page rather than in the agent's memory. Nothing was saved.`

/** Refusal of a deletion of a record entry: it is cleared, never deleted. */
export const RECORD_NOT_DELETED = (file: string) =>
  `${file} is the organization record and is not deleted; remove the lines that are wrong with updateMemoryEntry instead. Nothing was saved.`

/** How a session sees the record: whether People is withheld, and who its writes come from. */
export interface RecordAudience {
  withOutsiders: boolean
  writerKind: KnowledgeRecordWriterKind
}

/** The text of a record entry as a memory entry holds it, or its body when it carries a frontmatter header. */
export function recordBody(text: string): string {
  return parseMemoryFrontmatter(text).body
}

/** A record entry the CP has just created: its title line and nothing else, which a create may fill as if it did not exist. */
export function titleOnly(content: string): boolean {
  const lines = content.split('\n').filter((line) => line.trim() !== '')
  return lines.length <= 1 && (lines.length === 0 || /^#\s/.test(lines[0]!))
}

/** The shared layer of an assistant-mode agent, with the three names served from the record, or hidden in the console's view; every other path is the store's. */
export class RecordBackedMemoryFs implements MemoryFs {
  readonly key: string
  readonly root: string
  readonly captureStatus: MemoryFs['captureStatus']
  readonly stageTransactionFile: MemoryFs['stageTransactionFile']
  readonly atomicTransaction: MemoryFs['atomicTransaction']
  readonly rmIfMatch: MemoryFs['rmIfMatch']

  constructor(
    private readonly inner: MemoryFs,
    readonly record: OrganizationRecordPort,
    readonly audience: RecordAudience,
    // False in the console's view: the three names are neither listed nor read, and every write of them is refused.
    readonly served = true
  ) {
    this.key = inner.key
    this.root = inner.root
    this.captureStatus = inner.captureStatus?.bind(inner)
    this.stageTransactionFile = inner.stageTransactionFile?.bind(inner)
    this.atomicTransaction = inner.atomicTransaction?.bind(inner)
    this.rmIfMatch = inner.rmIfMatch
      ? (rel, ifMatchMtime) => {
          this.refuseWrite(rel)
          return inner.rmIfMatch!(rel, ifMatchMtime)
        }
      : undefined
  }

  /** The record file a path of the shared store names, compared without case. */
  recordFile(rel: string): OrganizationFile | undefined {
    const parts = rel.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
    return parts.length === 2 && parts[0] === MEMORY_DIRNAME ? organizationFileOf(parts[1]!) : undefined
  }

  /** Whether a topic of this store is one of the record's names, kept out of the generated index. */
  readonly recordTopic = (name: string): boolean => organizationFileOf(name) !== undefined

  subdir(rel: string): MemoryFs {
    return this.inner.subdir(rel)
  }

  async readFile(rel: string, encoding?: Parameters<MemoryFs['readFile']>[1]): Promise<MemoryFsFile | null> {
    const file = this.recordFile(rel)
    if (!file) return this.inner.readFile(rel, encoding)
    if (!this.served) return null
    if (file === MEMBERS_FILE && this.audience.withOutsiders) throw new MemoryEntriesError('FORBIDDEN', PEOPLE_WITHHELD)
    const entry = await this.record.read(file).catch((err: unknown) => {
      throw file === MEMBERS_FILE && notVisible(err) ? new MemoryEntriesError('FORBIDDEN', PEOPLE_NOT_VISIBLE) : err
    })
    return { content: entry.content, size: Buffer.byteLength(entry.content), mtime: entry.updatedAt }
  }

  async readdir(rel: string): Promise<MemoryFsEntry[]> {
    const listed = await this.inner.readdir(rel)
    if (rel.replace(/\/+$/, '') !== MEMORY_DIRNAME) return listed
    // A copy an older daemon left is the record's now, so the store's own file of that name is hidden.
    const own = listed.filter((entry) => !(entry.kind === 'file' && organizationFileOf(entry.name)))
    if (!this.served) return own
    const records = await Promise.all(
      ORGANIZATION_FILES.map(async (name): Promise<MemoryFsEntry | undefined> => {
        const entry = await readable(this.record, name, this.audience.withOutsiders)
        return entry && { name, kind: 'file', size: Buffer.byteLength(entry.content), mtime: entry.updatedAt }
      })
    )
    return [...own, ...records.filter((entry): entry is MemoryFsEntry => entry !== undefined)]
  }

  async writeFile(
    rel: string,
    content: string | Uint8Array,
    options?: MemoryFsWriteOptions
  ): Promise<MemoryFsFileStat> {
    this.refuseWrite(rel)
    return this.inner.writeFile(rel, content, options)
  }

  mkdir(rel: string): Promise<void> {
    return this.inner.mkdir(rel)
  }

  async rename(from: string, to: string): Promise<boolean> {
    this.refuseWrite(from)
    this.refuseWrite(to)
    return this.inner.rename(from, to)
  }

  async rm(rel: string): Promise<void> {
    this.refuseWrite(rel)
    return this.inner.rm(rel)
  }

  utimes(rel: string, mtime: string): Promise<void> {
    return this.recordFile(rel) ? Promise.resolve() : this.inner.utimes(rel, mtime)
  }

  private refuseWrite(rel: string): void {
    const file = this.recordFile(rel)
    if (file) throw new Error(this.served ? RECORD_ENTRY_TOOLS_ONLY(file) : RECORD_ON_KNOWLEDGE_PAGE(file))
  }
}

/** The record's names, each with the one line the shared index gives it (§15.4); People is left out where it is withheld. */
export async function recordIndexLines(record: OrganizationRecordPort, withOutsiders: boolean): Promise<string[]> {
  const lines: string[] = []
  for (const file of [ORGANIZATION_FILE, CHANNELS_FILE, MEMBERS_FILE] as const) {
    const entry = await readable(record, file, withOutsiders)
    if (!entry) continue
    lines.push(`- [${RECORD_LABELS[file]}](${file}) — ${recordSummary(file, entry.content)}`)
  }
  return lines
}

const RECORD_LABELS: Record<OrganizationFile, string> = {
  'organization.md': 'About',
  'channels.md': 'Channels',
  'members.md': 'People'
}

/** About's first summary line, Channels' count of places, People's count of entries; what the empty record says. */
export function recordSummary(file: OrganizationFile, content: string): string {
  const parsed = parseOrganizationFile(file, content)
  if (file === ORGANIZATION_FILE) {
    const first = parsed.ok && parsed.parsed.file === ORGANIZATION_FILE ? parsed.parsed.facts[0] : undefined
    return first ? first.text.replace(/^\s*[-*]\s+/, '') : 'what the organization does; nothing recorded yet'
  }
  if (file === CHANNELS_FILE) {
    const count = parsed.ok && parsed.parsed.file === CHANNELS_FILE ? parsed.parsed.channels.length : 0
    return `what each place is for, ${count} ${count === 1 ? 'place' : 'places'}`
  }
  const count = parsed.ok && parsed.parsed.file === MEMBERS_FILE ? parsed.parsed.entries.length : 0
  return `who works on what, ${count} ${count === 1 ? 'person' : 'people'}`
}

/** The index a root shows its reader: the record's lines added where the root is the record-backed shared layer, none in the console's view; a record that cannot be read adds none. */
export async function indexWithRecord(fs: MemoryFs, index: string): Promise<string> {
  if (!(fs instanceof RecordBackedMemoryFs)) return index
  if (!fs.served) return withRecordIndexLines(index, [])
  const lines = await recordIndexLines(fs.record, fs.audience.withOutsiders).catch(() => undefined)
  return lines ? withRecordIndexLines(index, lines) : index
}

/** The shared index as the session reads it: the store's own lines for the record's names dropped, the record's lines added. */
export function withRecordIndexLines(index: string, lines: readonly string[]): string {
  const kept = index
    .split('\n')
    .filter((line) => !/^- \[[^\]\n]*\]\((?:organization|channels|members)\.md\)/i.test(line))
    .join('\n')
    .replace(/\n+$/, '')
  return lines.length ? `${kept}${kept ? '\n' : ''}${lines.join('\n')}\n` : `${kept}\n`
}
