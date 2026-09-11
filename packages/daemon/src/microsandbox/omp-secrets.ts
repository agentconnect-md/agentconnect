import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { extractOmpCredentials, readOmpApiCredentials } from '../runtimes/omp-credentials.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { withDescentSync } from '../shim/safe-descent.js'
import { replaceSecretValue } from './secret-values.js'
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
const PLACEHOLDER = /^msb-secret-AC_OMP_API_[A-F0-9]{16}$/
const MAX_RETAINED_BYTES = 256 * 1024 * 1024

// Inspect a private copy: SQLite must never resolve guest-controlled journal paths on the host.
function checkRetainedDatabase(parent: string, bindings: ReadonlyMap<string, MicrosandboxSecret>): boolean {
  const temporary = mkdtempSync(join(tmpdir(), 'ac-omp-retained-'))
  let bytes = 0
  try {
    for (const suffix of ['', '-wal']) {
      let input: number
      try {
        input = openSync(
          join(parent, `agent.db${suffix}`),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!suffix) {
          for (const sidecar of ['-wal', '-shm', '-journal']) {
            try {
              lstatSync(join(parent, `agent.db${sidecar}`))
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
              throw error
            }
            throw new Error('orphaned private database sidecar')
          }
          return false
        }
        continue
      }
      try {
        const stat = fstatSync(input)
        bytes += stat.size
        if (!stat.isFile() || bytes > MAX_RETAINED_BYTES) throw new Error('invalid private database')
        const output = openSync(join(temporary, `agent.db${suffix}`), 'wx', 0o600)
        try {
          const chunk = Buffer.alloc(64 * 1024)
          let offset = 0
          while (offset < stat.size) {
            const count = readSync(input, chunk, 0, Math.min(chunk.length, stat.size - offset), offset)
            if (!count) throw new Error('private database changed during inspection')
            let written = 0
            while (written < count) written += writeSync(output, chunk, written, count - written)
            offset += count
          }
          if (readSync(input, chunk, 0, 1, offset)) throw new Error('private database grew during inspection')
        } finally {
          closeSync(output)
        }
      } finally {
        closeSync(input)
      }
    }
    for (const row of readOmpApiCredentials(join(temporary, 'agent.db'))) {
      const binding = bindings.get(`${row.id}:${row.provider}`)
      if (!PLACEHOLDER.test(row.key) || (binding && row.key !== binding.placeholder))
        throw new Error('unprotected or changed private credentials')
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

export function prepareOmpSecrets(hostEnv: NodeJS.ProcessEnv): MicrosandboxCredentials | undefined {
  const location = runtimeStateLocations('omp', hostEnv)[0]!
  const source = join(location.source, 'agent.db')
  const rows = readOmpApiCredentials(source)
  if (!rows.length) return undefined
  const bindings = new Map<string, MicrosandboxSecret>()
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  const replacements = new Map<string, string>()
  for (const row of rows.sort((a, b) => a.id - b.id)) {
    const id = `${row.id}:${row.provider}`
    const env = `AC_OMP_API_${createHash('sha256').update(id).digest('hex').slice(0, 16).toUpperCase()}`
    const secret = sharedKeys.get(row.key) ?? {
      env,
      placeholder: `msb-secret-${env}`,
      host: [],
      readValue: () => row.key
    }
    const host =
      Object.hasOwn(HOSTS, row.provider) && !row.key.startsWith('!') && !row.key.includes('$')
        ? [HOSTS[row.provider]!]
        : []
    secret.host = [...new Set([secret.host, host].flat())].sort()
    bindings.set(id, secret)
    sharedKeys.set(row.key, secret)
    replacements.set(row.key, secret.placeholder)
  }
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
              const binding = bindings.get(`${row.id}:${row.provider}`)
              if (typeof key === 'string' && key.trim() && (!binding || key !== binding.readValue()))
                throw new Error('changed source')
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
