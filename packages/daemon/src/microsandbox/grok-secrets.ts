import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { objectFromJson } from '../runtimes/codex-config.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { grokConfigApiKeys, MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import { replaceSecretValue } from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function document(text: string, toml: boolean): Record<string, unknown> {
  try {
    return toml ? parseToml(text) : objectFromJson(text, 'Grok credential file')
  } catch {
    throw new Error('Cannot read the Grok credential/configuration file')
  }
}

function readDocument(source: string, toml: boolean): Record<string, unknown> {
  try {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) return {}
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) throw new Error('invalid source')
    return document(readFileSync(source, 'utf8'), toml)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read the host Grok credential/configuration file')
  }
}

function allowedHost(endpoint: unknown): string[] {
  try {
    if (typeof endpoint !== 'string' || endpoint.includes('$')) return []
    const url = new URL(endpoint)
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return [url.hostname]
  } catch {
    // Only an explicit host model route authorizes key injection.
  }
  return []
}

function apiKeys(data: Record<string, unknown>, toml: boolean) {
  if (toml) return grokConfigApiKeys(data)
  return Object.entries(data).flatMap(([scope, raw]) => {
    const auth = object(raw)
    return auth.auth_mode === 'api_key' && typeof auth.key === 'string' && auth.key.trim()
      ? [{ path: [scope, 'key'], value: auth.key }]
      : []
  })
}

function replaceValues(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replaceSecretValue(value, replacements)
  if (Array.isArray(value)) return value.map((item) => replaceValues(item, replacements))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValues(item, replacements)]))
  }
  return value
}

export function prepareGrokSecrets(hostEnv: NodeJS.ProcessEnv): MicrosandboxCredentials | undefined {
  const files = runtimeStateLocations('grok-build', hostEnv).flatMap((location) =>
    (location.credentialFiles ?? []).map((file) => ({
      source: join(location.source, file.path),
      destination: join(location.destination, file.path),
      toml: file.format === 'grok-config'
    }))
  )
  const bindings = new Map<string, MicrosandboxSecret>()
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  const replacements = new Map<string, string>()
  const id = (destination: string, path: string[]) => JSON.stringify([destination, ...path])
  for (const file of files) {
    const data = readDocument(file.source, file.toml)
    for (const { path, value } of apiKeys(data, file.toml)) {
      const bindingId = id(file.destination, path)
      const name = `AC_GROK_API_${createHash('sha256').update(bindingId).digest('hex').slice(0, 16).toUpperCase()}`
      const model = object(object(data.model)[path[1]!])
      const host =
        file.destination === join('.grok', 'config.toml') &&
        path.length === 3 &&
        path[0] === 'model' &&
        !value.includes('$')
          ? allowedHost(model.base_url)
          : []
      const secret = sharedKeys.get(value) ?? {
        env: name,
        placeholder: `msb-secret-${name}`,
        host: [],
        readValue: () => value
      }
      secret.host = [...new Set([secret.host, host].flat())].sort()
      sharedKeys.set(value, secret)
      bindings.set(bindingId, secret)
      replacements.set(value, secret.placeholder)
    }
  }
  if (!bindings.size) return undefined
  return {
    secrets: [...sharedKeys.values()].filter((secret) => secret.host.length > 0),
    replacements,
    sources: files.map((file) => file.source),
    seedExclusions: files.map((file) => file.destination),
    preparePrivateHome(home) {
      for (const file of files) {
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text, retained) => {
          const data = document(text, file.toml)
          const values = new Map(replacements)
          const keys = apiKeys(data, file.toml).map((entry) => ({
            ...entry,
            binding: bindings.get(id(file.destination, entry.path))
          }))
          for (const { value, binding } of keys) {
            if (!retained && !binding) throw new Error('Host Grok credentials changed during preparation; retry launch')
            if (binding) values.set(value, binding.placeholder)
          }
          const projected = replaceValues(data, values) as Record<string, unknown>
          for (const { path, binding } of keys) {
            if (!binding) continue
            const parent = path
              .slice(0, -1)
              .reduce((value, field) => value[field] as Record<string, unknown>, projected)
            parent[path.at(-1)!] = binding.placeholder
          }
          return file.toml ? stringifyToml(projected) : `${JSON.stringify(projected)}\n`
        })
      }
    }
  }
}
