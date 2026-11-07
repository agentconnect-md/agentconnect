import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { readRegularFileSync } from '../fs/regular-file.js'
import { objectFromJson, record } from '../runtimes/codex-config.js'
import {
  COPILOT_PROVIDER_TYPE_ENV,
  GEMINI_KEY_VARIABLES,
  hostCodexEndpoint,
  hostKeyEndpoint,
  PROVIDER_DEFAULT_ENDPOINTS,
  RUNTIME_KEY_VARIABLES
} from '../runtimes/provider-endpoints.js'
import {
  resolveClaudeCredentialSources,
  resolveCodexCredentialSources
} from '../runtimes/runtime-credential-sources.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import {
  microsandboxPlaceholder,
  replaceSecretValue,
  type SecretPlaceholder,
  type SecretSources
} from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

function readFile(path: string): string | undefined {
  try {
    return readRegularFileSync(path, MAX_SEED_FILE_BYTES, { followSymlinks: true }).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Cannot read the host runtime API credential/configuration file')
  }
}

function document(text: string | undefined): Record<string, unknown> {
  return objectFromJson(text, 'Runtime API credential file')
}

function allowedHost(endpoint: unknown): string[] {
  try {
    if (typeof endpoint !== 'string') return []
    const url = new URL(endpoint)
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return [url.hostname]
  } catch {
    // Unsupported endpoints retain placeholders without authorizing the host-side key.
  }
  return []
}

function replaceValues(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replaceSecretValue(value, replacements)
  if (Array.isArray(value)) return value.map((item) => replaceValues(item, replacements))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValues(item, replacements)]))
  }
  return value
}

function mergeConfig(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
        ? mergeConfig(record(result[key], 'Codex configuration table'), value as Record<string, unknown>)
        : value
  }
  return result
}

/** Which provider a runtime's own key belongs to, and that provider's API host. */
interface KeyProvider {
  provider: string
  defaultHost?: string
}

const ANTHROPIC: KeyProvider = {
  provider: 'anthropic',
  defaultHost: new URL(PROVIDER_DEFAULT_ENDPOINTS.anthropic!).hostname
}
const OPENAI: KeyProvider = { provider: 'openai', defaultHost: new URL(PROVIDER_DEFAULT_ENDPOINTS.openai!).hostname }
const GOOGLE: KeyProvider = { provider: 'google', defaultHost: new URL(PROVIDER_DEFAULT_ENDPOINTS.google!).hostname }

function boundSecret(
  env: string,
  key: string,
  endpoint: unknown,
  owner: KeyProvider,
  placeholder: SecretPlaceholder
): MicrosandboxSecret {
  const host = allowedHost(endpoint)
  return { env, placeholder: placeholder({ env, ...owner, hosts: host }), host, readValue: () => key }
}

function fileCredential(
  name: string,
  key: string,
  endpoint: unknown,
  files: { source: string; destination: string; keys?: readonly string[]; toml?: boolean }[],
  field: string,
  shareNativeCredentials: boolean,
  owner: KeyProvider,
  placeholder: SecretPlaceholder
): MicrosandboxCredentials {
  const secret = boundSecret(`AC_${name}_API_KEY`, key, endpoint, owner, placeholder)
  const replacements = new Map([[key, secret.placeholder]])
  files = files.map((file) => ({ ...file, source: existsSync(file.source) ? realpathSync(file.source) : file.source }))
  return {
    secrets: secret.host.length ? [secret] : [],
    replacements,
    sources: files.map(({ source }) => source),
    seedExclusions: files.map(({ destination }) => destination),
    shareNativeCredentials,
    preparePrivateHome(home) {
      for (const file of files) {
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text, retained) => {
          let data: Record<string, unknown>
          try {
            data = file.toml ? parseToml(text) : document(text)
          } catch {
            throw new Error('Cannot protect the runtime API credential/configuration file')
          }
          if (Object.hasOwn(data, field)) data[field] = secret.placeholder
          const projected =
            file.keys && !retained
              ? Object.fromEntries(Object.entries(data).filter(([key]) => file.keys!.includes(key)))
              : data
          const replaced = replaceValues(projected, replacements) as Record<string, unknown>
          return file.toml ? stringifyToml(replaced) : `${JSON.stringify(replaced)}\n`
        })
      }
    }
  }
}

function claudeEndpoint(hostEnv: NodeJS.ProcessEnv, explicitEnv: Record<string, string>): string | undefined {
  return hostKeyEndpoint('claude', RUNTIME_KEY_VARIABLES.claude.anthropic.key, { ...hostEnv, ...explicitEnv })?.endpoint
}

/** A key the launch env holds in this variable, bound to the endpoint the runtime sends it to; files are left as they are. */
function variableCredential(
  env: string,
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  endpoint: () => unknown,
  owner: KeyProvider,
  placeholder: SecretPlaceholder
): MicrosandboxCredentials | undefined {
  const key = (explicitEnv[env] ?? hostEnv[env])?.trim()
  if (!key) return undefined
  const secret = boundSecret(env, key, endpoint(), owner, placeholder)
  return {
    secrets: [secret],
    replacements: new Map([[key, secret.placeholder]]),
    sources: [],
    seedExclusions: [],
    preparePrivateHome: () => undefined
  }
}

/** `COPILOT_PROVIDER_API_KEY` in the launch env, at the base URL Copilot requires beside it for a provider of its own. */
export function prepareCopilotEnvSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  const variables = RUNTIME_KEY_VARIABLES.copilot.openai
  const read = (name: string) => explicitEnv[name] ?? hostEnv[name]
  const provider = read(COPILOT_PROVIDER_TYPE_ENV)?.trim() || 'openai'
  const fallback = Object.hasOwn(PROVIDER_DEFAULT_ENDPOINTS, provider)
    ? PROVIDER_DEFAULT_ENDPOINTS[provider]
    : undefined
  return variableCredential(
    variables.key,
    hostEnv,
    explicitEnv,
    () => read(variables.base),
    { provider, ...(fallback ? { defaultHost: new URL(fallback).hostname } : {}) },
    placeholder
  )
}

/** `GEMINI_API_KEY` in the launch env, at Antigravity's Gemini endpoint. */
export function prepareAntigravityEnvSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  const base = explicitEnv[GEMINI_KEY_VARIABLES.base] ?? hostEnv[GEMINI_KEY_VARIABLES.base]
  return variableCredential(
    GEMINI_KEY_VARIABLES.key,
    hostEnv,
    explicitEnv,
    () => base ?? PROVIDER_DEFAULT_ENDPOINTS.google,
    GOOGLE,
    placeholder
  )
}

/** `ANTHROPIC_API_KEY` in the launch env, at Claude's endpoint. */
export function prepareClaudeEnvSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  return variableCredential(
    RUNTIME_KEY_VARIABLES.claude.anthropic.key,
    hostEnv,
    explicitEnv,
    () => claudeEndpoint(hostEnv, explicitEnv),
    ANTHROPIC,
    placeholder
  )
}

export function prepareClaudeApiSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  const source = resolveClaudeCredentialSources(hostEnv)
  const key = document(readFile(source.globalConfigFile)).primaryApiKey
  if (typeof key !== 'string' || !key.trim()) return undefined
  const files = runtimeStateLocations('claude-acp', hostEnv).flatMap((location) =>
    location.seedJsonKeys?.includes('primaryApiKey')
      ? (location.seedFiles ?? ['']).map((file) => ({
          source: join(location.source, file),
          destination: join(location.destination, file),
          keys: location.seedJsonKeys
        }))
      : []
  )
  return fileCredential(
    'CLAUDE',
    key,
    claudeEndpoint(hostEnv, explicitEnv),
    files,
    'primaryApiKey',
    existsSync(source.credentialFile),
    ANTHROPIC,
    placeholder
  )
}

/** Codex's configuration as the host launch reads it: the config file, its active profile, then `CODEX_CONFIG`. */
function codexConfig(hostEnv: NodeJS.ProcessEnv, explicitEnv: Record<string, string>): Record<string, unknown> {
  const source = resolveCodexCredentialSources(hostEnv)
  let config: Record<string, unknown>
  try {
    config = parseToml(readFile(join(source.configDir, 'config.toml')) ?? '')
  } catch {
    throw new Error('Cannot read the host Codex configuration file')
  }
  const overrides = objectFromJson(explicitEnv.CODEX_CONFIG ?? hostEnv.CODEX_CONFIG, 'CODEX_CONFIG')
  const profile = overrides.profile ?? config.profile
  const profiles = record(config.profiles, 'Codex profiles')
  return mergeConfig(
    mergeConfig(config, record(typeof profile === 'string' ? profiles[profile] : undefined, 'Codex profile')),
    overrides
  )
}

/** `OPENAI_API_KEY` in the launch env, where its file key goes; beside `OPENAI_BASE_URL` the host's own Codex leaves it unbound. */
export function prepareCodexEnvSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder = microsandboxPlaceholder,
  sources: SecretSources = {}
): MicrosandboxCredentials | undefined {
  const name = RUNTIME_KEY_VARIABLES.codex.openai.key
  const config = () => codexConfig(hostEnv, explicitEnv)
  const credential = variableCredential(
    name,
    hostEnv,
    explicitEnv,
    () =>
      (sources.hostRuntime
        ? hostKeyEndpoint('codex', name, { ...hostEnv, ...explicitEnv }, config)
        : hostCodexEndpoint(config())
      )?.endpoint,
    OPENAI,
    placeholder
  )
  return credential && { ...credential, tlsTrustEnv: ['CODEX_CA_CERTIFICATE'] }
}

export function prepareCodexApiSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  const source = resolveCodexCredentialSources(hostEnv)
  const auth = document(readFile(source.credentialFile))
  const key = auth.OPENAI_API_KEY
  if (typeof key !== 'string' || !key.trim()) return undefined
  if (
    (auth.auth_mode && auth.auth_mode !== 'apikey') ||
    auth.personal_access_token ||
    auth.bedrock_api_key ||
    auth.bedrock_access_keys
  ) {
    throw new Error('Codex launch refused: combined API key and non-API authentication cannot be safely shared')
  }
  return {
    ...fileCredential(
      'CODEX',
      key,
      hostCodexEndpoint(codexConfig(hostEnv, explicitEnv))?.endpoint,
      [
        { source: source.credentialFile, destination: join('.codex', 'auth.json') },
        { source: join(source.configDir, 'config.toml'), destination: join('.codex', 'config.toml'), toml: true }
      ],
      'OPENAI_API_KEY',
      false,
      OPENAI,
      placeholder
    ),
    tlsTrustEnv: ['CODEX_CA_CERTIFICATE']
  }
}
