import type { RuntimeDef } from '../../config/config-schema.js'
import { describeRuntime, runtimeMemoryDisabledEnv } from '../runtime/capabilities.js'
import { MemoryProviderUnavailableError } from '../types.js'

/** The verified env that turns the runtime's own memory off; `managed` tolerates an unclassified harness, while `none`, `external` and assistant mode fail closed. */
export function disabledRuntimeMemoryEnv(
  runtime: RuntimeDef,
  effectiveEnv: NodeJS.ProcessEnv,
  runtimeId: string | undefined,
  requiredFor?: 'none' | 'external' | 'assistant-mode'
): Record<string, string> {
  let env: Record<string, string> | undefined
  try {
    env = runtimeMemoryDisabledEnv(runtime, effectiveEnv, runtimeId)
  } catch (error) {
    throw new MemoryProviderUnavailableError(error instanceof Error ? error.message : String(error))
  }
  if (env) return env
  if (requiredFor === 'assistant-mode') {
    throw new MemoryProviderUnavailableError(
      `assistant mode needs the runtime's own memory turned off, and this runtime's off-switch is unverified: ${describeRuntime(runtime, runtimeId)}`
    )
  }
  if (requiredFor) {
    throw new MemoryProviderUnavailableError(
      `${requiredFor} memory is not supported for this runtime (off-switch unverified): ${describeRuntime(runtime, runtimeId)}; use managed or register a verified runtime-memory policy`
    )
  }
  return {}
}
