import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  copyOmpDatabase,
  extractOmpCredentials,
  installOmpDatabase,
  readOmpApiCredentials,
  rewriteOmpApiKeys,
  type OmpApiCredential
} from '../runtimes/omp-credentials.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { withDescentSync } from '../shim/safe-descent.js'
import {
  microsandboxPlaceholder,
  placeSecrets,
  protectedCopyValue,
  replaceSecretValue,
  type KeyOwner,
  type SecretPlaceholder
} from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

// OMP 18.1.17 bundled providers; custom model files are not part of the existing native HOME seed.
const HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  deepseek: 'api.deepseek.com',
  google: 'generativelanguage.googleapis.com',
  xai: 'api.x.ai',
  openrouter: 'openrouter.ai',
  groq: 'api.groq.com',
  mistral: 'api.mistral.ai'
}

// Inspect a private copy: SQLite must never resolve guest-controlled journal paths on the host.
function checkRetainedDatabase(parent: string, bindings: ReadonlyMap<string, MicrosandboxSecret>): boolean {
  const temporary = mkdtempSync(join(tmpdir(), 'ac-omp-retained-'))
  try {
    if (!copyOmpDatabase(parent, temporary)) return false
    const copy = join(temporary, 'agent.db')
    const stale: [OmpApiCredential, string][] = []
    for (const row of readOmpApiCredentials(copy)) {
      // A bound row takes its placeholder whatever it holds; an unbound one is left as it is.
      const next = bindings.get(`${row.id}:${row.provider}`)?.placeholder
      if (next !== undefined && next !== row.key) stale.push([row, next])
    }
    if (stale.length > 0) {
      rewriteOmpApiKeys(copy, stale)
      installOmpDatabase(copy, parent)
    }
    return true
  } catch {
    throw new Error(
      'Cannot reuse the OMP private credential database safely; start a new session. Existing data has been retained.'
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function prepareOmpSecrets(
  hostEnv: NodeJS.ProcessEnv,
  _explicitEnv: Record<string, string> = {},
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  const location = runtimeStateLocations('omp', hostEnv)[0]!
  const source = join(location.source, 'agent.db')
  const rows = readOmpApiCredentials(source)
  if (!rows.length) return undefined
  const bindings = new Map<string, MicrosandboxSecret>()
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  const owners = new Map<MicrosandboxSecret, KeyOwner>()
  const values: [string, MicrosandboxSecret][] = []
  for (const row of rows.sort((a, b) => a.id - b.id)) {
    const id = `${row.id}:${row.provider}`
    const env = `AC_OMP_API_${createHash('sha256').update(id).digest('hex').slice(0, 16).toUpperCase()}`
    const known = sharedKeys.get(row.key)
    const secret = known ?? { env, placeholder: '', host: [], readValue: () => row.key }
    const defaultHost = Object.hasOwn(HOSTS, row.provider) ? HOSTS[row.provider] : undefined
    if (!known) owners.set(secret, { provider: row.provider, defaultHost })
    const host = defaultHost && !row.key.startsWith('!') && !row.key.includes('$') ? [defaultHost] : []
    secret.host = [...new Set([secret.host, host].flat())].sort()
    bindings.set(id, secret)
    sharedKeys.set(row.key, secret)
    values.push([row.key, secret])
  }
  const replacements = placeSecrets(owners, values, placeholder)
  const project = (value: unknown): string =>
    JSON.stringify(value, (_name, entry: unknown) =>
      typeof entry === 'string' ? replaceSecretValue(entry, replacements) : entry
    )
  return {
    secrets: [...sharedKeys.values()].filter((secret) => secret.host.length > 0),
    replacements,
    sources: [
      location.source,
      ...['agent.db', 'agent.db-wal', 'agent.db-shm', 'agent.db-journal', ...(location.seedFiles ?? [])].map((file) =>
        join(location.source, file)
      )
    ],
    seedExclusions: [
      join(location.destination, 'agent.db'),
      ...(location.seedFiles ?? []).map((file) => join(location.destination, file))
    ],
    preparePrivateHome(home) {
      withDescentSync(home, location.destination.split('/'), (parent) => {
        if (checkRetainedDatabase(parent, bindings)) return
        extractOmpCredentials(source, join(parent, 'agent.db'), (row) => {
          try {
            const data: unknown = JSON.parse(String(row.data))
            if (row.credential_type === 'api_key') {
              const key = (data as { key?: unknown })?.key
              if (typeof key === 'string' && key.trim())
                protectedCopyValue(key, bindings.get(`${row.id}:${row.provider}`), false, 'changed source')
            }
            return { ...row, data: project(data) }
          } catch {
            throw new Error('Host OMP credentials changed or could not be projected; retry launch')
          }
        })
      })
      for (const file of location.seedFiles ?? []) {
        projectRuntimeHomeSeedFile(home, join(location.destination, file), join(location.source, file), (text) => {
          try {
            return stringifyYaml(JSON.parse(project(parseYaml(text))))
          } catch {
            throw new Error('Cannot project the OMP configuration file')
          }
        })
      }
    }
  }
}
