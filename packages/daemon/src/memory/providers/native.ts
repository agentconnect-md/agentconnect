import type { MemoryEntry } from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../../config/config-schema.js'
import type { ToolDescriptor } from '../../mcp/tool-descriptor.js'
import type { MemoryWriteSource } from '../store.js'
import { nativeMemoryList, nativeMemoryRead, nativeMemoryWrite } from '../runtime/native.js'
import type {
  FileMemoryAdmin,
  MemoryProvider,
  MemoryRecord,
  MemoryReadResult,
  MemoryScope,
  MemoryWriteResult,
  RecallPolicy
} from '../types.js'

/**
 * `native` memory: the runtime's OWN memory (Claude auto-memory / Codex memories),
 * redirected under the agent root via `runtimeEnv` for per-agent isolation. The
 * runtime writes and loads it itself, so we do NOT seed, inject, or expose tools —
 * doing so would create a second store the runtime never reads. `list`/`read`/`write`
 * surface the runtime's memory files for the console (see native-memory.ts).
 *
 * The per-runtime env levers are an explicit registry (native-memory.ts). An agent
 * selecting `native` on a runtime whose levers aren't registered fails loudly at
 * construction rather than silently mis-setting env — we don't guess env for a
 * runtime we haven't verified.
 */
export class NativeMemoryProvider implements MemoryProvider {
  readonly kind = 'native' as const

  constructor(
    private readonly agentDirByAgent: (agentId: string) => string | undefined,
    private readonly runtimeFor: (agentId: string) => RuntimeDef | undefined
  ) {}

  private dirFor(agentId: string): string {
    const dir = this.agentDirByAgent(agentId)
    if (!dir) throw new Error(`unknown agent ${agentId}`)
    return dir
  }

  runtimeEnv(_runtime: RuntimeDef): Record<string, string> {
    // Not the live path: the spawn env is sourced via memoryProviderFor (which binds
    // the agent root). Routing it through the dispatcher/interface here would lack
    // the root, so make the misuse obvious.
    throw new Error('NativeMemoryProvider.runtimeEnv must not be called — use memoryProviderFor at spawn')
  }

  async ensure(): Promise<void> {
    // The runtime manages its own memory — nothing to seed.
  }

  async standingContextAtSessionStart(): Promise<string> {
    // The runtime loads its own memory; don't double-inject.
    return ''
  }

  async recallForTurn(): Promise<MemoryRecord[]> {
    return []
  }

  recallPolicy(): RecallPolicy {
    return { mode: 'auto', topK: 5, maxBytes: 8 * 1024, timeoutMs: 1_000 }
  }

  async recordTurn(): Promise<void> {
    // no per-turn distillation.
  }

  tools(): ToolDescriptor[] {
    // The runtime has its own memory mechanism; our tools would target a different
    // store than it reads. Expose none.
    return []
  }

  toolsForAgent(): ToolDescriptor[] {
    return []
  }

  adminSurface(): FileMemoryAdmin {
    return {
      shape: 'files',
      list: (scope) => this.list(scope),
      read: (scope, path) => this.read(scope, path),
      write: (scope, path, content, ifMatch, source) => this.write(scope, path, content, ifMatch, source)
    }
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return nativeMemoryList(this.dirFor(scope.agentId), this.runtimeFor(scope.agentId))
  }

  async read(scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    return nativeMemoryRead(this.dirFor(scope.agentId), this.runtimeFor(scope.agentId), path)
  }

  async write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    _source?: MemoryWriteSource
  ): Promise<MemoryWriteResult> {
    // native writes go to the runtime's own store — no managed `.history` log there.
    return nativeMemoryWrite(this.dirFor(scope.agentId), this.runtimeFor(scope.agentId), path, content, ifMatch)
  }
}
