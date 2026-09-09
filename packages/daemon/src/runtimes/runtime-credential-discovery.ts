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

/** Unknown credential formats defer to the runtime's own authentication result. */
export function runtimeCredentialsConfigured(
  runtimeId: string,
  runtime?: RuntimeDef,
  hostEnv: NodeJS.ProcessEnv = process.env
): boolean | undefined {
  if (
    !sharedCredentialProfile(runtimeId, runtime) &&
    runtimeId !== 'omp' &&
    !runtimeStateLocations(runtimeId, hostEnv).some((location) => location.credentialFiles?.length)
  )
    return undefined
  return discoverRuntimeCredentials(runtimeId, runtime, hostEnv).paths.length > 0
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
  return discoverSeededRuntimeCredentials(runtimeId, hostEnv)
}
