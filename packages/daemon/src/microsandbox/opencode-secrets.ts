import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import stripJsonComments from 'strip-json-comments'
import type { RuntimeDef } from '../config/config-schema.js'
import { objectFromJson } from '../runtimes/codex-config.js'
import { isOpenCodeRuntime } from '../runtimes/model-provider-config.js'
import { home as hostHome, runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

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

function readDocument(path: string, limit = MAX_SEED_FILE_BYTES): Record<string, unknown> {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > limit) throw new Error('invalid source')
    return document(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read the host OpenCode credential/configuration file')
  }
}

export function prepareOpenCodeSecrets(
  runtimeId: string,
  runtime: RuntimeDef | undefined,
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>
): MicrosandboxCredentials | undefined {
  if (!isOpenCodeRuntime(runtimeId, runtime)) return undefined
  const locations = runtimeStateLocations('opencode', hostEnv)
  const authLocation = locations.find((location) =>
    location.credentialFiles?.some((file) => file.format === 'opencode')
  )!
  const auth = readDocument(authLocation.source)
  const api = Object.entries(auth)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([provider, raw]) => {
      const value = object(raw)
      return value.type === 'api' && typeof value.key === 'string' && value.key.trim()
        ? [{ provider, key: value.key }]
        : []
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
    ...configFiles.map(({ source }) => readDocument(source)),
    document(env.OPENCODE_CONFIG_CONTENT ?? '{}')
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
  const needsCatalog = api.some(
    ({ provider }) => !object(providers[provider]?.options).baseURL && !DEFAULT_ORIGINS[provider]
  )
  const catalog = needsCatalog ? readDocument(catalogPath, 16 * 1024 * 1024) : {}
  const secrets = new Map<string, MicrosandboxSecret>()
  for (const { provider, key } of api) {
    const config = providers[provider] ?? {}
    const options = object(config.options)
    const known = object(catalog[provider])
    const endpoints = options.baseURL
      ? [options.baseURL]
      : [
          ...Object.values({ ...object(known.models), ...object(config.models) })
            .map((model) => object(object(model).provider).api)
            .filter(Boolean),
          known.api ?? DEFAULT_ORIGINS[provider]
        ].filter(Boolean)
    if (!endpoints.length) endpoints.push(undefined)
    const hosts = [
      ...new Set(
        endpoints.map((endpoint) => {
          try {
            if (typeof endpoint !== 'string') throw new Error('missing endpoint')
            const expanded = endpoint.replace(/\{env:([^}]+)\}/g, (_, name: string) => env[name] ?? '')
            const url = new URL(expanded)
            if (
              url.protocol !== 'https:' ||
              url.port ||
              url.username ||
              url.password ||
              !/^[a-z0-9.-]+$/.test(url.hostname)
            )
              throw new Error('unsupported endpoint')
            return url.hostname
          } catch {
            throw new Error(
              `OpenCode launch refused: configure a host provider.options.baseURL with a supported HTTPS endpoint for ${provider}`
            )
          }
        })
      )
    ].sort()
    const name = `OPENCODE_API_${createHash('sha256').update(provider).digest('hex').slice(0, 16).toUpperCase()}`
    secrets.set(provider, { env: name, placeholder: `msb-secret-${name}`, host: hosts, readValue: () => key })
  }
  const files = [{ source: authLocation.source, destination: authLocation.destination }, ...configFiles]
  const redact = (text: string): string => {
    for (const secret of secrets.values()) text = text.replaceAll(secret.readValue(), secret.placeholder)
    return text
  }
  const projectedConfig = (data: unknown): string =>
    JSON.stringify(data, (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value))
  return {
    secrets: [...secrets.values()],
    sources: [...files.map(({ source }) => source), ...(needsCatalog ? [catalogPath] : [])],
    seedExclusions: files.map(({ destination }) => destination),
    preparePrivateHome(home) {
      for (const file of files) {
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text) => {
          const data = document(text)
          if (file.source === authLocation.source) {
            for (const [provider, raw] of Object.entries(data)) {
              const value = object(raw)
              if (value.type !== 'api') continue
              const secret = secrets.get(provider)
              if (!secret)
                throw new Error('OpenCode private API credentials changed; log in on the host and start a new session')
              data[provider] = JSON.parse(projectedConfig({ ...value, key: secret.placeholder }))
            }
            return `${JSON.stringify(data)}\n`
          }
          return `${projectedConfig(data)}\n`
        })
      }
    }
  }
}
