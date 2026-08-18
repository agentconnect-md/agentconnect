import type { RuntimeDef } from '../../config/config-schema.js'
import { describeRuntime, runtimeMemoryDisabledEnv } from '../runtime/capabilities.js'
import { MemoryProviderUnavailableError } from '../types.js'

/**
 * Apply the centralized runtime-memory policy. `managed` remains available for an
 * unclassified harness (our store still works), while `none` must fail closed: it
 * cannot promise "no persistent memory" without a verified native off-switch.
 */
export function disabledRuntimeMemoryEnv(
  runtime: RuntimeDef,
  effectiveEnv: NodeJS.ProcessEnv,
  runtimeId: string | undefined,
  requiredFor?: 'none' | 'external'
): Record<string, string> {
  let env: Record<string, string> | undefined
  try {
    env = runtimeMemoryDisabledEnv(runtime, effectiveEnv, runtimeId)
  } catch (error) {
    throw new MemoryProviderUnavailableError(error instanceof Error ? error.message : String(error))
  }
  if (env) return env
  if (requiredFor) {
    throw new MemoryProviderUnavailableError(
      `${requiredFor} memory is not supported for this runtime (off-switch unverified): ${describeRuntime(runtime, runtimeId)}; use managed or register a verified runtime-memory policy`
    )
  }
  return {}
}
