import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import stripJsonComments from 'strip-json-comments'
import { objectFromJson } from '../runtimes/codex-config.js'
import { openCodeConfigWithKeys, openCodeHostKeys } from '../runtimes/opencode-host-keys.js'
import { OPENCODE_CONFIG_ENV, PROVIDER_DEFAULT_ENDPOINTS } from '../runtimes/provider-endpoints.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'
import {
  microsandboxPlaceholder,
  replaceSecretValue,
  type SecretPlaceholder,
  type SecretSources
} from './secret-values.js'

// A provider without a configured base URL reaches its SDK's default origin.
const DEFAULT_ORIGINS: Record<string, string> = {
  opencode: 'https://opencode.ai',
  'opencode-go': 'https://opencode.ai',
  ...PROVIDER_DEFAULT_ENDPOINTS,
  google: 'https://generativelanguage.googleapis.com',
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
  return objectFromJson(stripJsonComments(text, { trailingCommas: true }), 'OpenCode configuration file')
}

function readDocument(path: string): Record<string, unknown> {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return {}
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) throw new Error('invalid source')
    return document(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read the host OpenCode configuration file')
  }
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

/** A provider's endpoints across configs in either shape: its base URL, else its models' own APIs and its default origin. */
function providerEndpoints(configs: readonly Record<string, unknown>[], provider: string): unknown[] {
  const entries = configs.flatMap((config) => [
    object(object(config.provider)[provider]),
    object(object(config.providers)[provider])
  ])
  const baseUrl = entries
    .map((entry) => object(entry.options).baseURL ?? object(entry.settings).baseURL)
    .filter(Boolean)
    .at(-1)
  if (baseUrl) return [baseUrl]
  const models = entries.flatMap((entry) => Object.values(object(entry.models)))
  return [...models.map((model) => object(object(model).provider).api), DEFAULT_ORIGINS[provider]].filter(Boolean)
}

export function prepareOpenCodeSecrets(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder = microsandboxPlaceholder,
  sources: SecretSources = {}
): MicrosandboxCredentials | undefined {
  const keys = openCodeHostKeys(hostEnv, sources.openCodeAuthExport)
  if (!keys.length) return undefined
  const configFiles = runtimeStateLocations('opencode', hostEnv).flatMap((location) =>
    ['opencode.json', 'opencode.jsonc'].map((file) => ({
      source: join(location.source, file),
      destination: join(location.destination, file)
    }))
  )
  const env = { ...hostEnv, ...explicitEnv }
  const configs = [
    ...configFiles.map(({ source }) => readDocument(source)),
    objectFromJson(env[OPENCODE_CONFIG_ENV.opencode], OPENCODE_CONFIG_ENV.opencode)
  ]
  // Providers signed in with one key share its binding, which reaches all their hosts under the first one's variable.
  const groups = new Map<string, { providers: string[]; env: string; hosts: Set<string> }>()
  for (const { provider, env: name, key } of keys) {
    const hosts = providerEndpoints(configs, provider)
      .map((endpoint) => allowedHost(endpoint, env))
      .filter((host) => host !== undefined)
    const group = groups.get(key) ?? { providers: [], env: name, hosts: new Set<string>() }
    group.providers.push(provider)
    for (const host of hosts) group.hosts.add(host)
    groups.set(key, group)
  }
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  for (const [key, group] of groups) {
    const hosts = [...group.hosts].sort()
    const provider = group.providers[0]!
    const origin = DEFAULT_ORIGINS[provider]
    const secret: MicrosandboxSecret = {
      env: group.env,
      placeholder: placeholder({
        env: group.env,
        provider,
        hosts,
        ...(origin ? { defaultHost: new URL(origin).hostname } : {})
      }),
      host: hosts,
      readValue: () => key
    }
    sharedKeys.set(key, secret)
  }
  const secrets = new Map(keys.map(({ provider, key }) => [provider, sharedKeys.get(key)!]))
  const bindings = [...sharedKeys.values()].filter((secret) => secret.host.length > 0)
  const bound = [...secrets].filter(([, secret]) => bindings.includes(secret))
  const replacements = new Map([...sharedKeys.values()].map((secret) => [secret.readValue(), secret.placeholder]))
  return {
    secrets: bindings,
    replacements,
    sources: configFiles.map(({ source }) => source),
    seedExclusions: configFiles.map(({ destination }) => destination),
    preparePrivateHome(home) {
      for (const file of configFiles) {
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text) => {
          const data = document(text)
          const projected = JSON.stringify(data, (_key, value: unknown) =>
            typeof value === 'string' ? replaceSecretValue(value, replacements) : value
          )
          return `${projected}\n`
        })
      }
    },
    // Each bound provider reads its key from the variable that holds its placeholder, which the proxy swaps on its hosts.
    prepareEnv(launchEnv) {
      launchEnv[OPENCODE_CONFIG_ENV.opencode] = openCodeConfigWithKeys(
        launchEnv[OPENCODE_CONFIG_ENV.opencode],
        bound.map(([provider, secret]) => ({ provider, env: secret.env }))
      )
    }
  }
}
