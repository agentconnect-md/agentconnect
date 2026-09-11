import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import stripJsonComments from 'strip-json-comments'
import { objectFromJson } from '../runtimes/codex-config.js'
import { home as hostHome, runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'
import { replaceSecretValue } from './secret-values.js'

// Native SDK defaults can omit api from OpenCode's provider catalog; common defaults also work before cache warmup.
const DEFAULT_ORIGINS: Record<string, string> = {
  opencode: 'https://opencode.ai',
  'opencode-go': 'https://opencode.ai',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai',
  xai: 'https://api.x.ai',
  groq: 'https://api.groq.com',
  mistral: 'https://api.mistral.ai',
  cohere: 'https://api.cohere.com'
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function document(text: string): Record<string, unknown> {
  return objectFromJson(stripJsonComments(text, { trailingCommas: true }), 'OpenCode credential/configuration file')
}

function readDocument(path: string, jsonc = false, limit = MAX_SEED_FILE_BYTES): Record<string, unknown> {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return {}
    if (!stat.isFile() || stat.size > limit) throw new Error('invalid source')
    const text = readFileSync(path, 'utf8')
    return jsonc ? document(text) : objectFromJson(text, 'OpenCode credential/catalog file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read the host OpenCode credential/configuration file')
  }
}

function apiKey(value: Record<string, unknown>): string | undefined {
  return value.type === 'api' && typeof value.key === 'string' && value.key.trim() ? value.key : undefined
}

function allowedHost(endpoint: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof endpoint !== 'string') return undefined
  try {
    const url = new URL(endpoint.replace(/\{env:([^}]+)\}/g, (_, name: string) => env[name] ?? ''))
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return url.hostname
  } catch {
    // Unresolved providers keep placeholders without authorizing the host-side key.
  }
  return undefined
}

export function prepareOpenCodeSecrets(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>
): MicrosandboxCredentials | undefined {
  const locations = runtimeStateLocations('opencode', hostEnv)
  const authLocation = locations.find((location) =>
    location.credentialFiles?.some((file) => file.format === 'opencode')
  )!
  const auth = readDocument(authLocation.source)
  const api = Object.entries(auth)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([provider, raw]) => {
      const key = apiKey(object(raw))
      return key === undefined ? [] : [{ provider, key }]
    })
  if (!api.length) return undefined
  const configFiles = locations
    .filter((location) => !location.credentialFiles?.length)
    .flatMap((location) =>
      [
        ...(location.destination === join('.config', 'opencode') ? ['config.json'] : []),
        'opencode.json',
        'opencode.jsonc'
      ].map((file) => ({
        source: join(location.source, file),
        destination: join(location.destination, file)
      }))
    )
  const providers: Record<string, Record<string, unknown>> = {}
  const env = { ...hostEnv, ...explicitEnv }
  const configs = [
    ...configFiles.map(({ source }) => readDocument(source, true)),
    objectFromJson(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT')
  ]
  for (const config of configs) {
    for (const [id, raw] of Object.entries(object(config.provider))) {
      const value = object(raw)
      const previous = providers[id]
      providers[id] = {
        ...previous,
        ...value,
        options: { ...object(previous?.options), ...object(value.options) },
        models: { ...object(previous?.models), ...object(value.models) }
      }
    }
  }
  const catalogPath = join(hostEnv.XDG_CACHE_HOME || join(hostHome(hostEnv), '.cache'), 'opencode', 'models.json')
  const usesCatalog = (provider: string) => !object(providers[provider]?.options).baseURL && !DEFAULT_ORIGINS[provider]
  const needsCatalog = api.some(({ provider }) => usesCatalog(provider))
  let catalog: Record<string, unknown> = {}
  if (needsCatalog) {
    try {
      catalog = readDocument(catalogPath, false, 16 * 1024 * 1024)
    } catch {
      // An unusable cache cannot prevent providers with configured or default origins from starting.
    }
  }
  const secrets = new Map<string, MicrosandboxSecret>()
  for (const { provider, key } of api) {
    const config = providers[provider] ?? {}
    const options = object(config.options)
    const known = usesCatalog(provider) ? object(catalog[provider]) : {}
    const endpoints = options.baseURL
      ? [options.baseURL]
      : [
          ...Object.values({ ...object(known.models), ...object(config.models) })
            .map((model) => object(object(model).provider).api)
            .filter(Boolean),
          known.api ?? DEFAULT_ORIGINS[provider]
        ].filter(Boolean)
    const hosts = [
      ...new Set(endpoints.map((endpoint) => allowedHost(endpoint, env)).filter((host) => host !== undefined))
    ].sort()
    const name = `OPENCODE_API_${createHash('sha256').update(provider).digest('hex').slice(0, 16).toUpperCase()}`
    secrets.set(provider, { env: name, placeholder: `msb-secret-${name}`, host: hosts, readValue: () => key })
  }
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  for (const [provider, secret] of secrets) {
    const shared = sharedKeys.get(secret.readValue())
    if (shared) {
      shared.host = [...new Set([shared.host, secret.host].flat())].sort()
      secrets.set(provider, shared)
    } else sharedKeys.set(secret.readValue(), secret)
  }
  const bindings = [...sharedKeys.values()]
  const files = [{ source: authLocation.source, destination: authLocation.destination }, ...configFiles]
  const replacements = new Map(bindings.map((secret) => [secret.readValue(), secret.placeholder]))
  const projectedConfig = (data: unknown): string =>
    JSON.stringify(data, (_key, value: unknown) =>
      typeof value === 'string' ? replaceSecretValue(value, replacements) : value
    )
  return {
    secrets: bindings.filter((secret) => secret.host.length > 0),
    replacements,
    sources: [...files.map(({ source }) => source), ...(needsCatalog ? [catalogPath] : [])],
    seedExclusions: files.map(({ destination }) => destination),
    preparePrivateHome(home) {
      for (const file of files) {
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text) => {
          const data = document(text)
          if (file.source === authLocation.source) {
            for (const [provider, raw] of Object.entries(data)) {
              const value = object(raw)
              if (apiKey(value) === undefined) continue
              const secret = secrets.get(provider)
              data[provider] = JSON.parse(projectedConfig(secret ? { ...value, key: secret.placeholder } : value))
            }
            return `${JSON.stringify(data)}\n`
          }
          return `${projectedConfig(data)}\n`
        })
      }
    }
  }
}
