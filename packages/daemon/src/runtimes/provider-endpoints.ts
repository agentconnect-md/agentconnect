// Where each runtime reads a provider key and its base URL, and the origin it sends that key to: the one table the writers and every endpoint reader share.
import { CODEX_DEFAULT_ENDPOINT, objectFromJson, record } from './codex-config.js'
import type { ModelProviderTarget, ModelRuntimeKind } from './model-provider-config.js'

/** Each provider dialect's own endpoint, where a key with no base URL is sent. */
export const PROVIDER_DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: CODEX_DEFAULT_ENDPOINT,
  deepseek: 'https://api.deepseek.com',
  google: 'https://generativelanguage.googleapis.com'
}

/** The variable a runtime reads a provider's key from, and the one naming its base URL where that is an env variable. */
export interface KeyVariables {
  key: string
  base?: string
}

type Dialect = 'anthropic' | 'openai' | 'deepseek'

const ANTHROPIC = { key: 'ANTHROPIC_API_KEY', base: 'ANTHROPIC_BASE_URL' } as const
const OPENAI = { key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL' } as const
const DEEPSEEK = { key: 'DEEPSEEK_API_KEY', base: 'DEEPSEEK_BASE_URL' } as const
const COPILOT = { key: 'COPILOT_PROVIDER_API_KEY', base: 'COPILOT_PROVIDER_BASE_URL' } as const
// An OpenCode-shaped runtime names each built-in provider's base URL in its config document, not a variable.
const OPENCODE = {
  anthropic: { key: ANTHROPIC.key },
  openai: { key: OPENAI.key },
  deepseek: { key: DEEPSEEK.key }
} as const

/** Each runtime's provider key variables, per dialect it speaks. */
export const RUNTIME_KEY_VARIABLES = {
  claude: { anthropic: ANTHROPIC },
  codex: { openai: OPENAI },
  deepseek: { deepseek: DEEPSEEK },
  qwen: { anthropic: ANTHROPIC, openai: OPENAI },
  goose: { anthropic: { key: ANTHROPIC.key, base: 'ANTHROPIC_HOST' }, openai: OPENAI },
  copilot: { anthropic: COPILOT, openai: COPILOT },
  opencode: OPENCODE,
  kilo: OPENCODE
} as const satisfies Record<ModelRuntimeKind, Partial<Record<Dialect, KeyVariables>>>

/** Where Antigravity reads its Gemini API key and the base URL it sends that key to. */
export const GEMINI_KEY_VARIABLES = { key: 'GEMINI_API_KEY', base: 'GOOGLE_GEMINI_BASE_URL' } as const

/** The variable that picks Copilot's provider dialect for its one key. */
export const COPILOT_PROVIDER_TYPE_ENV = 'COPILOT_PROVIDER_TYPE'

/** The two runtimes that read an OpenCode configuration document, and the variable that carries it. */
export const OPENCODE_CONFIG_ENV = { opencode: 'OPENCODE_CONFIG_CONTENT', kilo: 'KILO_CONFIG_CONTENT' } as const

/** The provider key variables any runtime reads, in table order. */
export const PROVIDER_KEY_VARIABLES: readonly string[] = [
  ...new Set(
    Object.values(RUNTIME_KEY_VARIABLES).flatMap((dialects) =>
      Object.values(dialects).map((variables: KeyVariables) => variables.key)
    )
  )
]

/** The provider a key belongs to and the endpoint its runtime sends it to. */
export interface KeyEndpoint {
  provider: string
  endpoint: string
}

/** The variables a runtime reads one dialect's key and base URL from; undefined for a dialect it does not speak. */
export function keyVariables(runtime: ModelRuntimeKind, dialect: string): KeyVariables | undefined {
  const dialects: Partial<Record<string, KeyVariables>> = RUNTIME_KEY_VARIABLES[runtime]
  return Object.hasOwn(dialects, dialect) ? dialects[dialect] : undefined
}

/** The dialect whose key the runtime reads from `name`, with its variables. */
function dialectOf(runtime: ModelRuntimeKind, name: string): [Dialect, KeyVariables] | undefined {
  const dialects: Partial<Record<Dialect, KeyVariables>> = RUNTIME_KEY_VARIABLES[runtime]
  return (Object.entries(dialects) as Array<[Dialect, KeyVariables]>).find(([, variables]) => variables.key === name)
}

/** The endpoint a variable names, else its provider's own; undefined for a provider with none. */
function base(provider: string, value: string | undefined): KeyEndpoint | undefined {
  const endpoint = value?.trim() || PROVIDER_DEFAULT_ENDPOINTS[provider]
  return endpoint ? { provider, endpoint } : undefined
}

/** Codex's endpoint: a gateway auth request's base, which must agree with the configured one; else the base the pod shim composes one for (configured, OPENAI_BASE_URL, default). */
function codexEndpoint(env: Record<string, string>): KeyEndpoint | undefined {
  const config = objectFromJson(env.CODEX_CONFIG, 'CODEX_CONFIG')
  if (typeof config.model_provider === 'string' && config.model_provider !== 'openai') return undefined
  const aimed =
    (typeof config.openai_base_url === 'string' ? config.openai_base_url.trim() : '') ||
    env[RUNTIME_KEY_VARIABLES.codex.openai.base]?.trim()
  if (!env.DEFAULT_AUTH_REQUEST) return base('openai', aimed)
  const request = objectFromJson(env.DEFAULT_AUTH_REQUEST, 'DEFAULT_AUTH_REQUEST')
  const gateway = record(record(request._meta, 'DEFAULT_AUTH_REQUEST._meta').gateway, 'gateway').baseUrl
  if (request.methodId !== 'gateway' || typeof gateway !== 'string') return undefined
  return aimed && aimed !== gateway ? undefined : { provider: 'openai', endpoint: gateway }
}

/** An OpenCode-shaped runtime's built-in provider for the variable, at the base URL its config names; undefined when another provider entry reads the variable too. */
function openCodeEndpoint(kind: keyof typeof OPENCODE_CONFIG_ENV, name: string, env: Record<string, string>) {
  const provider = dialectOf(kind, name)?.[0]
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

/** Where a launch's runtime sends one variable's key, read from its final env; undefined when it is no provider key this runtime is known to send to one endpoint. */
export function runtimeKeyEndpoint(
  target: Pick<ModelProviderTarget, 'runtime'> | undefined,
  name: string,
  env: Record<string, string>
): KeyEndpoint | undefined {
  if (!target) return undefined
  try {
    switch (target.runtime) {
      case 'codex':
        return name === RUNTIME_KEY_VARIABLES.codex.openai.key ? codexEndpoint(env) : undefined
      case 'goose':
        // An OPENAI_HOST beside goose's OpenAI key leaves where it goes unknown.
        if (name === RUNTIME_KEY_VARIABLES.goose.openai.key && env.OPENAI_HOST) return undefined
        break
      case 'copilot': {
        const provider = env[COPILOT_PROVIDER_TYPE_ENV]
        if (provider !== 'anthropic' && provider !== 'openai') return undefined
        const variables = RUNTIME_KEY_VARIABLES.copilot[provider]
        const url = env[variables.base]?.trim()
        return name === variables.key && url ? { provider, endpoint: url } : undefined
      }
      case 'opencode':
      case 'kilo':
        return openCodeEndpoint(target.runtime, name, env)
    }
    const dialect = dialectOf(target.runtime, name)
    return dialect && base(dialect[0], dialect[1].base && env[dialect[1].base])
  } catch {
    // An unreadable config document names no endpoint the proxy can trust.
    return undefined
  }
}

/** The runtimes whose host keys an srt or microsandbox launch binds through its own preparers. */
export type HostKeyRuntime = 'claude' | 'codex' | 'deepseek'

/** Where a host launch's runtime sends one variable's key: a set base variable as it stands, blank or not; Codex's from `codexConfig` unless OPENAI_BASE_URL is set. */
export function hostKeyEndpoint(
  runtime: HostKeyRuntime,
  name: string,
  env: Record<string, string | undefined>,
  codexConfig: () => Record<string, unknown> = () => ({})
): KeyEndpoint | undefined {
  const dialect = dialectOf(runtime, name)
  if (!dialect) return undefined
  const [provider, variables] = dialect
  // A host Codex does not follow OPENAI_BASE_URL the way a pod's shim does, so a key beside one has no known endpoint.
  if (runtime === 'codex') return env[variables.base!] ? undefined : hostCodexEndpoint(codexConfig())
  return endpointOf(provider, env[variables.base!] ?? PROVIDER_DEFAULT_ENDPOINTS[provider])
}

/** Where a host Codex sends an OpenAI key under its merged configuration: the built-in provider's base, else a custom provider's that asks for OpenAI auth. */
export function hostCodexEndpoint(config: Record<string, unknown>): KeyEndpoint | undefined {
  const provider = config.model_provider ?? 'openai'
  const custom = record(record(config.model_providers, 'Codex providers')[String(provider)], 'Codex provider')
  return endpointOf(
    'openai',
    provider === 'openai'
      ? (config.openai_base_url ?? CODEX_DEFAULT_ENDPOINT)
      : custom.requires_openai_auth === true
        ? custom.base_url
        : undefined
  )
}

/** A configured endpoint as it stands; undefined when it names none. */
function endpointOf(provider: string, endpoint: unknown): KeyEndpoint | undefined {
  return typeof endpoint === 'string' && endpoint ? { provider, endpoint } : undefined
}
