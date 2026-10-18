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
  personMemoryRoot,
  writeChannelMemoryMeta,
  placeLayerMeta,
  restorePlaceIdentity,
  MEMORY_INDEX,
  type MemoryFile,
  type MemoryFs,
  type MemoryHistorySink,
  type MemoryWriteSource
} from '../store.js'
import { sidecarMemoryHistory, type MemoryHomePorts } from '../home.js'
import { buildDistillationPrompt } from '../distill.js'
import { memoryRefToTopic } from '../frontmatter.js'
import type { MemoryTextCheck } from '../organization-files.js'
import { indexWithRecord, RecordBackedMemoryFs, type OrganizationRecordPort } from '../organization-record.js'
import type {
  FileMemoryAdmin,
  MemoryExtractor,
  MemoryProvider,
  MemoryRecord,
  MemoryNeighborsResult,
  MemoryReadResult,
  MemoryScope,
  MemoryWriteGuard,
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
    private readonly extract?: MemoryExtractor,
    // The organization record for an assistant-mode agent whose Control Plane keeps it; undefined keeps the three names in the shared store.
    private readonly organizationRecordFor: (agentId: string) => OrganizationRecordPort | undefined = () => undefined
  ) {}

  private portsFor(agentId: string): MemoryHomePorts {
    const ports = this.memoryHomePortsFor(agentId)
    // Match the pre-provider MCP path's message verbatim (mcp/ops.ts) so the tool error surface is byte-identical.
    if (!ports) throw new Error(`unknown agent ${agentId}`)
    return ports
  }

  // Where writes land, the root a read overlays beneath it, and the shared store; a dream's staged store stands alone.
  private layers(scope: MemoryScope): {
    active: MemoryFs
    under?: MemoryFs
    base: MemoryFs
    history: MemoryHistorySink
  } {
    if (scope.root) return { active: scope.root, base: scope.root, history: sidecarMemoryHistory(scope.root) }
    if (scope.channelKey && scope.personKey) throw new Error('a memory scope names one layer beside the shared store')
    const ports = this.portsFor(scope.agentId)
    const record = this.organizationRecordFor(scope.agentId)
    const base = record
      ? new RecordBackedMemoryFs(
          ports.live,
          record,
          { withOutsiders: scope.withOutsiders ?? true, writerKind: scope.recordWriter ?? 'conversation' },
          !scope.withoutRecord
        )
      : ports.live
    const own = scope.channelKey
      ? channelMemoryRoot(base, scope.channelKey)
      : scope.personKey
        ? personMemoryRoot(base, scope.personKey)
        : undefined
    // A shared place's older folder is read beneath the shared store, which takes its writes.
    const active = own && !scope.sharedPlace ? own : base
    const under = scope.alone ? undefined : active === base ? own : base
    return { active, ...(under ? { under } : {}), base, history: ports.historyFor(active) }
  }

  // The store every WRITE (tools + distillation) targets and the sink its change log goes to.
  private activeStore(scope: MemoryScope): { store: MemoryFs; history: MemoryHistorySink } {
    const { active, history } = this.layers(scope)
    return { store: active, history }
  }

  // The read overlay roots, most-specific first: the written layer shadows the one beneath it per file.
  private readRoots(scope: MemoryScope): MemoryFs[] {
    const { active, under } = this.layers(scope)
    return under ? [active, under] : [active]
  }

  // Managed keeps a single store: turn OFF any verified runtime-owned memory so
  // the agent doesn't end up with two competing stores. Unknown harnesses retain
  // managed support; adding a real native-memory feature requires a registry entry.
  runtimeEnv(runtime: RuntimeDef, effectiveEnv: NodeJS.ProcessEnv = {}, runtimeId?: string): Record<string, string> {
    return disabledRuntimeMemoryEnv(runtime, effectiveEnv, runtimeId)
  }

  entryView(scope: MemoryScope, writeSource?: MemoryWriteSource, check?: MemoryTextCheck, guard?: MemoryWriteGuard) {
    // A staged draft logs to the sidecar inside it; a live root pages the home's own change log.
    const historyFor = (root: MemoryFs) =>
      scope.root ? sidecarMemoryHistory(root) : this.portsFor(scope.agentId).historyFor(root)
    return managedMemoryEntries(
      this.readRoots(scope),
      scope.agentId,
      writeSource
        ? {
            source: writeSource,
            sourceTurnId: scope.sourceTurnId,
            ...(check ? { check } : {}),
            ...(guard ? { guard } : {})
          }
        : undefined,
      historyFor,
      () => this.landed(scope)
    )
  }

  // The write boundary every write into a place layer passes, a pinned distillation's included: a layer a clear emptied gets its identity back.
  private async landed(scope: MemoryScope): Promise<void> {
    const place = placeLayerMeta(scope)
    if (place) await restorePlaceIdentity(this.portsFor(scope.agentId).live, place)
  }

  async ensure(scope: MemoryScope, agentName: string): Promise<void> {
    // Only the shared store is seeded; a layer beside it starts with its first write.
    await ensureMemory(this.layers(scope).base, agentName)
    // Record who a place layer belongs to, so the console can name it; best-effort, never blocking.
    const place = placeLayerMeta(scope)
    if (place) void writeChannelMemoryMeta(this.portsFor(scope.agentId).live, place.channelKey, place).catch(() => {})
  }

  async standingContextAtSessionStart(scope: MemoryScope): Promise<string> {
    // The shared index first, then the other layer's, so the agent sees one memory.
    const { active, under, base } = this.layers(scope)
    const roots = under ? [active, under] : [active]
    const label = scope.personKey
      ? 'Only for this person:'
      : scope.channelKey
        ? 'Only for this conversation:'
        : undefined
    const parts: string[] = []
    for (const root of [...roots.filter((r) => r === base), ...roots.filter((r) => r !== base)]) {
      const index = (await indexWithRecord(root, await readIndex(root))).trim()
      if (index) parts.push(root !== base && label ? `${label}\n${index}` : index)
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
    // Per-turn distillation is a WRITE: it goes to the scope's layer, never into another conversation's.
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
    // Union of both layers, the written one shadowing the other by name, MEMORY.md first.
    const byName = new Map<string, MemoryFile>()
    for (const root of [...roots].reverse()) {
      for (const file of await listMemory(root)) {
        // Each layer keeps its own index, so the written layer's is the only one listed.
        if (file.name !== MEMORY_INDEX || root === roots[0]) byName.set(file.name, file)
        else byName.delete(file.name)
      }
    }
    return [...byName.values()].sort((a, b) =>
      a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)
    )
  }

  async read(scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    // The written layer shadows the other: the first root that HAS the file wins, even an intentionally empty one.
    const roots = this.readRoots(scope)
    // Each layer keeps its own index, so MEMORY.md never falls through to the layer beneath.
    const index = memoryRefToTopic(path) === MEMORY_INDEX
    for (const root of index ? roots.slice(0, 1) : roots) {
      const content = await readMemoryFileIfPresent(root, path)
      if (content !== null) return { path, content: index ? await indexWithRecord(root, content) : content }
    }
    return { path, content: '' }
  }

  /** One hop of the `[[name]]` graph, from the layer that actually holds the file, the other layer as fallback. */
  async neighbors(scope: MemoryScope, path: string): Promise<MemoryNeighborsResult> {
    // The whole overlay: an edge may cross layers, and scanning one layer could describe a shadowed file.
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
    await this.landed(scope)
    return { ok: true, path, size, mtime }
  }
}
