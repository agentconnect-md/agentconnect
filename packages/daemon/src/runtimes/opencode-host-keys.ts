import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { objectFromJson, record } from './codex-config.js'

/** One API key the host's OpenCode is signed in with, and the launch variable that carries it. */
export interface OpenCodeHostKey {
  provider: string
  env: string
  key: string
}

/** Runs the host's `opencode auth export` and returns its stdout. */
export type OpenCodeAuthExport = (env: NodeJS.ProcessEnv) => string

const EXPORT_TIMEOUT_MS = 15_000
const ASYNC_EXPORT_TIMEOUT_MS = 10_000
const EXPORT_MAX_BUFFER = 1024 * 1024
const PROVIDER_ID = /^[A-Za-z0-9._-]+$/

// --standalone runs a private server that exits with the command, so no background service is left on the host.
const runAuthExport: OpenCodeAuthExport = (env) =>
  execFileSync('opencode', ['auth', 'export', '--standalone'], {
    env,
    encoding: 'utf8',
    timeout: EXPORT_TIMEOUT_MS,
    maxBuffer: EXPORT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  })

/** The same export without blocking the daemon, for a resolution the credential proxy awaits; any failure prints nothing. */
export function openCodeAuthExportAsync(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      'opencode',
      ['auth', 'export', '--standalone'],
      { env, encoding: 'utf8', timeout: ASYNC_EXPORT_TIMEOUT_MS, maxBuffer: EXPORT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => resolve(error ? '' : stdout)
    )
    child.stdin?.end()
  })
}

/** The variable for one provider's key, hashed so a provider id never becomes part of a variable name. */
export function openCodeKeyEnv(provider: string): string {
  return `OPENCODE_API_${createHash('sha256').update(provider).digest('hex').slice(0, 16).toUpperCase()}`
}

/** The active API keys of the host's OpenCode sign-ins; OAuth and external sign-ins stay on the host, and any failure means none. */
export function openCodeHostKeys(
  hostEnv: NodeJS.ProcessEnv,
  run: OpenCodeAuthExport = runAuthExport
): OpenCodeHostKey[] {
  let entries: unknown
  try {
    entries = JSON.parse(run(hostEnv))
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  const keys = new Map<string, OpenCodeHostKey>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const { integrationID: provider, active, value } = entry as Record<string, unknown>
    if (active !== true || typeof provider !== 'string' || !PROVIDER_ID.test(provider) || keys.has(provider)) continue
    const { type, key } = (value ?? {}) as Record<string, unknown>
    if (type !== 'key' || typeof key !== 'string' || !key.trim()) continue
    keys.set(provider, { provider, env: openCodeKeyEnv(provider), key })
  }
  return [...keys.values()].sort((a, b) => a.provider.localeCompare(b.provider))
}

function providerApiKey(config: Record<string, unknown>, provider: string): unknown {
  const v1 = record(record(config.provider, 'provider')[provider], `provider.${provider}`)
  const v2 = record(record(config.providers, 'providers')[provider], `providers.${provider}`)
  return (
    record(v1.options, `provider.${provider}.options`).apiKey ??
    record(v2.settings, `providers.${provider}.settings`).apiKey
  )
}

/** Point each key's provider at its variable in `OPENCODE_CONFIG_CONTENT`, leaving a provider whose key the launch already sets. */
export function openCodeConfigWithKeys(
  raw: string | undefined,
  keys: readonly Pick<OpenCodeHostKey, 'provider' | 'env'>[]
): string {
  const config = objectFromJson(raw, 'OPENCODE_CONFIG_CONTENT')
  const providers = { ...record(config.provider, 'OPENCODE_CONFIG_CONTENT.provider') }
  for (const { provider, env } of keys) {
    if (providerApiKey(config, provider) !== undefined) continue
    const entry = record(providers[provider], `OPENCODE_CONFIG_CONTENT.provider.${provider}`)
    const options = record(entry.options, `OPENCODE_CONFIG_CONTENT.provider.${provider}.options`)
    providers[provider] = { ...entry, options: { ...options, apiKey: `{env:${env}}` } }
  }
  return JSON.stringify(Object.keys(providers).length ? { ...config, provider: providers } : config)
}

/** Give a private-HOME launch the host's OpenCode API keys: each in its own variable, referenced from the config. */
export function applyOpenCodeHostKeys(env: Record<string, string>, keys: readonly OpenCodeHostKey[]): void {
  if (!keys.length) return
  env.OPENCODE_CONFIG_CONTENT = openCodeConfigWithKeys(env.OPENCODE_CONFIG_CONTENT, keys)
  for (const { env: name, key } of keys) env[name] = key
}
