import {
  PROVIDER_KEY_PROFILES,
  type AgentModelProvider,
  type AgentModelKeyProvider,
  type ProviderCredential,
  type KeyProvider
} from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../config/config-schema.js'
import type { Agent } from '../agents/agent-schema.js'
import { isClaudeRuntimeDef } from '../runtime-defs/claude-runtime.js'
import { isOpenCodeRuntime } from '../runtime-defs/opencode-runtime.js'
import { sharedCredentialProfile } from './runtime-credentials.js'
import {
  codexConfigWithBaseUrl,
  codexConfigWithFloor,
  codexGatewayAuthRequest,
  objectFromJson,
  record
} from './codex-config.js'
import {
  COPILOT_PROVIDER_TYPE_ENV,
  keyVariables,
  OPENCODE_CONFIG_ENV,
  RUNTIME_KEY_VARIABLES
} from './provider-endpoints.js'

export interface ModelCredential {
  key: string
  baseUrl?: string
}

/** Which runtime's own provider-configuration surface a credential must be written onto. */
export type ModelRuntimeKind = 'claude' | 'codex' | 'opencode' | 'deepseek' | 'kilo' | LaunchModelRuntimeKind

/** Runtimes whose launch environment names the one model they run, so the target carries it. */
export type LaunchModelRuntimeKind = 'qwen' | 'copilot' | 'goose'

export interface ModelProviderTarget {
  provider: KeyProvider
  runtime: ModelRuntimeKind
  opencodeProvider?: string
  model?: string
}

type OpenCodeShapedKind = keyof typeof OPENCODE_CONFIG_ENV

export function isOpenCodeShaped(target: Pick<ModelProviderTarget, 'runtime'> | undefined): boolean {
  return !!target && target.runtime in OPENCODE_CONFIG_ENV
}

function isLaunchModelRuntime(runtime: ModelRuntimeKind): runtime is LaunchModelRuntimeKind {
  return runtime === 'qwen' || runtime === 'copilot' || runtime === 'goose'
}

/** Whether a launch for this target needs a selected or catalogued model before a key is issued. */
export function requiresSelectedModel(target: ModelProviderTarget): boolean {
  return isOpenCodeShaped(target) || isLaunchModelRuntime(target.runtime)
}

const OPENCODE_PROVIDERS: Record<string, { runtime: ModelRuntimeKind }> = {
  anthropic: { runtime: 'claude' },
  openai: { runtime: 'codex' },
  deepseek: { runtime: 'deepseek' }
}

// The deepseek pair speaks Messages, and Kilo's built-in deepseek provider sends chat completions whatever its `npm`.
function openCodeShapedProviders(target: ModelProviderTarget): string[] {
  const providers = Object.keys(OPENCODE_PROVIDERS)
  return target.runtime === 'kilo' ? providers.filter((provider) => provider !== 'deepseek') : providers
}

export function modelCredentialRuntime(target: ModelProviderTarget): ModelRuntimeKind {
  if (isOpenCodeShaped(target)) return OPENCODE_PROVIDERS[target.opencodeProvider ?? 'openai']?.runtime ?? 'opencode'
  // A launch-model runtime reuses the pair of the dialect it speaks.
  if (isLaunchModelRuntime(target.runtime)) return target.provider === 'anthropic' ? 'claude' : 'codex'
  return target.runtime
}

// The bin, not the package: `dsh-acp` is the single bin of @openma/deepseek-harness-acp.
export function isDeepSeekRuntime(runtimeId: string, runtime?: RuntimeDef): boolean {
  if (runtimeId === 'dsh-acp') return true
  return (
    !!runtime &&
    [runtime.command, ...runtime.args].some((part) => /(?:^|[\/@])dsh-acp(?:@[^\/]*)?$/.test(part.toLowerCase()))
  )
}

// A runtime is recognised by its registry id or by the bin or package its launch names.
const LAUNCH_RUNTIMES: ReadonlyArray<{ kind: 'kilo' | LaunchModelRuntimeKind; ids: string[]; launch: RegExp }> = [
  { kind: 'kilo', ids: ['kilo'], launch: /(?:^|\/)(?:kilo|@kilocode\/cli(?:@[^\/]*)?)$/ },
  { kind: 'qwen', ids: ['qwen-code'], launch: /(?:^|\/)(?:qwen|@qwen-code\/qwen-code(?:@[^\/]*)?)$/ },
  { kind: 'copilot', ids: ['github-copilot-cli'], launch: /(?:^|\/)(?:copilot|@github\/copilot(?:@[^\/]*)?)$/ },
  { kind: 'goose', ids: ['goose'], launch: /(?:^|\/)goose$/ }
]

function launchRuntimeKind(runtimeId: string, runtime: RuntimeDef): 'kilo' | LaunchModelRuntimeKind | undefined {
  return LAUNCH_RUNTIMES.find(
    (entry) =>
      entry.ids.includes(runtimeId) ||
      [runtime.command, ...runtime.args].some((part) => entry.launch.test(part.toLowerCase()))
  )?.kind
}

/** The dialect a bare model id needs and the id its runtime's model variable takes. */
export function launchModelChoice(model: string | undefined): { provider: 'anthropic' | 'openai'; model?: string } {
  const trimmed = model?.trim()
  if (!trimmed) return { provider: 'openai' }
  // Qwen Code advertises `$runtime|<authType>|<model>(<authType>)` for a model its environment names.
  const qwen = /^\$runtime\|([^|]+)\|(.+)\(\1\)$/.exec(trimmed)
  if (qwen) return { provider: qwen[1] === 'anthropic' ? 'anthropic' : 'openai', model: qwen[2] }
  const prefixed = /^(anthropic|openai)\/(.+)$/.exec(trimmed)
  if (prefixed) return { provider: prefixed[1] as 'anthropic' | 'openai', model: prefixed[2] }
  // Copilot's `auto` routes through its own service, which a BYOK launch never reaches.
  if (trimmed === 'auto') return { provider: 'openai' }
  return { provider: /^claude(?:$|[-.@])/i.test(trimmed) ? 'anthropic' : 'openai', model: trimmed }
}

function launchModelTarget(runtime: LaunchModelRuntimeKind, model: string | undefined): ModelProviderTarget {
  const choice = launchModelChoice(model)
  return { provider: choice.provider, runtime, ...(choice.model ? { model: choice.model } : {}) }
}

// The model a deployment named in the runtime's own variables, used when no session model is known.
function environmentLaunchModel(target: ModelProviderTarget, env: Record<string, string>): string | undefined {
  if (target.runtime === 'qwen') {
    const openai = env.OPENAI_MODEL || env.QWEN_MODEL
    if (openai) return `openai/${openai}`
    return env.ANTHROPIC_MODEL ? `anthropic/${env.ANTHROPIC_MODEL}` : undefined
  }
  if (target.runtime === 'copilot') return env.COPILOT_MODEL || undefined
  if (target.runtime === 'goose') return env.GOOSE_MODEL || undefined
  return undefined
}

function applyCodexBaseUrl(env: Record<string, string>, baseUrl: string): void {
  env.CODEX_CONFIG = codexConfigWithBaseUrl(env.CODEX_CONFIG, baseUrl)
  env[RUNTIME_KEY_VARIABLES.codex.openai.base] = baseUrl
}

export function modelProviderTarget(
  agent: Pick<Agent, 'runtime' | 'runtimeOverrides'>,
  runtime: RuntimeDef,
  effectiveModel = agent.runtimeOverrides?.model
): ModelProviderTarget | undefined {
  if (isClaudeRuntimeDef(runtime)) return { provider: 'anthropic', runtime: 'claude' }
  if (sharedCredentialProfile(agent.runtime, runtime) === 'codex') return { provider: 'openai', runtime: 'codex' }
  if (isDeepSeekRuntime(agent.runtime, runtime)) return { provider: 'deepseek', runtime: 'deepseek' }
  const launchKind = isOpenCodeRuntime(agent.runtime, runtime) ? 'opencode' : launchRuntimeKind(agent.runtime, runtime)
  if (!launchKind) return undefined
  if (isLaunchModelRuntime(launchKind)) return launchModelTarget(launchKind, effectiveModel)

  const configuredProvider = effectiveModel?.includes('/') ? effectiveModel.split('/', 1)[0]?.trim() : undefined
  const opencodeProvider = configuredProvider || 'openai'
  if (launchKind === 'kilo' && opencodeProvider === 'deepseek') return undefined
  return {
    provider: opencodeProvider === 'anthropic' || opencodeProvider === 'deepseek' ? opencodeProvider : 'openai',
    runtime: launchKind,
    opencodeProvider
  }
}

function applyOpenCodeCredential(
  target: ModelProviderTarget,
  env: Record<string, string>,
  credential: ModelCredential
): void {
  const providerId = target.opencodeProvider ?? 'openai'
  const configEnv = OPENCODE_CONFIG_ENV[target.runtime as OpenCodeShapedKind]
  const config = objectFromJson(env[configEnv], configEnv)
  const providers = record(config.provider, `${configEnv}.provider`)
  const provider = record(providers[providerId], `${configEnv}.provider.${providerId}`)
  const options = record(provider.options, `${configEnv}.provider.${providerId}.options`)
  const keyEnv = keyVariables(target.runtime, providerId)?.key ?? 'MODEL_TOKEN'
  if (credential.key) env[keyEnv] = credential.key
  let baseURL = credential.baseUrl
  // The deepseek pair is the DeepSeek Harness's Messages base, so OpenCode reaches it through its Anthropic SDK.
  const messagesBase = !!baseURL && (providerId === 'anthropic' || providerId === 'deepseek')
  // Claude Code and the DeepSeek Harness append /v1/messages; OpenCode's Anthropic SDK appends only /messages.
  if (baseURL && messagesBase) {
    const url = new URL(baseURL)
    url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
    baseURL = url.toString()
  }
  env[configEnv] = JSON.stringify({
    ...config,
    provider: {
      ...providers,
      [providerId]: {
        ...(messagesBase && providerId === 'deepseek' ? { npm: '@ai-sdk/anthropic' } : {}),
        ...provider,
        options: {
          ...options,
          ...(credential.key ? { apiKey: `{env:${keyEnv}}` } : {}),
          ...(baseURL ? { baseURL } : {})
        }
      }
    }
  })
}

// An Anthropic base is the Claude pair's (each client appends /v1/messages); an OpenAI base ends in /v1.
function applyLaunchModelCredential(
  target: ModelProviderTarget & { runtime: LaunchModelRuntimeKind },
  env: Record<string, string>,
  credential: ModelCredential
): void {
  const anthropic = target.provider === 'anthropic'
  const { key, baseUrl } = credential
  const variables = RUNTIME_KEY_VARIABLES[target.runtime][anthropic ? 'anthropic' : 'openai']
  if (target.runtime === 'qwen') {
    // Qwen Code picks its auth type from whichever variable triple is complete, OpenAI first.
    if (key) env[variables.key] = key
    if (baseUrl) env[variables.base] = baseUrl
    if (target.model) env[anthropic ? 'ANTHROPIC_MODEL' : 'OPENAI_MODEL'] = target.model
    if (anthropic) env.OPENAI_MODEL = env.QWEN_MODEL = ''
    // Also stops its models.dev catalog refresh; a deployment can still turn it back on.
    env.QWEN_USAGE_STATISTICS_ENABLED ??= 'false'
    return
  }
  if (target.runtime === 'copilot') {
    env[COPILOT_PROVIDER_TYPE_ENV] = target.provider
    if (key) env[variables.key] = key
    if (baseUrl) env[variables.base] = baseUrl
    if (target.model) env.COPILOT_MODEL = target.model
    // No GitHub sign-in, telemetry or model service: the provider is the only endpoint.
    env.COPILOT_OFFLINE = 'true'
    return
  }
  env.GOOSE_PROVIDER = target.provider
  if (key) env[variables.key] = key
  if (baseUrl) env[variables.base] = baseUrl
  if (target.model) env.GOOSE_MODEL = target.model
  // goose otherwise stores and reads provider keys through the OS keyring.
  env.GOOSE_DISABLE_KEYRING = '1'
}

// Translate the daemon-neutral model pair into the runtime's supported configuration surface.
export function applyModelCredential(
  target: ModelProviderTarget,
  env: Record<string, string>,
  credential: ModelCredential
): void {
  if (target.runtime === 'claude') {
    // The x-api-key slot, so the shim's AC_CLAUDE_API_KEY fill-in stays blocked and exactly one credential travels.
    const { key, base } = RUNTIME_KEY_VARIABLES.claude.anthropic
    env[key] = credential.key
    delete env.ANTHROPIC_AUTH_TOKEN
    if (credential.baseUrl) env[base] = credential.baseUrl
    return
  }

  if (target.runtime === 'deepseek') {
    const { key, base } = RUNTIME_KEY_VARIABLES.deepseek.deepseek
    env[key] = credential.key
    if (credential.baseUrl) env[base] = credential.baseUrl
    return
  }

  if (target.runtime === 'codex') {
    env[RUNTIME_KEY_VARIABLES.codex.openai.key] = credential.key
    // A key rides codex-acp's gateway auth request; an endpoint-less one gets its request from the shim, which alone sees the pod's base floor.
    if (!credential.baseUrl) return
    env.DEFAULT_AUTH_REQUEST = codexGatewayAuthRequest(credential.baseUrl, credential.key)
    // Kept beside the gateway method for an older codex-acp and for resumed threads on the built-in provider.
    applyCodexBaseUrl(env, credential.baseUrl)
    return
  }

  if (isLaunchModelRuntime(target.runtime)) {
    applyLaunchModelCredential(target as ModelProviderTarget & { runtime: LaunchModelRuntimeKind }, env, credential)
    return
  }

  applyOpenCodeCredential(target, env, credential)
}

// The deployment's codex session-config floor, applied by the DAEMON at spawn — not only by the
// sandbox shim. The shim's pod-env copy (AC_CODEX_CONFIG on the SandboxTemplate) never reaches an
// agent whose sandbox was minted before the value changed: the pod spec is a frozen snapshot, and
// daemon-written env is what wins over it. Same merge semantics as the shim's fill-in.
export function applyCodexSessionFloor(
  target: ModelProviderTarget,
  env: Record<string, string>,
  floorRaw: string
): void {
  if (target.runtime !== 'codex') return
  const merged = codexConfigWithFloor(env.CODEX_CONFIG, floorRaw)
  if (merged !== undefined) env.CODEX_CONFIG = merged
}

// Which concrete model each Claude alias resolves to on this deployment, in Claude Code's own
// model-config variables. Only the deployment knows what its gateway serves, and Claude Code
// offers an alias it was told nothing about only when the account's own rollout list names it —
// which a gateway-backed pool has none of, so its picker shows the built-in aliases and stops
// there. Declaring `ANTHROPIC_DEFAULT_FABLE_MODEL` is what puts Fable in that picker; the three
// metadata suffixes are how the option is labelled, described, and told what it supports.
const CLAUDE_MODEL_ALIASES = ['FABLE', 'OPUS', 'SONNET', 'HAIKU'] as const
const CLAUDE_ALIAS_SUFFIXES = ['', '_NAME', '_DESCRIPTION', '_SUPPORTED_CAPABILITIES'] as const

export const CLAUDE_MODEL_ALIAS_ENV: readonly string[] = CLAUDE_MODEL_ALIASES.flatMap((alias) =>
  CLAUDE_ALIAS_SUFFIXES.map((suffix) => `ANTHROPIC_DEFAULT_${alias}_MODEL${suffix}`)
)

/** The deployment's alias declarations, read once at boot like the codex floor. */
export function configuredClaudeModelAliases(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const declared: Record<string, string> = {}
  for (const name of CLAUDE_MODEL_ALIAS_ENV) {
    const value = env[name]?.trim()
    if (value) declared[name] = value
  }
  return Object.keys(declared).length > 0 ? declared : undefined
}

// Kilo starts on its own default model, which can be a provider this launch holds no key for.
export function applyKiloLaunchModel(
  target: ModelProviderTarget,
  env: Record<string, string>,
  model: string | undefined
): void {
  if (target.runtime !== 'kilo' || !model?.includes('/')) return
  const config = objectFromJson(env.KILO_CONFIG_CONTENT, 'KILO_CONFIG_CONTENT')
  config.model ??= model
  env.KILO_CONFIG_CONTENT = JSON.stringify(config)
}

// Applied by the DAEMON at spawn and at probe, so the picker a console shows and the models a
// session can run come from the same declaration — and so a sandbox minted before the value
// changed still gets it. Never overwrites a key the daemon already authored.
export function applyClaudeModelAliases(
  target: ModelProviderTarget,
  env: Record<string, string>,
  declared: Record<string, string>
): void {
  if (target.runtime !== 'claude') return
  for (const [name, value] of Object.entries(declared)) env[name] ??= value
}

// Validated at daemon construction so a malformed value fails the member loudly at boot instead
// of failing every codex spawn one at a time.
export function configuredCodexSessionFloor(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.AC_CODEX_CONFIG?.trim()
  if (!raw) return undefined
  objectFromJson(raw, 'AC_CODEX_CONFIG')
  return raw
}

export type StaticModelCredentials = Partial<Record<ModelRuntimeKind, ModelCredential>>

// OpenCode reuses each provider's runtime pair, including its shared fallback.
const RUNTIME_ENV_PREFIX: Partial<Record<ModelRuntimeKind, string>> = {
  claude: 'ANTHROPIC_',
  codex: 'OPENAI_',
  deepseek: 'DEEPSEEK_'
}

const RUNTIME_KINDS: readonly ModelRuntimeKind[] = ['claude', 'codex', 'opencode', 'deepseek']

function staticPair(env: NodeJS.ProcessEnv, prefix: string): ModelCredential | undefined {
  const key = env[`${prefix}MODEL_TOKEN`]?.trim()
  const baseUrl = env[`${prefix}MODEL_BASE_URL`]?.trim()
  if (!key && !baseUrl) return undefined
  if (baseUrl && (!URL.canParse(baseUrl) || !['http:', 'https:'].includes(new URL(baseUrl).protocol))) {
    throw new Error(`${prefix}MODEL_BASE_URL must be an http(s) URL`)
  }
  // A URL-only layer uses an internal empty sentinel; applyStaticModelConfig preserves the runtime key.
  return { key: key ?? '', ...(baseUrl ? { baseUrl } : {}) }
}

// A runtime-scoped pair replaces the shared one whole, never merges: splitting a pair aims a key
// at an endpoint that never issued it.
export function configuredModelCredentials(env: NodeJS.ProcessEnv): StaticModelCredentials | undefined {
  const shared = staticPair(env, '')
  const resolved: StaticModelCredentials = {}
  for (const kind of RUNTIME_KINDS) {
    const prefix = RUNTIME_ENV_PREFIX[kind]
    const pair = (prefix ? staticPair(env, prefix) : undefined) ?? shared
    if (pair) resolved[kind] = pair
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined
}

export function applyStaticModelConfig(
  target: ModelProviderTarget,
  env: Record<string, string>,
  configured: ModelCredential
): void {
  if (isOpenCodeShaped(target)) {
    applyOpenCodeCredential(target, env, configured)
    return
  }
  if (isLaunchModelRuntime(target.runtime)) {
    applyLaunchModelCredential(target as ModelProviderTarget & { runtime: LaunchModelRuntimeKind }, env, configured)
    return
  }
  if (configured.key) {
    applyModelCredential(target, env, configured)
    return
  }
  if (!configured.baseUrl) return
  if (target.runtime === 'claude') env[RUNTIME_KEY_VARIABLES.claude.anthropic.base] = configured.baseUrl
  else if (target.runtime === 'deepseek') env[RUNTIME_KEY_VARIABLES.deepseek.deepseek.base] = configured.baseUrl
  else if (target.runtime === 'codex') applyCodexBaseUrl(env, configured.baseUrl)
}

// Probe and launch the same provider set; each provider keeps its own credential and endpoint.
export function applyConfiguredModelProviders(
  target: ModelProviderTarget,
  env: Record<string, string>,
  credentialFor: (target: ModelProviderTarget) => ModelCredential | undefined
): void {
  // With no session model, the model the deployment named in the runtime's own variables picks the dialect.
  const launchModel =
    isLaunchModelRuntime(target.runtime) && !target.model ? environmentLaunchModel(target, env) : undefined
  const resolved = launchModel ? launchModelTarget(target.runtime as LaunchModelRuntimeKind, launchModel) : target
  const targets: ModelProviderTarget[] = isOpenCodeShaped(target)
    ? [...new Set([...openCodeShapedProviders(target), target.opencodeProvider ?? 'openai'])].map((provider) => ({
        runtime: target.runtime,
        opencodeProvider: provider,
        provider: provider === 'anthropic' || provider === 'deepseek' ? provider : 'openai'
      }))
    : [resolved]
  let configured = false
  for (const providerTarget of targets) {
    const credential = credentialFor(providerTarget)
    if (!credential) continue
    applyStaticModelConfig(providerTarget, env, credential)
    configured = true
  }
  if (!isOpenCodeShaped(target) || !configured) return
  // Without an explicit list Kilo falls back to its own sign-in provider, which a managed launch never has.
  const configEnv = OPENCODE_CONFIG_ENV[target.runtime as OpenCodeShapedKind]
  const config = objectFromJson(env[configEnv], configEnv)
  config.enabled_providers ??= Object.keys(record(config.provider, `${configEnv}.provider`))
  env[configEnv] = JSON.stringify(config)
}

export function organizationModelProvider(
  provider: AgentModelProvider,
  target: ModelProviderTarget | undefined
): AgentModelKeyProvider {
  if (
    !target ||
    (target.provider !== 'anthropic' && target.provider !== 'openai') ||
    (provider !== 'auto' && target.provider !== provider) ||
    (isOpenCodeShaped(target) && target.opencodeProvider !== target.provider)
  )
    throw new Error(`Selected ${provider} credentials do not match this runtime and model`)
  return target.provider
}

/** The provider an organization key for this target comes from; undefined where the launch refuses the selection anyway. */
export function organizationProviderOf(
  selection: AgentModelProvider,
  target: ModelProviderTarget | undefined
): AgentModelKeyProvider | undefined {
  try {
    return organizationModelProvider(selection, target)
  } catch {
    return undefined
  }
}

// The model's provider supplies the whole connection; ambient auth must never change its billing or endpoint.
export function applyOrganizationModelCredential(
  selection: AgentModelProvider,
  target: ModelProviderTarget | undefined,
  env: Record<string, string>,
  credential: ProviderCredential
): void {
  const provider = organizationModelProvider(selection, target)
  // These runtimes have no variable for extra request headers, and dropping one could change billing.
  if (isLaunchModelRuntime(target!.runtime) && Object.keys(credential.headers).length > 0)
    throw new Error(`Selected ${provider} credentials carry request headers this runtime cannot send`)
  const baseUrl = credential.endpoint ?? PROVIDER_KEY_PROFILES[provider].defaultEndpoint!
  applyModelCredential(target!, env, { key: credential.apiKey, baseUrl })
  if (target?.runtime === 'claude') {
    for (const name of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_IDENTITY_TOKEN',
      'ANTHROPIC_IDENTITY_TOKEN_FILE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY'
    ])
      env[name] = ''
    env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(credential.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n')
  } else if (target?.runtime === 'codex') {
    env.DEFAULT_AUTH_REQUEST = codexGatewayAuthRequest(baseUrl, credential.apiKey, credential.headers)
  } else if (isOpenCodeShaped(target)) {
    const configEnv = OPENCODE_CONFIG_ENV[target!.runtime as OpenCodeShapedKind]
    const config = objectFromJson(env[configEnv], configEnv)
    const providers = record(config.provider, `${configEnv}.provider`)
    const entry = record(providers[provider], `${configEnv}.provider`)
    const options = record(entry.options, `${configEnv}.provider.options`)
    env[configEnv] = JSON.stringify({
      ...config,
      enabled_providers: [provider],
      provider: { [provider]: { ...entry, options: { ...options, headers: credential.headers } } }
    })
  }
}

// The same connection through the credential proxy: the placeholder where the key goes, and no header values, which the proxy sets.
export function applyProxiedOrganizationModelCredential(
  selection: AgentModelProvider,
  target: ModelProviderTarget | undefined,
  env: Record<string, string>,
  credential: ProviderCredential,
  placeholder: string
): void {
  applyOrganizationModelCredential(selection, target, env, { ...credential, apiKey: placeholder, headers: {} })
}

/** The variables a launch carrying the real key changes to carry the placeholder instead, which a shim driver applies at spawn. */
export function proxiedOrganizationModelOverlay(
  selection: AgentModelProvider,
  target: ModelProviderTarget | undefined,
  env: Record<string, string>,
  credential: ProviderCredential,
  placeholder: string
): Record<string, string> {
  const real = { ...env }
  applyOrganizationModelCredential(selection, target, real, credential)
  const proxied = { ...env }
  applyProxiedOrganizationModelCredential(selection, target, proxied, credential, placeholder)
  return Object.fromEntries(Object.entries(proxied).filter(([name, value]) => real[name] !== value))
}

/** Where an organization Provider key is used: the configured endpoint, else the provider's default. */
export function organizationProviderEndpoint(provider: AgentModelKeyProvider, credential: ProviderCredential): URL {
  return new URL(credential.endpoint ?? PROVIDER_KEY_PROFILES[provider].defaultEndpoint!)
}
