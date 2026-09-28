import type { MemoryEntry } from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../../config/config-schema.js'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'
import {
  MemoryProviderUnavailableError,
  type MemoryProvider,
  type MemoryRecord,
  type MemoryReadResult,
  type MemoryScope,
  type MemoryWriteResult,
  type RecallPolicy
} from '../types.js'

/** `native`: the runtime keeps its own memory where it already keeps its state, so the daemon adds no store, tools, or console surface. */
export class NativeMemoryProvider implements MemoryProvider {
  readonly kind = 'native' as const

  runtimeEnv(_runtime: RuntimeDef): Record<string, string> {
    throw new Error('NativeMemoryProvider.runtimeEnv must not be called — use memoryProviderFor at spawn')
  }

  async ensure(): Promise<void> {}

  async standingContextAtSessionStart(): Promise<string> {
    return ''
  }

  async recallForTurn(): Promise<MemoryRecord[]> {
    return []
  }

  recallPolicy(): RecallPolicy {
    return { mode: 'auto', topK: 5, maxBytes: 8 * 1024, timeoutMs: 1_000 }
  }

  async recordTurn(): Promise<void> {}

  tools(): ToolDescriptor[] {
    return []
  }

  toolsForAgent(): ToolDescriptor[] {
    return []
  }

  adminSurface(): null {
    return null
  }

  async list(): Promise<MemoryEntry[]> {
    return []
  }

  async read(_scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    throw new MemoryProviderUnavailableError(`native memory is not exposed; cannot read ${path}`)
  }

  async write(_scope: MemoryScope, path: string): Promise<MemoryWriteResult> {
    throw new MemoryProviderUnavailableError(`native memory is not exposed; cannot write ${path}`)
  }
}
