import { z } from 'zod'

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const SecretSource = EnvName.regex(/^AC_RUNTIME_SECRET_[A-F0-9]{16}$/)
const Bindings = z.record(z.string().min(1), z.record(EnvName, SecretSource))

export type RuntimeEnvironment = Record<string, Record<string, string>>

/** Resolve operator-owned Secret references once, before any sandbox is launched. */
export function configuredRuntimeEnvironment(env: NodeJS.ProcessEnv): RuntimeEnvironment {
  const raw = env.AC_RUNTIME_ENV_BINDINGS?.trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AC_RUNTIME_ENV_BINDINGS must be valid JSON')
  }
  const bindings = Bindings.safeParse(parsed)
  if (!bindings.success)
    throw new Error('AC_RUNTIME_ENV_BINDINGS must map runtime IDs and environment names to Secret references')
  const resolved: RuntimeEnvironment = {}
  for (const [runtimeId, names] of Object.entries(bindings.data)) {
    const values: Record<string, string> = {}
    for (const [name, source] of Object.entries(names)) {
      if (['AC_AGENT_ID', 'HOME', 'PATH', '__proto__'].includes(name)) {
        throw new Error(`AC_RUNTIME_ENV_BINDINGS cannot replace the runtime's ${name}`)
      }
      const value = env[source]
      if (!value) throw new Error(`AC_RUNTIME_ENV_BINDINGS source ${source} is missing or empty`)
      values[name] = value
    }
    resolved[runtimeId] = values
  }
  return resolved
}

export function applyRuntimeEnvironment(
  configured: RuntimeEnvironment,
  runtimeId: string,
  env: Record<string, string>
): string[] {
  const values = configured[runtimeId]
  if (!values) return []
  Object.assign(env, values)
  return Object.values(values)
}
