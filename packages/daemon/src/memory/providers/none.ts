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
import { disabledRuntimeMemoryEnv } from './runtime-env.js'

/**
 * No persistent memory. Runtime-native memory is explicitly disabled and the
 * daemon contributes no store, prompt injection, distillation, or MCP tools.
 */
export class NoMemoryProvider implements MemoryProvider {
  readonly kind = 'none' as const

  runtimeEnv(runtime: RuntimeDef, effectiveEnv: NodeJS.ProcessEnv = {}, runtimeId?: string): Record<string, string> {
    return disabledRuntimeMemoryEnv(runtime, effectiveEnv, runtimeId, 'none')
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
    throw new MemoryProviderUnavailableError(`persistent memory is disabled; cannot read ${path}`)
  }

  async write(_scope: MemoryScope, path: string): Promise<MemoryWriteResult> {
    throw new MemoryProviderUnavailableError(`persistent memory is disabled; cannot write ${path}`)
  }
}
