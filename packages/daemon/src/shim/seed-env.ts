import { SHIM_SEED_ENV } from './protocol.js'

// The execution environment's own seed: string entries only, and no values from the holder's request.
export function seedEnv(env: Record<string, string | undefined>): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(env[SHIM_SEED_ENV] ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  } catch {
    return {}
  }
}
