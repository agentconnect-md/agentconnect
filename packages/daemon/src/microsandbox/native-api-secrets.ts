import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { CODEX_DEFAULT_ENDPOINT, objectFromJson, record } from '../runtimes/codex-config.js'
import {
  resolveClaudeCredentialSources,
  resolveCodexCredentialSources
} from '../runtimes/runtime-credential-sources.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import { replaceSecretValue } from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

function readFile(path: string): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) throw new Error('invalid source')
    return readFileSync(path, 'utf8')
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

function fileCredential(
  name: string,
  key: string,
  endpoint: unknown,
  files: { source: string; destination: string; keys?: readonly string[]; toml?: boolean }[],
  field: string,
  shareNativeCredentials: boolean
): MicrosandboxCredentials {
  const secret: MicrosandboxSecret = {
    env: `AC_${name}_API_KEY`,
    placeholder: `msb-secret-AC_${name}_API_KEY`,
    host: allowedHost(endpoint),
    readValue: () => key
  }
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

export function prepareClaudeApiSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>
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
    explicitEnv.ANTHROPIC_BASE_URL ?? hostEnv.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    files,
    'primaryApiKey',
    existsSync(source.credentialFile)
  )
}

export function prepareCodexApiSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>
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
  let config: Record<string, unknown>
  try {
    config = parseToml(readFile(join(source.configDir, 'config.toml')) ?? '')
  } catch {
    throw new Error('Cannot read the host Codex configuration file')
  }
  const overrides = objectFromJson(explicitEnv.CODEX_CONFIG ?? hostEnv.CODEX_CONFIG, 'CODEX_CONFIG')
  const profile = overrides.profile ?? config.profile
  const profiles = record(config.profiles, 'Codex profiles')
  config = mergeConfig(
    mergeConfig(config, record(typeof profile === 'string' ? profiles[profile] : undefined, 'Codex profile')),
    overrides
  )
  const provider = config.model_provider ?? 'openai'
  const custom = record(record(config.model_providers, 'Codex providers')[String(provider)], 'Codex provider')
  const endpoint =
    provider === 'openai'
      ? (config.openai_base_url ?? CODEX_DEFAULT_ENDPOINT)
      : custom.requires_openai_auth === true
        ? custom.base_url
        : undefined
  return {
    ...fileCredential(
      'CODEX',
      key,
      endpoint,
      [
        { source: source.credentialFile, destination: join('.codex', 'auth.json') },
        { source: join(source.configDir, 'config.toml'), destination: join('.codex', 'config.toml'), toml: true }
      ],
      'OPENAI_API_KEY',
      false
    ),
    tlsTrustEnv: ['CODEX_CA_CERTIFICATE']
  }
}
