import { memorySourceTurnId } from '../source-turn.js'
import { managedMemoryEntries } from '../entries/managed.js'
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
  type MemoryHistorySink,
  type MemoryWriteSource
} from '../store.js'
import { sidecarMemoryHistory, type MemoryHomePorts } from '../home.js'
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

// `managed` memory: our `<root>/memory/` directory. A thin facade over `memory/store.ts` — every method delegates to the
// existing primitive and lets its error classes (`MemoryPathError` / `MemoryTooLargeError` / `MemoryConflictError`)
// propagate raw, so the MCP + CP error mappings are unchanged. Where the tree IS (this disk, a sandbox volume, the
// Control Plane) is the home's answer: it hands back the ports and may refuse with `MemoryHomeUnavailableError`.
export class ManagedMemoryProvider implements MemoryProvider {
  readonly kind = 'managed' as const

  /** `memoryHomePortsFor` resolves an agent id → the ports over its memory home, or undefined for an unknown agent. */
  constructor(
    private readonly memoryHomePortsFor: (agentId: string) => MemoryHomePorts | undefined,
    private readonly autoDistillFor: (agentId: string) => boolean = () => false,
    private readonly extract?: MemoryExtractor
  ) {}

  private portsFor(agentId: string): MemoryHomePorts {
    const ports = this.memoryHomePortsFor(agentId)
    // Match the pre-provider MCP path's message verbatim (mcp/ops.ts) so the tool error surface is byte-identical.
    if (!ports) throw new Error(`unknown agent ${agentId}`)
    return ports
  }

  // The store every WRITE (tools + distillation) targets — the channel folder when channel-scoped, else the agent base,
  // so a channel's content never lands in another channel or the shared base (#653) — and the sink its change log goes
  // to. An explicit store is a dream's staging, kept beside the extraction host and never in the CP, so it logs to the
  // sidecar inside it; otherwise the home decides both.
  private activeStore(scope: MemoryScope): { store: MemoryFs; history: MemoryHistorySink } {
    if (scope.root) return { store: scope.root, history: sidecarMemoryHistory(scope.root) }
    const ports = this.portsFor(scope.agentId)
    const store = scope.channelKey ? channelMemoryRoot(ports.live, scope.channelKey) : ports.live
    return { store, history: ports.historyFor(store) }
  }

  // The read overlay roots, most-specific first — `[channel, base]` when channel-scoped so the channel layer shadows the
  // shared base per file; `[base]` otherwise. An explicit store stands alone: a dream's staged proposal must not read
  // through to the live store, or a reviewer would see files the proposal does not contain.
  private readRoots(scope: MemoryScope): MemoryFs[] {
    if (scope.root) return [scope.root]
    const base = this.portsFor(scope.agentId).live
    return scope.channelKey ? [channelMemoryRoot(base, scope.channelKey), base] : [base]
  }

  // Managed keeps a single store: turn OFF any verified runtime-owned memory so
  // the agent doesn't end up with two competing stores. Unknown harnesses retain
  // managed support; adding a real native-memory feature requires a registry entry.
  runtimeEnv(runtime: RuntimeDef, effectiveEnv: NodeJS.ProcessEnv = {}, runtimeId?: string): Record<string, string> {
    return disabledRuntimeMemoryEnv(runtime, effectiveEnv, runtimeId)
  }

  entryView(scope: MemoryScope, writeSource?: MemoryWriteSource) {
    return managedMemoryEntries(
      this.readRoots(scope),
      scope.agentId,
      writeSource ? { source: writeSource, sourceTurnId: scope.sourceTurnId } : undefined
    )
  }

  async ensure(scope: MemoryScope, agentName: string): Promise<void> {
    await ensureMemory(this.activeStore(scope).store, agentName)
    // Record the source identity of a channel folder once, so the console can name
    // it. Best-effort and off the critical path — a failure never blocks memory.
    if (scope.channelKey && scope.channel) {
      void writeChannelMemoryMeta(this.portsFor(scope.agentId).live, scope.channelKey, {
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
    const { store } = this.activeStore(scope)
    // The extraction session holds the same memory tools as any other trigger and
    // writes through them itself (#41), so there is nothing to parse or apply here.
    // Its text answer is not the product; the writes are.
    const sourceTurnId = turn.turnId ? memorySourceTurnId(scope.agentId, turn.turnId) : undefined
    if (sourceTurnId && store.captureStatus && (await store.captureStatus('memory', sourceTurnId)).suppressed) return
    await this.extract(scope.agentId, await buildDistillationPrompt(store, turn), { ...scope, sourceTurnId })
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
      // Pages the store's sink; a home whose sink has no `list` (the CP's) answers the console itself, and a page asked here refuses.
      history: (scope, req) => listMemoryHistory(this.activeStore(scope).history, req.path, req.cursor, req.limit)
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
    const { store, history } = this.activeStore(scope)
    const { size, mtime } = await writeMemoryFile(
      store,
      path,
      content,
      ifMatch,
      source ?? 'tool',
      history,
      scope.sourceTurnId
    )
    return { ok: true, path, size, mtime }
  }
}
