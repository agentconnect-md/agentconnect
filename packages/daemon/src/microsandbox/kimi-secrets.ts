import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { readRegularFileSync } from '../fs/regular-file.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { isRuntimeHomeSeedFile, projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { fileConfigApiKeys, MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import { PROVIDER_DEFAULT_ENDPOINTS } from '../runtimes/provider-endpoints.js'
import {
  endpointHost,
  microsandboxPlaceholder,
  placeSecrets,
  protectedCopyValue,
  replaceSecretValue,
  type KeyOwner,
  type SecretPlaceholder
} from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function document(text: string): Record<string, unknown> {
  try {
    return parseToml(text)
  } catch {
    throw new Error('Cannot parse Kimi API configuration')
  }
}

function allowedHost(endpoint: unknown): string[] {
  try {
    if (typeof endpoint !== 'string' || endpoint.includes('$')) return []
    const url = new URL(endpoint)
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return [url.hostname]
  } catch {
    // Unsupported routes keep placeholders without authorizing injection.
  }
  return []
}

function replaceValues(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replaceSecretValue(value, replacements)
  if (Array.isArray(value)) return value.map((item) => replaceValues(item, replacements))
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValues(item, replacements)]))
  return value
}

function setPath(data: Record<string, unknown>, path: readonly string[], value: string): void {
  const parent = path.slice(0, -1).reduce((node, field) => record(node[field]), data)
  parent[path.at(-1)!] = value
}

function replaceSeedText(text: string, replacements: ReadonlyMap<string, string>): string {
  for (const [value, placeholder] of replacements) {
    text = text.split(JSON.stringify(value).slice(1, -1)).join(placeholder).split(value).join(placeholder)
  }
  return text
}

// The provider types whose own API host is known; a Kimi key reaches only the base URL its provider names.
const DEFAULT_HOSTS: Record<string, string | undefined> = {
  openai: endpointHost(PROVIDER_DEFAULT_ENDPOINTS.openai),
  openai_responses: endpointHost(PROVIDER_DEFAULT_ENDPOINTS.openai),
  anthropic: endpointHost(PROVIDER_DEFAULT_ENDPOINTS.anthropic),
  'google-genai': 'generativelanguage.googleapis.com'
}

export function prepareKimiSecrets(
  hostEnv: NodeJS.ProcessEnv,
  _explicitEnv: Record<string, string> = {},
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  const files = new Map<string, { source: string; destination: string }>()
  for (const location of runtimeStateLocations('kimi', hostEnv)) {
    try {
      if (!lstatSync(location.source).isDirectory()) continue
      for (const entry of readdirSync(location.source, { withFileTypes: true })) {
        if (!entry.isFile() || !isRuntimeHomeSeedFile(entry.name)) continue
        const destination = join(location.destination, entry.name)
        if (!files.has(destination)) files.set(destination, { source: join(location.source, entry.name), destination })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot inspect host Kimi configuration')
    }
  }
  const config = files.get(join('.kimi-code', 'config.toml'))
  if (!config) return undefined
  let data: Record<string, unknown>
  try {
    data = document(readRegularFileSync(config.source, MAX_SEED_FILE_BYTES).toString('utf8'))
  } catch {
    throw new Error('Cannot read host Kimi API configuration')
  }
  const bindings = new Map<string, MicrosandboxSecret>()
  const shared = new Map<string, MicrosandboxSecret>()
  const owners = new Map<MicrosandboxSecret, KeyOwner>()
  const values: [string, MicrosandboxSecret][] = []
  for (const { path, value } of fileConfigApiKeys(data)) {
    const id = JSON.stringify(path)
    const env = `AC_KIMI_API_${createHash('sha256').update(id).digest('hex').slice(0, 16).toUpperCase()}`
    const provider = record(record(data.providers)[path[1]!])
    const host =
      path.length === 3 &&
      path[0] === 'providers' &&
      ['kimi', 'openai', 'openai_responses', 'anthropic', 'google-genai'].includes(String(provider.type)) &&
      !provider.oauth &&
      !provider.api_key_env &&
      !provider.source &&
      !value.includes('$')
        ? allowedHost(provider.base_url)
        : []
    const known = shared.get(value)
    const secret = known ?? { env, placeholder: '', host: [], readValue: () => value }
    const type = String(provider.type)
    if (!known)
      owners.set(secret, {
        provider: type,
        defaultHost: Object.hasOwn(DEFAULT_HOSTS, type) ? DEFAULT_HOSTS[type] : undefined
      })
    secret.host = [...new Set([secret.host, host].flat())].sort()
    shared.set(value, secret)
    bindings.set(id, secret)
    values.push([value, secret])
  }
  if (!bindings.size) return undefined
  const replacements = placeSecrets(owners, values, placeholder)
  return {
    secrets: [...shared.values()].filter((secret) => secret.host.length > 0),
    replacements,
    sources: [...files.values()].map((file) => file.source),
    seedExclusions: [...files.keys()],
    preparePrivateHome(home) {
      for (const file of files.values()) {
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text, retained) => {
          if (file.destination !== config.destination) return replaceSeedText(text, replacements)
          const projected = document(text)
          for (const { path, value } of fileConfigApiKeys(projected)) {
            const next = protectedCopyValue(
              value,
              bindings.get(JSON.stringify(path)),
              retained,
              'Host Kimi API credentials changed; retry launch'
            )
            if (next !== undefined) setPath(projected, path, next)
          }
          return stringifyToml(replaceValues(projected, replacements) as Record<string, unknown>)
        })
      }
    }
  }
}
