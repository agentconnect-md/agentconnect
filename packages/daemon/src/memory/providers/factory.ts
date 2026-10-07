import type { RuntimeDef } from '../../config/config-schema.js'
import type { MemoryHomePorts } from '../home.js'
import { describeRuntime, runtimeMemoryCapabilities } from '../runtime/capabilities.js'
import { MemoryProviderUnavailableError, type MemoryProvider, type MemoryProviderKind } from '../types.js'
import { ManagedMemoryProvider } from './managed.js'
import { NoMemoryProvider } from './none.js'
import { DispatchingMemoryProvider, type MemoryProviderDeps } from './dispatching.js'
import { disabledRuntimeMemoryEnv } from './runtime-env.js'

/** The daemon-side memory provider kind for an agent (absent ⇒ managed default). */
export function memoryKindOf(agent: { memory?: { provider?: MemoryProviderKind } }): MemoryProviderKind {
  return agent.memory?.provider ?? 'managed'
}

/** One agent's memory env at spawn; throws `MemoryProviderUnavailableError` for an unbuildable provider (external without admission, native on an unverified runtime or in assistant mode). */
export function memoryProviderFor(
  agent: {
    runtime?: string
    memory?: { provider?: MemoryProviderKind; connectionId?: string }
    assistantMode?: { enabled: boolean }
  },
  runtime: RuntimeDef,
  effectiveEnv: NodeJS.ProcessEnv = {},
  externalAdmission?: { assertReady(connectionId: string): void }
): { runtimeEnv(): Record<string, string> } {
  const kind = memoryKindOf(agent)
  // Assistant mode needs the runtime's own cross-session memory off (assistant-mode.md §4.1), so its off-switch is required.
  const assistant = agent.assistantMode?.enabled === true
  if (assistant && kind === 'native') {
    throw new MemoryProviderUnavailableError(
      "assistant mode needs the runtime's own memory turned off, not native memory"
    )
  }
  // Managed keeps a single store: turn OFF any verified runtime-owned memory (see ManagedMemoryProvider.runtimeEnv).
  if (kind === 'managed') {
    const requiredFor = assistant ? ('assistant-mode' as const) : undefined
    return { runtimeEnv: () => disabledRuntimeMemoryEnv(runtime, effectiveEnv, agent.runtime, requiredFor) }
  }
  if (kind === 'none') {
    const p = new NoMemoryProvider()
    return { runtimeEnv: () => p.runtimeEnv(runtime, effectiveEnv, agent.runtime) }
  }
  if (kind === 'native') {
    if (!runtimeMemoryCapabilities(runtime, agent.runtime).native) {
      throw new MemoryProviderUnavailableError(
        `native memory is not supported for this runtime (memory location unverified): ${describeRuntime(runtime, agent.runtime)}`
      )
    }
    // Neither an off-switch nor a redirect: the runtime's memory stays wherever this launch keeps its state (#2668).
    return { runtimeEnv: () => ({}) }
  }
  const connectionId = agent.memory?.connectionId
  if (!connectionId) throw new MemoryProviderUnavailableError('external memory connection id is missing')
  if (!externalAdmission) {
    throw new MemoryProviderUnavailableError('external memory connection registry is not available')
  }
  return {
    runtimeEnv: () => {
      externalAdmission.assertReady(connectionId)
      // External is the sole persistent store, so it carries the same strict
      // native-memory off-switch requirement as provider=none.
      return disabledRuntimeMemoryEnv(runtime, effectiveEnv, agent.runtime, 'external')
    }
  }
}

/** Build the daemon's dispatching memory provider over the agent resolvers. */
export function createMemoryProvider(deps: MemoryProviderDeps): DispatchingMemoryProvider {
  return new DispatchingMemoryProvider(deps)
}

/** A managed-only provider over the agents' memory homes (used where per-agent dispatch isn't needed, e.g. tests). */
export function createManagedMemoryProvider(
  memoryHomePortsFor: (agentId: string) => MemoryHomePorts | undefined
): MemoryProvider {
  return new ManagedMemoryProvider(memoryHomePortsFor)
}
