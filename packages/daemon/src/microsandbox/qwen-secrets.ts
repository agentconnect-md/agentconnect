import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import stripJsonComments from 'strip-json-comments'
import { objectFromJson } from '../runtimes/codex-config.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES, qwenSettingsApiKeys } from '../runtimes/runtime-seeded-credentials.js'
import { replaceSecretValue } from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

function document(text: string, settings: boolean): unknown {
  try {
    return settings
      ? objectFromJson(stripJsonComments(text.replace(/^\uFEFF/, '')), 'Qwen settings file')
      : JSON.parse(text)
  } catch {
    throw new Error('Cannot read the Qwen credential/configuration file')
  }
}

function readSettings(source: string): Record<string, unknown> {
  try {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) return {}
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) throw new Error('invalid source')
    return document(readFileSync(source, 'utf8'), true) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read the host Qwen settings file')
  }
}

function allowedHost(endpoint: unknown): string[] {
  try {
    if (typeof endpoint !== 'string' || endpoint.includes('$')) return []
    const url = new URL(endpoint)
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return [url.hostname]
  } catch {
    // Unresolved routes keep placeholders without authorizing key injection.
  }
  return []
}

export function prepareQwenSecrets(hostEnv: NodeJS.ProcessEnv): MicrosandboxCredentials | undefined {
  const files = runtimeStateLocations('qwen-code', hostEnv).flatMap((location) =>
    [...(location.seedFiles ?? []), ...(location.credentialFiles ?? []).map((file) => file.path)].map((path) => ({
      source: join(location.source, path),
      destination: join(location.destination, path),
      settings: path === 'settings.json'
    }))
  )
  const settingsFile = files.find((file) => file.settings)!
  const bindings = new Map<string, MicrosandboxSecret>()
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  const replacements = new Map<string, string>()
  for (const ref of qwenSettingsApiKeys(readSettings(settingsFile.source))) {
    const id = JSON.stringify(ref.path)
    const name = `AC_QWEN_API_${createHash('sha256').update(id).digest('hex').slice(0, 16).toUpperCase()}`
    const secret = sharedKeys.get(ref.value) ?? {
      env: name,
      placeholder: `msb-secret-${name}`,
      host: [],
      readValue: () => ref.value
    }
    secret.host = [
      ...new Set([secret.host, ref.value.includes('$') ? [] : ref.endpoints.flatMap(allowedHost)].flat())
    ].sort()
    sharedKeys.set(ref.value, secret)
    bindings.set(id, secret)
    replacements.set(ref.value, secret.placeholder)
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
          if (!file.destination.endsWith('.json')) return replaceSecretValue(text, replacements)
          const data = document(text, file.settings)
          if (file.settings) {
            for (const ref of qwenSettingsApiKeys(data)) {
              const binding = bindings.get(JSON.stringify(ref.path))
              if (!retained && !binding)
                throw new Error('Host Qwen credentials changed during preparation; retry launch')
            }
            for (const [id, binding] of bindings) {
              const path = JSON.parse(id) as string[]
              const parent = path
                .slice(0, -1)
                .reduce<unknown>(
                  (value, field) =>
                    value && typeof value === 'object' ? (value as Record<string, unknown>)[field] : undefined,
                  data
                )
              if (parent && typeof parent === 'object' && Object.hasOwn(parent, path.at(-1)!)) {
                const target = parent as Record<string, unknown>
                target[path.at(-1)!] = binding.placeholder
              }
            }
          }
          return `${JSON.stringify(data, (_key, value: unknown) =>
            typeof value === 'string' ? replaceSecretValue(value, replacements) : value
          )}\n`
        })
      }
    }
  }
}
