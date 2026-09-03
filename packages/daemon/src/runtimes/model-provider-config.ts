import type { KeyProvider } from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../config/config-schema.js'
import type { Agent } from '../agents/agent-schema.js'
import { isClaudeRuntimeDef } from '../runtime-defs/claude-runtime.js'
import { sharedCredentialProfile } from './runtime-credentials.js'
import {
  codexConfigWithBaseUrl,
  codexConfigWithFloor,
  codexGatewayAuthRequest,
  objectFromJson,
  record
} from './codex-config.js'

export interface ModelCredential {
  key: string
  baseUrl?: string
}

/** Which runtime's own provider-configuration surface a credential must be written onto. */
export type ModelRuntimeKind = 'claude' | 'codex' | 'opencode' | 'deepseek'

export interface ModelProviderTarget {
  provider: KeyProvider
  runtime: ModelRuntimeKind
  opencodeProvider?: string
}

function isOpenCodeRuntime(runtimeId: string, runtime: RuntimeDef): boolean {
  if (runtimeId === 'opencode') return true
  return [runtime.command, ...runtime.args].some((part) => /(?:^|[\/@])opencode(?:@[^\/]*)?$/.test(part.toLowerCase()))
}

// The bin, not the package: `dsh-acp` is the single bin of @openma/deepseek-harness-acp.
function isDeepSeekRuntime(runtimeId: string, runtime: RuntimeDef): boolean {
  if (runtimeId === 'dsh-acp') return true
  return [runtime.command, ...runtime.args].some((part) => /(?:^|[\/@])dsh-acp(?:@[^\/]*)?$/.test(part.toLowerCase()))
}

function applyCodexBaseUrl(env: Record<string, string>, baseUrl: string): void {
  env.CODEX_CONFIG = codexConfigWithBaseUrl(env.CODEX_CONFIG, baseUrl)
  env.OPENAI_BASE_URL = baseUrl
}

export function modelProviderTarget(
  agent: Pick<Agent, 'runtime' | 'runtimeOverrides'>,
  runtime: RuntimeDef,
  effectiveModel = agent.runtimeOverrides?.model
): ModelProviderTarget | undefined {
  if (isClaudeRuntimeDef(runtime)) return { provider: 'anthropic', runtime: 'claude' }
  if (sharedCredentialProfile(agent.runtime, runtime) === 'codex') return { provider: 'openai', runtime: 'codex' }
  if (isDeepSeekRuntime(agent.runtime, runtime)) return { provider: 'deepseek', runtime: 'deepseek' }
  if (!isOpenCodeRuntime(agent.runtime, runtime)) return undefined

  const configuredProvider = effectiveModel?.includes('/') ? effectiveModel.split('/', 1)[0]?.trim() : undefined
  const opencodeProvider = configuredProvider || 'openai'
  return {
    provider: opencodeProvider === 'anthropic' ? 'anthropic' : 'openai',
    runtime: 'opencode',
    opencodeProvider
  }
}

// Translate the daemon-neutral model pair into the runtime's supported configuration surface.
export function applyModelCredential(
  target: ModelProviderTarget,
  env: Record<string, string>,
  credential: ModelCredential
): void {
  if (target.runtime === 'claude') {
    // The x-api-key slot, matching the other runtimes' same-slot shape: the sandbox shim's
    // per-variable AC_CLAUDE_API_KEY fill-in stays blocked, so exactly one credential travels.
    env.ANTHROPIC_API_KEY = credential.key
    delete env.ANTHROPIC_AUTH_TOKEN
    if (credential.baseUrl) env.ANTHROPIC_BASE_URL = credential.baseUrl
    return
  }

  if (target.runtime === 'deepseek') {
    env.DEEPSEEK_API_KEY = credential.key
    if (credential.baseUrl) env.DEEPSEEK_BASE_URL = credential.baseUrl
    return
  }

  if (target.runtime === 'codex') {
    env.OPENAI_API_KEY = credential.key
    // The key alone is not enough on a fresh CODEX_HOME: codex counts only an account (auth.json)
    // as authentication, and a default auth request is what lets codex-acp satisfy authRequired
    // itself. Every injected credential rides the GATEWAY method — process-ephemeral, so no
    // persisted account (any shape) can override this launch's grant and concurrent hosts share
    // no credential state. An endpoint-less key (a vault rotating real provider keys) carries NO
    // request from here: the pod's AC_CODEX_BASE_URL floor outranks the runtime default and only
    // the shim can see it, so the layer that knows the effective endpoint composes the request.
    if (!credential.baseUrl) return
    env.DEFAULT_AUTH_REQUEST = codexGatewayAuthRequest(credential.baseUrl, credential.key)
    // Kept beside the gateway method: an older codex-acp ignores an unknown methodId, and resumed
    // threads pinned to the built-in provider still route by CODEX_CONFIG's openai_base_url.
    applyCodexBaseUrl(env, credential.baseUrl)
    return
  }

  const providerId = target.opencodeProvider ?? 'openai'
  const config = objectFromJson(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT')
  const providers = record(config.provider, 'OPENCODE_CONFIG_CONTENT.provider')
  const provider = record(providers[providerId], `OPENCODE_CONFIG_CONTENT.provider.${providerId}`)
  const options = record(provider.options, `OPENCODE_CONFIG_CONTENT.provider.${providerId}.options`)
  env.MODEL_TOKEN = credential.key
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...config,
    provider: {
      ...providers,
      [providerId]: {
        ...provider,
        options: {
          ...options,
          apiKey: '{env:MODEL_TOKEN}',
          ...(credential.baseUrl ? { baseURL: credential.baseUrl } : {})
        }
      }
    }
  })
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

// One gateway, one variable per runtime: each runtime speaks its vendor's dialect at its own
// path, so the deployment composes the exact base each one needs and the daemon never guesses.
// OpenCode has no variable of its own — it selects a provider per model and takes the shared pair.
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
  if (configured.key) {
    applyModelCredential(target, env, configured)
    return
  }
  if (!configured.baseUrl) return
  if (target.runtime === 'claude') env.ANTHROPIC_BASE_URL = configured.baseUrl
  else if (target.runtime === 'deepseek') env.DEEPSEEK_BASE_URL = configured.baseUrl
  else if (target.runtime === 'codex') applyCodexBaseUrl(env, configured.baseUrl)
  else {
    const providerId = target.opencodeProvider ?? 'openai'
    const config = objectFromJson(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT')
    const providers = record(config.provider, 'OPENCODE_CONFIG_CONTENT.provider')
    const provider = record(providers[providerId], `OPENCODE_CONFIG_CONTENT.provider.${providerId}`)
    const options = record(provider.options, `OPENCODE_CONFIG_CONTENT.provider.${providerId}.options`)
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...config,
      provider: {
        ...providers,
        [providerId]: { ...provider, options: { ...options, baseURL: configured.baseUrl } }
      }
    })
  }
}
