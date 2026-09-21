import type { RuntimeDef } from '../config/config-schema.js'
import {
  discoverSharedRuntimeCredentials,
  resolveOmpCredentialSource,
  sharedCredentialProfile,
  type RuntimeCredentialDiscovery
} from './runtime-credential-sources.js'
import { discoverSeededRuntimeCredentials } from './runtime-seeded-credentials.js'
import { discoverOmpCredentialProviders } from './omp-credentials.js'
import { runtimeStateLocations } from './probe.js'

/** Provider API keys that authenticate a runtime with no on-disk login. GOOGLE_API_KEY is Vertex-only for gemini-cli. */
const RUNTIME_CREDENTIAL_ENV: Readonly<Record<string, { provider: string; keys: readonly string[] }>> = Object.freeze({
  gemini: { provider: 'google', keys: ['GEMINI_API_KEY'] }
})

function envCredentialProviders(runtimeId: string, hostEnv: NodeJS.ProcessEnv): string[] {
  const spec = RUNTIME_CREDENTIAL_ENV[runtimeId]
  return spec && spec.keys.some((name) => !!hostEnv[name]?.trim()) ? [spec.provider] : []
}

/** Unknown credential formats defer to the runtime's own authentication result. */
export function runtimeCredentialsConfigured(
  runtimeId: string,
  runtime?: RuntimeDef,
  hostEnv: NodeJS.ProcessEnv = process.env
): boolean | undefined {
  if (
    !sharedCredentialProfile(runtimeId, runtime) &&
    runtimeId !== 'omp' &&
    !RUNTIME_CREDENTIAL_ENV[runtimeId] &&
    !runtimeStateLocations(runtimeId, hostEnv).some((location) => location.credentialFiles?.length)
  )
    return undefined
  const found = discoverRuntimeCredentials(runtimeId, runtime, hostEnv)
  return found.paths.length > 0 || found.providers.length > 0
}

export function discoverRuntimeCredentials(
  runtimeId: string,
  runtime?: RuntimeDef,
  hostEnv: NodeJS.ProcessEnv = process.env
): RuntimeCredentialDiscovery {
  const profile = sharedCredentialProfile(runtimeId, runtime)
  if (profile) return discoverSharedRuntimeCredentials(profile, hostEnv)
  if (runtimeId === 'omp') {
    const path = resolveOmpCredentialSource(hostEnv)
    const providers = discoverOmpCredentialProviders(path)
    return { paths: providers.length > 0 ? [path] : [], providers }
  }
  const seeded = discoverSeededRuntimeCredentials(runtimeId, hostEnv)
  // An API key in the daemon environment is a configured credential even with no seeded login file.
  const providers = envCredentialProviders(runtimeId, hostEnv)
  return providers.length > 0 ? { ...seeded, providers: [...seeded.providers, ...providers] } : seeded
}
