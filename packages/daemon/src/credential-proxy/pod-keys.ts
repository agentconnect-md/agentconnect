// Where a pool pod launch sends the install's static provider keys (github-app-git-credentials.md, Provider keys), read from the launch env as its runtime reads it.
import { CODEX_DEFAULT_ENDPOINT, objectFromJson, record } from '../runtimes/codex-config.js'
import type { ModelCredential, ModelProviderTarget } from '../runtimes/model-provider-config.js'

/** Each provider dialect's own endpoint, where a key with no base URL is sent. */
export const PROVIDER_DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: CODEX_DEFAULT_ENDPOINT,
  deepseek: 'https://api.deepseek.com'
}

/** Applies a pod launch's model configuration to `env`, each static pair's key as `keyFor` gives it. */
export type PodModelConfigure = (
  env: Record<string, string>,
  keyFor: (target: ModelProviderTarget) => ModelCredential | undefined
) => void

/** The provider a key belongs to and the endpoint its runtime sends it to. */
export interface KeyEndpoint {
  provider: string
  endpoint: string
}

/** The provider key variables a pod launch may carry from the install's runtime environment. */
export const POD_KEY_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'COPILOT_PROVIDER_API_KEY'
]

const OPENCODE_CONFIG_ENV = { opencode: 'OPENCODE_CONFIG_CONTENT', kilo: 'KILO_CONFIG_CONTENT' } as const
const OPENCODE_KEY_PROVIDER: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  DEEPSEEK_API_KEY: 'deepseek'
}

/** A static model pair's endpoint: its base URL, else its provider's own; undefined for a provider with none. */
export function pairEndpoint(provider: string, baseUrl: string | undefined): KeyEndpoint | undefined {
  const endpoint = baseUrl || PROVIDER_DEFAULT_ENDPOINTS[provider]
  return endpoint ? { provider, endpoint } : undefined
}

function base(provider: string, value: string | undefined): KeyEndpoint | undefined {
  return pairEndpoint(provider, value?.trim() || undefined)
}

/** Codex's endpoint as the pod shim composes its auth request: the configured base, then OPENAI_BASE_URL, then the default. */
function codexEndpoint(env: Record<string, string>): KeyEndpoint | undefined {
  const config = objectFromJson(env.CODEX_CONFIG, 'CODEX_CONFIG')
  if (typeof config.model_provider === 'string' && config.model_provider !== 'openai') return undefined
  const aimed = typeof config.openai_base_url === 'string' ? config.openai_base_url : undefined
  return base('openai', aimed?.trim() || env.OPENAI_BASE_URL)
}

/** An OpenCode-shaped runtime's built-in provider for the variable, at the base URL its config names; undefined when another provider entry reads the variable too. */
function openCodeEndpoint(kind: keyof typeof OPENCODE_CONFIG_ENV, name: string, env: Record<string, string>) {
  const provider = OPENCODE_KEY_PROVIDER[name]
  if (!provider) return undefined
  const configEnv = OPENCODE_CONFIG_ENV[kind]
  const providers = record(objectFromJson(env[configEnv], configEnv).provider, `${configEnv}.provider`)
  const reference = `{env:${name}}`
  const others = Object.entries(providers).some(
    ([id, entry]) => id !== provider && JSON.stringify(entry).includes(reference)
  )
  if (others) return undefined
  const options = record(record(providers[provider], configEnv).options, configEnv)
  return base(provider, typeof options.baseURL === 'string' ? options.baseURL : undefined)
}

/** Where the launch's runtime sends one variable's key; undefined when it is no provider key this runtime is known to send to one endpoint. */
export function runtimeKeyEndpoint(
  target: ModelProviderTarget | undefined,
  name: string,
  env: Record<string, string>
): KeyEndpoint | undefined {
  if (!target) return undefined
  try {
    switch (target.runtime) {
      case 'claude':
        return name === 'ANTHROPIC_API_KEY' ? base('anthropic', env.ANTHROPIC_BASE_URL) : undefined
      case 'codex':
        return name === 'OPENAI_API_KEY' ? codexEndpoint(env) : undefined
      case 'deepseek':
        return name === 'DEEPSEEK_API_KEY' ? base('deepseek', env.DEEPSEEK_BASE_URL) : undefined
      case 'qwen':
        if (name === 'ANTHROPIC_API_KEY') return base('anthropic', env.ANTHROPIC_BASE_URL)
        return name === 'OPENAI_API_KEY' ? base('openai', env.OPENAI_BASE_URL) : undefined
      case 'goose':
        if (name === 'ANTHROPIC_API_KEY') return base('anthropic', env.ANTHROPIC_HOST)
        return name === 'OPENAI_API_KEY' && !env.OPENAI_HOST ? base('openai', env.OPENAI_BASE_URL) : undefined
      case 'copilot': {
        const provider = env.COPILOT_PROVIDER_TYPE
        const url = env.COPILOT_PROVIDER_BASE_URL?.trim()
        if (name !== 'COPILOT_PROVIDER_API_KEY' || !url || (provider !== 'anthropic' && provider !== 'openai'))
          return undefined
        return { provider, endpoint: url }
      }
      case 'opencode':
      case 'kilo':
        return openCodeEndpoint(target.runtime, name, env)
    }
  } catch {
    // An unreadable config document names no endpoint the proxy can trust.
    return undefined
  }
}

/** The variables `proxied` sets differently from `real`: what a launch holding `real` swaps in to carry placeholders instead. */
export function launchOverlay(real: Record<string, string>, proxied: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(proxied).filter(([name, value]) => real[name] !== value))
}

/** Whether any variable of the launch still carries the value, whole or embedded. */
export function carries(env: Record<string, string>, value: string): boolean {
  return Object.values(env).some((candidate) => candidate.includes(value))
}
