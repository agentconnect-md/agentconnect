import type { KeyProvider } from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../config/config-schema.js'
import type { Agent } from '../agents/agent-schema.js'
import { isClaudeRuntimeDef } from '../runtime-defs/claude-runtime.js'
import { sharedCredentialProfile } from './runtime-credentials.js'
import { codexConfigWithBaseUrl, objectFromJson, record } from './codex-config.js'

export interface ModelCredential {
  key: string
  baseUrl?: string
}

export interface ModelProviderTarget {
  provider: KeyProvider
  runtime: 'claude' | 'codex' | 'opencode'
  opencodeProvider?: string
}

function isOpenCodeRuntime(runtimeId: string, runtime: RuntimeDef): boolean {
  if (runtimeId === 'opencode') return true
  return [runtime.command, ...runtime.args].some((part) => /(?:^|[\/@])opencode(?:@[^\/]*)?$/.test(part.toLowerCase()))
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
    env.ANTHROPIC_AUTH_TOKEN = credential.key
    delete env.ANTHROPIC_API_KEY
    if (credential.baseUrl) env.ANTHROPIC_BASE_URL = credential.baseUrl
    return
  }

  if (target.runtime === 'codex') {
    env.OPENAI_API_KEY = credential.key
    if (!credential.baseUrl) return
    // codex-acp projects CODEX_CONFIG into config.toml; OPENAI_BASE_URL preserves older-adapter compatibility.
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

export function configuredModelCredential(env: NodeJS.ProcessEnv): ModelCredential | undefined {
  const key = env.MODEL_TOKEN?.trim()
  const baseUrl = env.MODEL_BASE_URL?.trim()
  if (!key && !baseUrl) return undefined
  if (baseUrl && (!URL.canParse(baseUrl) || !['http:', 'https:'].includes(new URL(baseUrl).protocol))) {
    throw new Error('MODEL_BASE_URL must be an http(s) URL')
  }
  // A URL-only layer uses an internal empty sentinel; applyStaticModelConfig preserves the runtime key.
  return { key: key ?? '', ...(baseUrl ? { baseUrl } : {}) }
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
