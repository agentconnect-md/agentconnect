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

function apiKeys(data: Record<string, unknown>): [string, string][] {
  return Object.entries(data).filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith('apiKey@') && typeof entry[1] === 'string' && Boolean(entry[1].trim())
  )
}

function allowedHost(name: string): string[] {
  try {
    const url = new URL(name.slice('apiKey@'.length))
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return [url.hostname]
  } catch {
    // Unresolved service addresses retain placeholders without authorizing key injection.
  }
  return []
}

export function prepareAmpSecrets(hostEnv: NodeJS.ProcessEnv): MicrosandboxCredentials | undefined {
  const locations = runtimeStateLocations('amp-acp', hostEnv)
  const auth = locations.find((location) => location.credentialFiles?.some((file) => file.format === 'amp'))!
  let data: Record<string, unknown>
  try {
    const stat = lstatSync(auth.source)
    if (stat.isSymbolicLink()) return undefined
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) throw new Error('invalid credential source')
    data = objectFromJson(readFileSync(auth.source, 'utf8'), 'Amp credential file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Cannot read the host Amp credential file')
  }
  const bindings = new Map<string, MicrosandboxSecret>()
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  const replacements = new Map<string, string>()
  for (const [name, value] of apiKeys(data).sort(([a], [b]) => a.localeCompare(b))) {
    const env = `AC_AMP_API_${createHash('sha256').update(name).digest('hex').slice(0, 16).toUpperCase()}`
    const secret = sharedKeys.get(value) ?? { env, placeholder: `msb-secret-${env}`, host: [], readValue: () => value }
    secret.host = [...new Set([secret.host, allowedHost(name)].flat())].sort()
    sharedKeys.set(value, secret)
    bindings.set(name, secret)
    replacements.set(value, secret.placeholder)
  }
  if (!bindings.size) return undefined
  const configs = [
    ...locations.filter((location) => location !== auth && location.source === hostEnv.AMP_SETTINGS_FILE),
    ...locations
      .filter((location) => location.destination === join('.config', 'amp'))
      .map((location) => ({
        source: join(location.source, 'settings.json'),
        destination: join(location.destination, 'settings.json')
      }))
  ]
  return {
    secrets: [...sharedKeys.values()].filter((secret) => secret.host.length > 0),
    replacements,
    sources: locations.map((location) => location.source),
    seedExclusions: [auth, ...configs].map((file) => file.destination),
    preparePrivateHome(home) {
      projectRuntimeHomeSeedFile(home, auth.destination, auth.source, (text, retained) => {
        const projected = objectFromJson(text, 'Amp credential file')
        const values = new Map(replacements)
        for (const [name, value] of apiKeys(projected)) {
          const binding = bindings.get(name)
          if (!retained && (!binding || value !== binding.readValue()))
            throw new Error('Host Amp credentials changed during preparation; retry launch')
          if (binding) {
            values.set(value, binding.placeholder)
            projected[name] = binding.placeholder
          }
        }
        return `${JSON.stringify(projected, (_name, value: unknown) =>
          typeof value === 'string' ? replaceSecretValue(value, values) : value
        )}\n`
      })
      for (const file of configs)
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text) => {
          const config = objectFromJson(stripJsonComments(text, { trailingCommas: true }), 'Amp settings file')
          return `${JSON.stringify(config, (_name, value: unknown) =>
            typeof value === 'string' ? replaceSecretValue(value, replacements) : value
          )}\n`
        })
    }
  }
}
