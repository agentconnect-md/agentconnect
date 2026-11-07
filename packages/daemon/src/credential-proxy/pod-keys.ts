// Where a pool pod launch sends the install's static provider keys (github-app-git-credentials.md, Provider keys), read from the launch env as its runtime reads it.
import type { ModelCredential, ModelProviderTarget } from '../runtimes/model-provider-config.js'
import { PROVIDER_KEY_VARIABLES, runtimeKeyEndpoint, type KeyEndpoint } from '../runtimes/provider-endpoints.js'

export { PROVIDER_DEFAULT_ENDPOINTS } from '../runtimes/provider-endpoints.js'

/** Applies a pod launch's model configuration to `env`, each static pair's key as `keyFor` gives it. */
export type PodModelConfigure = (
  env: Record<string, string>,
  keyFor: (target: ModelProviderTarget) => ModelCredential | undefined
) => void

/** The provider key variables a pod launch may carry from the install's runtime environment. */
export const POD_KEY_VARIABLES: readonly string[] = PROVIDER_KEY_VARIABLES

/** Where the launch's runtime sends a key value: one entry per provider key variable holding it, undefined where that is not known. */
export function keyDestinations(
  target: ModelProviderTarget | undefined,
  value: string,
  env: Record<string, string>
): Array<KeyEndpoint | undefined> {
  return POD_KEY_VARIABLES.filter((name) => env[name] === value).map((name) => runtimeKeyEndpoint(target, name, env))
}

/** The variables `proxied` sets differently from `real`: what a launch holding `real` swaps in to carry placeholders instead. */
export function launchOverlay(real: Record<string, string>, proxied: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(proxied).filter(([name, value]) => real[name] !== value))
}

/** Whether any variable of the launch still carries the value, whole or embedded. */
export function carries(env: Record<string, string>, value: string): boolean {
  return Object.values(env).some((candidate) => candidate.includes(value))
}
