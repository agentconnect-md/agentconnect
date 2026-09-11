import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import stripJsonComments from 'strip-json-comments'
import { parse as parseYaml } from 'yaml'
import { runtimeStateLocations } from './probe.js'

export const MAX_SEED_FILE_BYTES = 2 * 1024 * 1024

export interface SeededCredentialFile {
  /** Relative to the state source; an empty path denotes an exact-file source. */
  path: string
  format:
    | 'grok'
    | 'grok-config'
    | 'pi'
    | 'pi-models'
    | 'opencode'
    | 'oauth'
    | 'claude-oauth'
    | 'hermes'
    | 'dsh'
    | 'dsh-env'
    | 'auggie'
    | 'cline'
    | 'amp'
    | 'qwen-settings'
    | 'devin'
    | 'copilot'
  provider?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function grokConfigApiKeys(data: unknown, path: string[] = []): { path: string[]; value: string }[] {
  return Object.entries(data && typeof data === 'object' ? data : {}).flatMap(([field, value]) => {
    const next = [...path, field]
    if (field === 'api_key' && nonempty(value)) return [{ path: next, value }]
    return grokConfigApiKeys(value, next)
  })
}

const QWEN_DEFAULT_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'vertex-ai': 'GOOGLE_API_KEY'
}

export function qwenSettingsApiKeys(data: unknown) {
  const settings = record(data) ?? {}
  const env = record(settings.env) ?? {}
  const protocols = record(settings.providerProtocol) ?? {}
  const providers = record(settings.modelProviders) ?? {}
  const auth = record(record(settings.security)?.auth) ?? {}
  const refs: { path: string[]; value: string; provider: string; endpoints: unknown[] }[] = []
  for (const [provider, raw] of Object.entries(providers)) {
    if (!Array.isArray(raw)) continue
    const protocol = QWEN_DEFAULT_KEYS[provider] ? provider : String(protocols[provider] ?? '')
    for (const entry of raw) {
      const model = record(entry) ?? {}
      const name = model.envKey ?? QWEN_DEFAULT_KEYS[protocol]
      if (!nonempty(model.id) || !nonempty(name) || !nonempty(env[name])) continue
      refs.push({
        path: ['env', name],
        value: env[name],
        provider,
        endpoints: QWEN_DEFAULT_KEYS[protocol] ? [model.baseUrl] : []
      })
    }
  }
  const selected = nonempty(auth.selectedType) ? auth.selectedType : ''
  const defaultKey = QWEN_DEFAULT_KEYS[selected]
  if (defaultKey && nonempty(env[defaultKey])) {
    refs.push({ path: ['env', defaultKey], value: env[defaultKey], provider: selected, endpoints: [auth.baseUrl] })
  }
  if (nonempty(auth.apiKey)) {
    const models = Object.entries(providers).flatMap(([provider, entries]) =>
      (provider === selected || protocols[provider] === selected) && Array.isArray(entries) ? entries : []
    )
    refs.push({
      path: ['security', 'auth', 'apiKey'],
      value: auth.apiKey,
      provider: selected,
      endpoints: QWEN_DEFAULT_KEYS[selected]
        ? [auth.baseUrl, ...models.filter((model) => !record(model)?.envKey).map((model) => record(model)?.baseUrl)]
        : []
    })
  }
  return refs
}

function oauth(value: Record<string, unknown>): boolean {
  return (
    typeof value.access === 'string' &&
    typeof value.refresh === 'string' &&
    (nonempty(value.access) || nonempty(value.refresh)) &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires)
  )
}

function credentialProviders(data: unknown, format: SeededCredentialFile['format']): string[] {
  const entries = record(data)
  if (!entries) return []
  return Object.entries(entries).flatMap(([provider, raw]) => {
    const value = record(raw)
    if (!provider || !value) return []
    if (format === 'grok') {
      const issuerScope =
        nonempty(value.oidc_issuer) && nonempty(value.oidc_client_id)
          ? `${value.oidc_issuer.replace(/\/+$/, '')}::${value.oidc_client_id}`
          : undefined
      const knownScope =
        provider === 'xai::api_key' || provider === 'https://accounts.x.ai/sign-in' || provider === issuerScope
      return knownScope &&
        nonempty(value.key) &&
        ['web_login', 'grok', 'oidc', 'external', 'api_key'].includes(String(value.auth_mode))
        ? ['xai']
        : []
    }
    if (value.type === 'oauth') return oauth(value) ? [provider] : []
    if (format === 'pi') {
      const env = record(value.env)
      return value.type === 'api_key' && (nonempty(value.key) || (env && Object.values(env).some(nonempty)))
        ? [provider]
        : []
    }
    if (value.type === 'api' && nonempty(value.key)) return [provider]
    if (value.type === 'wellknown' && typeof value.key === 'string' && nonempty(value.token)) return [provider]
    return []
  })
}

const DSH_PROVIDER_REFS: Record<string, string> = {
  DEEPSEEK_API_KEY: 'deepseek',
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  GEMINI_API_KEY: 'google',
  GOOGLE_API_KEY: 'google',
  XAI_API_KEY: 'xai',
  OPENROUTER_API_KEY: 'openrouter'
}

export function parseDshCredentialDocument(text: string, format: 'dsh' | 'dsh-env') {
  const data = record(format === 'dsh' ? parseYaml(text) : parseEnv(text)) ?? {}
  const refs = Object.fromEntries(
    Object.entries(record(data.version === 1 ? data.refs : data) ?? {}).filter(
      (entry): entry is [string, string] => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && nonempty(entry[1])
    )
  )
  return { data, refs, records: record(data.records) ?? {} }
}

function hermesCredentialProviders(data: unknown): string[] {
  const auth = record(data) ?? {}
  const hasToken = (raw: unknown): boolean => {
    const value = record(raw) ?? {}
    return nonempty(value.access_token) || nonempty(value.refresh_token) || nonempty(value.agent_key)
  }
  const providers = Object.entries(record(auth.credential_pool) ?? {}).flatMap(([provider, entries]) =>
    provider && Array.isArray(entries) && entries.some(hasToken) ? [provider] : []
  )
  const singletons = record(auth.providers) ?? {}
  for (const provider of ['nous', 'openai-codex', 'xai-oauth', 'qwen-oauth', 'minimax-oauth']) {
    const value = record(singletons[provider])
    if (hasToken(value) || hasToken(value?.tokens)) providers.push(provider)
  }
  return providers
}

function credentialsInFile(text: string, file: SeededCredentialFile): { present: boolean; providers: string[] } {
  if (file.format === 'grok-config') {
    const present = grokConfigApiKeys(parseToml(text)).some(
      ({ path }) =>
        (path.length === 3 && path[0] === 'model') ||
        (path.length === 5 && path[0] === 'version_overrides' && path[2] === 'model')
    )
    return { present, providers: present ? ['xai'] : [] }
  }
  if (file.format === 'devin') {
    const present = nonempty(parseToml(text).windsurf_api_key)
    return { present, providers: present ? ['devin'] : [] }
  }
  if (file.format === 'dsh' || file.format === 'dsh-env') {
    const { refs, records } = parseDshCredentialDocument(text, file.format)
    const providers = Object.keys(refs).flatMap((name) => (DSH_PROVIDER_REFS[name] ? [DSH_PROVIDER_REFS[name]!] : []))
    for (const [name, raw] of Object.entries(records)) {
      const value = record(raw)
      const env = record(value?.env)
      if (
        name.startsWith('llm-pi-ai/') &&
        value &&
        ((value.kind === 'api-key' && (nonempty(value.key) || (env && Object.values(env).some(nonempty)))) ||
          (value.kind === 'grant' && oauth(record(value.payload) ?? {})))
      ) {
        providers.push(name.slice('llm-pi-ai/'.length))
      }
    }
    return { present: providers.length > 0, providers }
  }
  const json = text.replace(/^\uFEFF/, '')
  const data: unknown = JSON.parse(
    file.format === 'copilot' || file.format === 'qwen-settings' || file.format === 'pi-models'
      ? stripJsonComments(json, { trailingCommas: file.format === 'pi-models' })
      : json
  )
  if (file.format === 'pi-models') {
    const providers = Object.entries(record(record(data)?.providers) ?? {}).flatMap(([provider, value]) =>
      provider && nonempty(record(value)?.apiKey) ? [provider] : []
    )
    return { present: providers.length > 0, providers }
  }
  if (file.format === 'copilot') {
    const present = Object.entries(record(record(data)?.copilotTokens) ?? {}).some(
      ([account, token]) => nonempty(account) && nonempty(token)
    )
    return { present, providers: present ? ['github-copilot'] : [] }
  }
  if (file.format === 'qwen-settings') {
    const providers = qwenSettingsApiKeys(data)
      .map((ref) => ref.provider)
      .filter(nonempty)
    return { present: providers.length > 0, providers: [...new Set(providers)] }
  }
  if (file.format === 'auggie') {
    const value = record(data) ?? {}
    const present = nonempty(value.accessToken) && nonempty(value.tenantURL) && Array.isArray(value.scopes)
    return { present, providers: present ? ['augment'] : [] }
  }
  if (file.format === 'amp') {
    const present = Object.entries(record(data) ?? {}).some(([key, value]) => {
      if (!key.startsWith('apiKey@') || !nonempty(value)) return false
      try {
        return ['https:', 'http:'].includes(new URL(key.slice('apiKey@'.length)).protocol)
      } catch {
        return false
      }
    })
    return { present, providers: present ? ['amp'] : [] }
  }
  if (file.format === 'cline') {
    const stored = record(data) ?? {}
    const providers =
      stored.version === 1
        ? Object.values(record(stored.providers) ?? {}).flatMap((entry) => {
            const settings = record(record(entry)?.settings) ?? {}
            const auth = record(settings.auth) ?? {}
            const aws = record(settings.aws) ?? {}
            return nonempty(settings.provider) &&
              (nonempty(settings.apiKey) ||
                nonempty(auth.apiKey) ||
                nonempty(auth.accessToken) ||
                nonempty(auth.refreshToken) ||
                (nonempty(aws.accessKey) && nonempty(aws.secretKey)))
              ? [settings.provider]
              : []
          })
        : []
    return { present: providers.length > 0, providers }
  }
  if (file.format === 'oauth' || file.format === 'claude-oauth') {
    const value = record(data)
    const camelCase = file.format === 'claude-oauth'
    const present =
      !!value &&
      (nonempty(value[camelCase ? 'accessToken' : 'access_token']) ||
        nonempty(value[camelCase ? 'refreshToken' : 'refresh_token']))
    return { present, providers: present && file.provider ? [file.provider] : [] }
  }
  const providers = file.format === 'hermes' ? hermesCredentialProviders(data) : credentialProviders(data, file.format)
  return { present: providers.length > 0, providers }
}

/** Enumerate stored credentials without resolving keys, refreshing tokens, or exposing their values. */
export function discoverSeededRuntimeCredentials(
  runtimeId: string,
  env: NodeJS.ProcessEnv
): { paths: string[]; providers: string[] } {
  const paths = new Set<string>()
  const providers = new Set<string>()
  for (const location of runtimeStateLocations(runtimeId, env)) {
    for (const file of location.credentialFiles ?? []) {
      const source = join(location.source, file.path)
      try {
        const stat = lstatSync(source)
        if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) continue
        const found = credentialsInFile(readFileSync(source, 'utf8'), file)
        if (!found.present) continue
        paths.add(source)
        for (const provider of found.providers) providers.add(provider)
      } catch {
        // Unreadable or malformed login state is not a discoverable credential source.
      }
    }
  }
  return { paths: [...paths], providers: [...providers] }
}
