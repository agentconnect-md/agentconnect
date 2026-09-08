// The memory-fs op set over the `agent_memory_file` table (memory-evolution.md §3.2.1), one repository transaction per op.
// Observably the pod executor, except that directories are implicit: `mkdir` writes nothing and an empty one does not exist.
import {
  fitToBudget,
  utf8Boundary,
  type MemoryFsReaddirReply,
  type MemoryFsPayload,
  type MemoryFsReadReply,
  type MemoryFsReply
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import type { AgentId, OrgId } from '../domain/ids.js'
import type { AgentMemoryFileRepo } from '../persistence/ports.js'
import { MAX_MEMORY_FILE_BYTES } from './limits.js'
import {
  MemoryStoreConflictError,
  MemoryStorePathError,
  MemoryStoreTooLargeError,
  memoryStoreLeafPath,
  memoryStoreParent,
  memoryStorePath
} from './paths.js'

/** The two coordinates every op is resolved against; the handler proved them, the service never re-reads them. */
export interface MemoryStoreAgent {
  id: AgentId
  orgId: OrgId
}

export class AgentMemoryStoreService {
  constructor(
    private readonly files: AgentMemoryFileRepo,
    private readonly clock: Clock
  ) {}

  /** Run one op; the two typed refusals ride as data, anything else is the caller's error REP. */
  async apply(agent: MemoryStoreAgent, op: MemoryFsPayload): Promise<MemoryFsReply> {
    try {
      return { ok: true, value: await this.run(agent, op) }
    } catch (err) {
      if (err instanceof MemoryStorePathError) return { ok: false, refusal: { kind: 'path', message: err.message } }
      if (err instanceof MemoryStoreConflictError) {
        return { ok: false, refusal: { kind: 'conflict', message: err.message } }
      }
      throw err
    }
  }

  private run(agent: MemoryStoreAgent, op: MemoryFsPayload): Promise<unknown> {
    switch (op.op) {
      case 'memory-read':
        return this.read(agent, memoryStoreLeafPath(op.root, op.rel), op.offset, op.limit, op.encoding ?? 'utf8')
      case 'memory-append':
        return this.append(agent, memoryStoreLeafPath(op.root, op.rel), op.content, op.encoding ?? 'utf8', op.create)
      case 'memory-commit':
        return this.commit(
          agent,
          memoryStoreLeafPath(op.root, op.rel),
          memoryStoreLeafPath(op.root, op.temp),
          op.ifMatchMtime
        )
      case 'memory-stat':
        return this.files.stat(agent.id, memoryStorePath(op.root, op.rel))
      case 'memory-readdir':
        return this.readdir(agent, memoryStorePath(op.root, op.rel))
      case 'memory-mkdir':
        memoryStorePath(op.root, op.rel) // containment is the only thing a directory has
        return Promise.resolve(null)
      case 'memory-rmdir':
        return this.files.rmdir(agent.id, memoryStoreLeafPath(op.root, op.rel))
      case 'memory-rename':
        return this.rename(agent, memoryStoreLeafPath(op.root, op.from), memoryStoreLeafPath(op.root, op.to))
      case 'memory-rm':
        return this.files.rm(agent.id, memoryStoreLeafPath(op.root, op.rel)).then(() => null)
      case 'memory-utimes':
        return this.utimes(agent, memoryStoreLeafPath(op.root, op.rel), op.mtime)
    }
  }

  private async read(
    agent: MemoryStoreAgent,
    path: string,
    offset: number,
    limit: number,
    encoding: 'utf8' | 'base64'
  ): Promise<MemoryFsReadReply> {
    const row = await this.files.read(agent.id, path, offset, limit)
    if (!row) return { exists: false }
    const slice = Buffer.from(row.slice)
    const { end, content } =
      encoding === 'base64'
        ? { end: slice.length, content: slice.toString('base64') }
        : fitToBudget(slice, utf8Boundary(slice, slice.length))
    return { exists: true, size: row.size, mtime: row.mtime.toISOString(), content, nextOffset: offset + end }
  }

  private async append(
    agent: MemoryStoreAgent,
    path: string,
    content: string,
    encoding: 'utf8' | 'base64',
    create: boolean
  ): Promise<{ size: number }> {
    const chunk = Buffer.from(content, encoding)
    const outcome = await this.files.append(agent.id, agent.orgId, path, chunk, create, new Date(this.clock.now()))
    if (outcome.ok) return { size: outcome.size }
    if (outcome.reason === 'too-large') {
      throw new MemoryStoreTooLargeError(`memory file exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
    }
    throw new MemoryStorePathError(
      outcome.reason === 'exists' ? 'memory staging file already exists' : 'memory staging file is missing'
    )
  }

  private async commit(
    agent: MemoryStoreAgent,
    path: string,
    temp: string,
    ifMatchMtime: string | undefined
  ): Promise<{ size: number; mtime: string }> {
    // The temp is staged beside its target, the way the pod executor holds one parent handle for both.
    if (memoryStoreParent(temp) !== memoryStoreParent(path)) {
      throw new MemoryStorePathError('memory staging file must sit beside its target')
    }
    const outcome = await this.files.commit(agent.id, path, temp, ifMatchMtime, new Date(this.clock.now()))
    if (outcome.ok) return { size: outcome.size, mtime: outcome.mtime.toISOString() }
    if (outcome.reason === 'conflict') {
      throw new MemoryStoreConflictError('the memory file changed since it was read; reload and retry')
    }
    throw new MemoryStorePathError(
      outcome.reason === 'temp-missing' ? 'memory staging file is missing' : 'memory target is not a regular file'
    )
  }

  /** The immediate children of `path`: file rows by name, and the first segment of every deeper row as a directory. */
  private async readdir(agent: MemoryStoreAgent, path: string): Promise<MemoryFsReaddirReply> {
    const prefix = path === '' ? '' : `${path}/`
    const entries = new Map<string, MemoryFsReaddirReply[number]>()
    for (const row of await this.files.listUnder(agent.id, path)) {
      const rest = row.path.slice(prefix.length)
      const cut = rest.indexOf('/')
      if (cut < 0) entries.set(rest, { name: rest, kind: 'file', size: row.size, mtime: row.mtime.toISOString() })
      else if (!entries.has(rest.slice(0, cut)))
        entries.set(rest.slice(0, cut), { name: rest.slice(0, cut), kind: 'dir' })
    }
    return [...entries.values()]
  }

  private async rename(agent: MemoryStoreAgent, from: string, to: string): Promise<boolean> {
    const outcome = await this.files.rename(agent.id, from, to)
    if (outcome === 'occupied') throw new MemoryStorePathError('rename target is not empty')
    return outcome === 'moved'
  }

  private async utimes(agent: MemoryStoreAgent, path: string, mtime: string): Promise<null> {
    const when = new Date(mtime)
    if (Number.isNaN(when.getTime())) throw new MemoryStorePathError('mtime is not a timestamp')
    await this.files.utimes(agent.id, path, when)
    return null
  }
}
