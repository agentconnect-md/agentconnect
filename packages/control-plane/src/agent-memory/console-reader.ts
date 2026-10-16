// A Control-Plane home's console reads and place clear from the CP's tables, laid out as the managed provider writes them (memory-evolution.md §3.2.1).
import {
  MEMORY_INDEX,
  fitToBudget,
  memoryPersonKey,
  utf8Boundary,
  type MemoryChannelEntry,
  type MemoryEntry,
  type MemoryReadContent,
  type MemoryReadReq
} from '@agentconnect.md/protocol'
import type { AgentId } from '../domain/ids.js'
import type { AgentMemoryFileEntry, AgentMemoryFileRepo, AgentMemoryHistoryRepo } from '../persistence/ports.js'
import { memoryHistoryRoot } from './history.js'
import { MemoryStorePathError, memoryPathSegments } from './paths.js'

/** The layer a console request names: the shared store, one place's, or the signed-in caller's own. */
export interface MemoryConsoleLayer {
  channelKey?: string
  personUserId?: string
}

const PLACE_META = 'channel.json'
const MAX_PLACE_META_BYTES = 64 * 1024
const MAX_PLACE_META_NAME = 200

/** A layer folder name the daemon accepts: one plain segment. */
const isLayerKey = (key: string): boolean => key !== '.' && key !== '..' && /^[A-Za-z0-9._-]{1,120}$/.test(key)

/** A row the daemon's listing shows: a published file directly in the store, never a dotfile or a write's temp. */
const listed = (name: string, row: AgentMemoryFileEntry): boolean =>
  !row.staged && !name.startsWith('.') && !name.endsWith('.tmp')

const storeDir = (root: string): string => (root === '' ? 'memory' : `${root}/memory`)

const indexFirst = (a: MemoryEntry, b: MemoryEntry): number =>
  a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)

const metaString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_PLACE_META_NAME) : undefined

/** A listed file and the row that holds it. */
type StoredEntry = MemoryEntry & { row: string }

export class AgentMemoryConsoleReader {
  constructor(
    private readonly files: Pick<AgentMemoryFileRepo, 'listUnder' | 'read' | 'rmExcept'>,
    private readonly history: Pick<AgentMemoryHistoryRepo, 'deleteRoot'>
  ) {}

  /** The place layers that hold memory, each named by its `channel.json`; `channelKey` asks for that one alone. */
  async channels(agentId: AgentId, channelKey?: string): Promise<MemoryChannelEntry[]> {
    if (channelKey !== undefined && !isLayerKey(channelKey)) return []
    const held = new Set<string>()
    for (const row of await this.files.listUnder(agentId, channelKey ? `channels/${channelKey}` : 'channels')) {
      const [, key, store, name, ...deeper] = row.path.split('/')
      if (key && isLayerKey(key) && store === 'memory' && name && deeper.length === 0 && listed(name, row))
        held.add(key)
    }
    const channels: MemoryChannelEntry[] = []
    for (const key of [...held].sort()) channels.push({ channelKey: key, ...(await this.placeMeta(agentId, key)) })
    return channels
  }

  /** The layer's files, a place layer over the shared store beneath it as the daemon lists them. */
  async list(agentId: AgentId, layer: MemoryConsoleLayer): Promise<MemoryEntry[]> {
    return (await this.overlay(agentId, layer)).map(({ name, size, mtime }) => ({ name, size, mtime }))
  }

  /** One byte slice of a listed file, cut as the daemon cuts it; an unlisted name is `exists: false`. */
  async read(agentId: AgentId, req: MemoryConsoleLayer & Omit<MemoryReadReq, 'agentId'>): Promise<MemoryReadContent> {
    const segments = memoryPathSegments(req.path)
    if (segments.length === 0) throw new MemoryStorePathError('a file name is required')
    if (segments.length > 1) throw new MemoryStorePathError('memory is a flat directory (no subdirectories)')
    const absent = { agentId, path: req.path, exists: false }
    const entry = (await this.overlay(agentId, req)).find((file) => file.name === req.path)
    if (!entry) return absent
    const file = await this.files.read(agentId, entry.row, req.offset, req.limit)
    if (!file) return absent
    const slice = Buffer.from(file.slice)
    const { end, content } = fitToBudget(slice, utf8Boundary(slice, slice.length))
    const nextOffset = req.offset + end
    return {
      agentId,
      path: req.path,
      exists: true,
      size: file.size,
      mtime: file.mtime.toISOString(),
      content,
      offset: req.offset,
      nextOffset,
      truncated: nextOffset < file.size
    }
  }

  /** Delete a place layer's memory and change log; its `channel.json` stays, so a daemon that named it keeps writing a named layer. */
  async clearPlace(agentId: AgentId, channelKey: string): Promise<boolean> {
    if (!isLayerKey(channelKey)) return false
    const folder = `channels/${channelKey}`
    const cleared = await this.files.rmExcept(agentId, folder, `${folder}/${PLACE_META}`)
    await this.history.deleteRoot(agentId, memoryHistoryRoot(channelKey))
    return cleared
  }

  // The roots a read overlays, most specific first: a person's layer alone, a place's over the shared store.
  private roots(layer: MemoryConsoleLayer): string[] {
    if (layer.personUserId) return [`people/${memoryPersonKey(`user:${layer.personUserId}`)}`]
    if (layer.channelKey) return [`channels/${layer.channelKey}`, '']
    return ['']
  }

  // The written layer shadows the one beneath it by name, and each keeps its own index.
  private async overlay(agentId: AgentId, layer: MemoryConsoleLayer): Promise<StoredEntry[]> {
    const roots = this.roots(layer)
    const byName = new Map<string, StoredEntry>()
    for (const root of [...roots].reverse()) {
      for (const file of await this.store(agentId, root)) {
        if (file.name !== MEMORY_INDEX || root === roots[0]) byName.set(file.name, file)
        else byName.delete(file.name)
      }
    }
    return [...byName.values()].sort(indexFirst)
  }

  private async store(agentId: AgentId, root: string): Promise<StoredEntry[]> {
    const dir = storeDir(root)
    const entries: StoredEntry[] = []
    for (const row of await this.files.listUnder(agentId, dir)) {
      const name = row.path.slice(dir.length + 1)
      if (name.includes('/') || !listed(name, row)) continue
      entries.push({ name, size: row.size, mtime: row.mtime.toISOString(), row: row.path })
    }
    return entries
  }

  private async placeMeta(agentId: AgentId, key: string): Promise<Omit<MemoryChannelEntry, 'channelKey'>> {
    const file = await this.files.read(agentId, `channels/${key}/${PLACE_META}`, 0, MAX_PLACE_META_BYTES)
    if (!file) return {}
    try {
      const parsed = JSON.parse(Buffer.from(file.slice).toString('utf8')) as Record<string, unknown> | null
      if (!parsed || typeof parsed.channel !== 'string') return {}
      const transportScope = metaString(parsed.transportScope)
      const platform = metaString(parsed.platform)
      const name = metaString(parsed.name)
      return {
        channel: parsed.channel,
        ...(transportScope ? { transportScope } : {}),
        ...(platform ? { platform } : {}),
        ...(name ? { name } : {})
      }
    } catch {
      // Malformed: a layer whose conversation is unknown, as the daemon reads it.
      return {}
    }
  }
}
