import type { MemoryEntry } from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../../config/config-schema.js'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'
import { MEMORY_TOOLS } from '../tools.js'
import {
  ensureMemory,
  readIndex,
  memoryNeighbors,
  readMemoryFileIfPresent,
  writeMemoryFile,
  listMemory,
  listMemoryHistory,
  channelMemoryRoot,
  writeChannelMemoryMeta,
  MEMORY_INDEX,
  type MemoryFile,
  type MemoryFs,
  type MemoryWriteSource
} from '../store.js'
import { buildDistillationPrompt } from '../distill.js'
import type {
  FileMemoryAdmin,
  MemoryExtractor,
  MemoryProvider,
  MemoryRecord,
  MemoryNeighborsResult,
  MemoryReadResult,
  MemoryScope,
  MemoryWriteResult,
  RecallPolicy,
  TurnRecord
} from '../types.js'
import { disabledRuntimeMemoryEnv } from './runtime-env.js'

/**
 * `managed` memory: our `<root>/memory/` directory. A thin facade over
 * `memory/store.ts` — every method delegates to the existing primitive and lets
 * its error classes (`MemoryPathError` / `MemoryTooLargeError` /
 * `MemoryConflictError`) propagate raw, so the MCP + CP error mappings are unchanged.
 * Where the tree IS (this disk, a sandbox volume) is the factory's answer: it hands
 * back the port and may refuse with `MemorySandboxUnavailableError`.
 */
export class ManagedMemoryProvider implements MemoryProvider {
  readonly kind = 'managed' as const

  /** `memoryFsFor` resolves an agent id → the port over its memory tree (holds
   *  `memory/`), or undefined for an unknown agent. */
  constructor(
    private readonly memoryFsFor: (agentId: string) => MemoryFs | undefined,
    private readonly autoDistillFor: (agentId: string) => boolean = () => false,
    private readonly extract?: MemoryExtractor
  ) {}

  private rootFor(agentId: string): MemoryFs {
    const fs = this.memoryFsFor(agentId)
    // Match the pre-provider MCP path's message verbatim (mcp/ops.ts) so the tool
    // error surface is byte-identical.
    if (!fs) throw new Error(`unknown agent ${agentId}`)
    return fs
  }

  /** The write/active memory root: the channel folder when channel-scoped, else the
   *  agent base. All WRITES (tools + distillation) target this so a channel's
   *  content never lands in another channel or the shared base (#653). */
  private activeRoot(scope: MemoryScope): MemoryFs {
    const base = this.rootFor(scope.agentId)
    return scope.channelKey ? channelMemoryRoot(base, scope.channelKey) : base
  }

  /** The read overlay roots, most-specific first — `[channel, base]` when channel-
   *  scoped so the channel layer shadows the shared base per file; `[base]`
   *  otherwise. */
  private readRoots(scope: MemoryScope): MemoryFs[] {
    const base = this.rootFor(scope.agentId)
    return scope.channelKey ? [channelMemoryRoot(base, scope.channelKey), base] : [base]
  }

  // Managed keeps a single store: turn OFF any verified runtime-owned memory so
  // the agent doesn't end up with two competing stores. Unknown harnesses retain
  // managed support; adding a real native-memory feature requires a registry entry.
  runtimeEnv(runtime: RuntimeDef, effectiveEnv: NodeJS.ProcessEnv = {}, runtimeId?: string): Record<string, string> {
    return disabledRuntimeMemoryEnv(runtime, effectiveEnv, runtimeId)
  }

  async ensure(scope: MemoryScope, agentName: string): Promise<void> {
    await ensureMemory(this.activeRoot(scope), agentName)
    // Record the source identity of a channel folder once, so the console can name
    // it. Best-effort and off the critical path — a failure never blocks memory.
    if (scope.channelKey && scope.channel) {
      void writeChannelMemoryMeta(this.rootFor(scope.agentId), scope.channelKey, {
        channel: scope.channel,
        ...(scope.transportScope ? { transportScope: scope.transportScope } : {})
      }).catch(() => {})
    }
  }

  async standingContextAtSessionStart(scope: MemoryScope): Promise<string> {
    // Overlay: inject the shared base index first, then the channel index, so the
    // agent sees "shared knowledge + this channel" as one memory (#653).
    const ordered = [...this.readRoots(scope)].reverse() // [base] or [base, channel]
    const parts: string[] = []
    for (const root of ordered) {
      const index = (await readIndex(root)).trim()
      if (index) parts.push(index)
    }
    return parts.join('\n\n')
  }

  async recallForTurn(): Promise<MemoryRecord[]> {
    return []
  }

  recallPolicy(): RecallPolicy {
    return { mode: 'auto', topK: 5, maxBytes: 8 * 1024, timeoutMs: 1_000 }
  }

  async recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<void> {
    if (!this.autoDistillFor(scope.agentId) || !this.extract) return
    // Per-turn distillation is a WRITE: it goes to the active (channel) folder so a
    // channel's turns never distill into the shared base or another channel (#653).
    const dir = this.activeRoot(scope)
    // The extraction session holds the same memory tools as any other trigger and
    // writes through them itself (#41), so there is nothing to parse or apply here.
    // Its text answer is not the product; the writes are.
    await this.extract(scope.agentId, await buildDistillationPrompt(dir, turn), scope)
  }

  tools(): ToolDescriptor[] {
    return MEMORY_TOOLS
  }

  toolsForAgent(): ToolDescriptor[] {
    return MEMORY_TOOLS
  }

  adminSurface(): FileMemoryAdmin {
    return {
      shape: 'files',
      list: (scope) => this.list(scope),
      read: (scope, path) => this.read(scope, path),
      write: (scope, path, content, ifMatch, source) => this.write(scope, path, content, ifMatch, source),
      history: (scope, req) => listMemoryHistory(this.activeRoot(scope), req.path, req.cursor, req.limit)
    }
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    const roots = this.readRoots(scope)
    if (roots.length === 1) return listMemory(roots[0]!)
    // Union base + channel, channel shadowing the base by name, MEMORY.md first.
    const byName = new Map<string, MemoryFile>()
    for (const root of [...roots].reverse()) {
      for (const file of await listMemory(root)) byName.set(file.name, file)
    }
    return [...byName.values()].sort((a, b) =>
      a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)
    )
  }

  async read(scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    // Channel layer shadows the base: return the first root that HAS the file.
    // Existence (not emptiness) decides — an intentionally-empty channel file must
    // still shadow a non-empty base file rather than fall through.
    for (const root of this.readRoots(scope)) {
      const content = await readMemoryFileIfPresent(root, path)
      if (content !== null) return { path, content }
    }
    return { path, content: '' }
  }

  /** One hop of the `[[name]]` graph, from the layer that actually holds the file:
   *  under channel scope that is the channel folder, with the shared base as fallback. */
  async neighbors(scope: MemoryScope, path: string): Promise<MemoryNeighborsResult> {
    // Pass the whole overlay: an edge may cross layers (a channel memory linking to a
    // shared base one, or vice versa), so scanning only the file's own layer would
    // drop those edges and could describe a shadowed file instead of the live one.
    return memoryNeighbors(this.readRoots(scope), path)
  }

  async write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    source?: MemoryWriteSource
  ): Promise<MemoryWriteResult> {
    const { size, mtime } = await writeMemoryFile(this.activeRoot(scope), path, content, ifMatch, source)
    return { ok: true, path, size, mtime }
  }
}
