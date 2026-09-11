import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import stripJsonComments from 'strip-json-comments'
import { objectFromJson } from '../runtimes/codex-config.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import { replaceSecretValue } from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

// Audited pi 0.85.1 built-ins; other providers require a host models.json HTTPS baseUrl.
const DEFAULT_ORIGINS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  deepseek: 'https://api.deepseek.com',
  google: 'https://generativelanguage.googleapis.com',
  xai: 'https://api.x.ai',
  openrouter: 'https://openrouter.ai',
  groq: 'https://api.groq.com',
  mistral: 'https://api.mistral.ai'
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function document(text: string, jsonc = false): Record<string, unknown> {
  text = text.replace(/^\uFEFF/, '')
  return objectFromJson(
    jsonc ? stripJsonComments(text, { trailingCommas: true }) : text,
    'pi credential/configuration file'
  )
}

function readDocument(path: string, jsonc = false): Record<string, unknown> {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return {}
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) throw new Error('invalid source')
    return document(readFileSync(path, 'utf8'), jsonc)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read the host pi credential/configuration file')
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function allowedHost(endpoint: unknown): string[] {
  try {
    if (typeof endpoint !== 'string') return []
    const url = new URL(endpoint)
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return [url.hostname]
  } catch {
    // Unresolved endpoints never authorize key injection.
  }
  return []
}

export function preparePiSecrets(hostEnv: NodeJS.ProcessEnv): MicrosandboxCredentials | undefined {
  const locations = runtimeStateLocations('pi-acp', hostEnv)
  const files = locations.flatMap((location) =>
    (location.seedFiles ?? ['']).map((path) => ({
      source: join(location.source, path),
      destination: join(location.destination, path),
      format: location.credentialFiles?.[0]?.format
    }))
  )
  const authFile = files.find((file) => file.format === 'pi')!
  const modelsFile = files.find((file) => file.format === 'pi-models')!
  const auth = readDocument(authFile.source)
  const providers = object(readDocument(modelsFile.source, true).providers)
  const bindings = new Map<string, MicrosandboxSecret>()
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  const replacements = new Map<string, string>()
  const add = (provider: string, kind: string, value: unknown, env?: unknown) => {
    const scopedEnv = object(env)
    if (!nonempty(value) && !Object.values(scopedEnv).some(nonempty)) return
    const name = `PI_API_${createHash('sha256').update(`${kind}:${provider}`).digest('hex').slice(0, 16).toUpperCase()}`
    const literal = nonempty(value) && !value.startsWith('!') && !value.includes('$') && !Object.keys(scopedEnv).length
    const config = object(providers[provider])
    const endpoints = [
      config.baseUrl ?? DEFAULT_ORIGINS[provider],
      ...(Array.isArray(config.models) ? config.models.map((model) => object(model).baseUrl) : [])
    ]
    const secret: MicrosandboxSecret = {
      env: name,
      placeholder: `msb-secret-${name}`,
      host: literal ? [...new Set(endpoints.flatMap(allowedHost))].sort() : [],
      readValue: () => (nonempty(value) ? value : '')
    }
    const shared = literal ? sharedKeys.get(value) : undefined
    if (shared) shared.host = [...new Set([shared.host, secret.host].flat())].sort()
    else if (literal) sharedKeys.set(value, secret)
    const binding = shared ?? secret
    bindings.set(`${kind}:${provider}`, binding)
    for (const raw of [value, ...Object.values(scopedEnv)]) {
      if (nonempty(raw)) replacements.set(raw, binding.placeholder)
    }
  }
  for (const [provider, raw] of Object.entries(auth).sort(([a], [b]) => a.localeCompare(b))) {
    const value = object(raw)
    if (value.type === 'api_key') add(provider, 'auth', value.key, value.env)
  }
  for (const [provider, raw] of Object.entries(providers).sort(([a], [b]) => a.localeCompare(b))) {
    add(provider, 'models', object(raw).apiKey)
  }
  if (!bindings.size) return undefined
  const project = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' ? replaceSecretValue(item, replacements) : item
    )
  return {
    secrets: [...sharedKeys.values()].filter((secret) => secret.host.length > 0),
    replacements,
    sources: files.map((file) => file.source),
    seedExclusions: files.map((file) => file.destination),
    preparePrivateHome(home) {
      for (const file of files) {
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text) => {
          const data = document(text, file.format === 'pi-models')
          if (file.format === 'pi') {
            for (const [provider, raw] of Object.entries(data)) {
              const value = object(raw)
              const binding = bindings.get(`auth:${provider}`)
              if (value.type === 'api_key' && binding) {
                data[provider] = { type: 'api_key', key: binding.placeholder }
              }
            }
          } else if (file.format === 'pi-models') {
            for (const [provider, raw] of Object.entries(object(data.providers))) {
              const value = object(raw)
              const binding = bindings.get(`models:${provider}`)
              if (binding && nonempty(value.apiKey)) value.apiKey = binding.placeholder
            }
          }
          return `${project(data)}\n`
        })
      }
    }
  }
}
