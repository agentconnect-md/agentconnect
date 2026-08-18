import type { RuntimeDef } from '../../config/config-schema.js'
import type { MemoryFs } from '../store.js'
import { isNativeRuntimeSupported, nativeRuntimeEnv } from '../runtime/native.js'
import { describeRuntime } from '../runtime/capabilities.js'
import { MemoryProviderUnavailableError, type MemoryProvider, type MemoryProviderKind } from '../types.js'
import { ManagedMemoryProvider } from './managed.js'
import { NoMemoryProvider } from './none.js'
import { DispatchingMemoryProvider, type MemoryProviderDeps } from './dispatching.js'
import { disabledRuntimeMemoryEnv } from './runtime-env.js'

/** The daemon-side memory provider kind for an agent (absent ⇒ managed default). */
export function memoryKindOf(agent: { memory?: { provider?: MemoryProviderKind } }): MemoryProviderKind {
  return agent.memory?.provider ?? 'managed'
}

/**
 * Build the concrete provider for ONE agent — used at spawn (`daemon.ts` / `chat.ts`)
 * to source `runtimeEnv`, and validated eagerly so a misconfigured agent (external,
 * or native on an unregistered runtime) fails loudly with the agent's root bound.
 * Throws `MemoryProviderUnavailableError` on an unbuildable provider.
 */
export function memoryProviderFor(
  agent: {
    dir: string
    runtime?: string
    memory?: { provider?: MemoryProviderKind; connectionId?: string }
  },
  runtime: RuntimeDef,
  effectiveEnv: NodeJS.ProcessEnv = {},
  externalAdmission?: { assertReady(connectionId: string): void }
): { runtimeEnv(): Record<string, string> } {
  const kind = memoryKindOf(agent)
  // Managed keeps a single store: turn OFF any verified runtime-owned memory (see ManagedMemoryProvider.runtimeEnv).
  if (kind === 'managed') return { runtimeEnv: () => disabledRuntimeMemoryEnv(runtime, effectiveEnv, agent.runtime) }
  if (kind === 'none') {
    const p = new NoMemoryProvider()
    return { runtimeEnv: () => p.runtimeEnv(runtime, effectiveEnv, agent.runtime) }
  }
  if (kind === 'native') {
    if (!isNativeRuntimeSupported(runtime, agent.runtime)) {
      throw new MemoryProviderUnavailableError(
        `native memory is not supported for this runtime (env levers unverified): ${describeRuntime(runtime, agent.runtime)}`
      )
    }
    // Bind the agent root so runtimeEnv can compute the redirect target.
    return { runtimeEnv: () => nativeRuntimeEnv(runtime, agent.dir, agent.runtime) }
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

/** A managed-only provider (used where per-agent dispatch isn't needed, e.g. tests). */
export function createManagedMemoryProvider(memoryFsFor: (agentId: string) => MemoryFs | undefined): MemoryProvider {
  return new ManagedMemoryProvider(memoryFsFor)
}
