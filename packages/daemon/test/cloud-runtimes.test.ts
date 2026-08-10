import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLOUD_RUNTIMES_ENV,
  cloudRuntimesPath,
  declaredRuntimeCatalog,
  loadCloudRuntimeTable
} from '../src/runtimes/cloud-runtimes.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ac-cloud-runtimes-'))
}

function write(dir: string, contents: string, name = 'cloud-runtimes.json'): string {
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

function catalog(): ResolvedRuntimeCatalog {
  const claude = { command: 'claude-code-acp', args: [], env: [] }
  const codex = { command: 'npx', args: ['-y', '@agentconnect.md/codex-acp'], env: [] }
  const hermes = { command: 'hermes', args: ['acp'], env: [] }
  return {
    entries: {
      claude: { runtime: claude, source: 'registry', name: 'Claude Code', version: '1.2.3', skillsAgentId: 'claude' },
      'codex-acp': { runtime: codex, source: 'managed', name: 'Codex', version: '', skillsAgentId: null },
      'hermes-agent': { runtime: hermes, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null }
    },
    runtimes: { claude, 'codex-acp': codex, 'hermes-agent': hermes }
  }
}

describe('cloud runtime table', () => {
  it('defaults under the daemon root and honors the env override', () => {
    const dir = root()
    expect(cloudRuntimesPath(dir, {})).toBe(join(dir, 'cloud-runtimes.json'))
    expect(cloudRuntimesPath(dir, { [CLOUD_RUNTIMES_ENV]: '/etc/ac/runtimes.json' })).toBe('/etc/ac/runtimes.json')
    // A blank override is not a path — fall back rather than reading "".
    expect(cloudRuntimesPath(dir, { [CLOUD_RUNTIMES_ENV]: '  ' })).toBe(join(dir, 'cloud-runtimes.json'))
  })

  it('returns undefined when no table is present', () => {
    expect(loadCloudRuntimeTable(root(), {})).toBeUndefined()
  })

  it('throws on malformed JSON and on a schema mismatch', () => {
    const dir = root()
    write(dir, '{ not json')
    expect(() => loadCloudRuntimeTable(dir, {})).toThrow(/not valid JSON/)
    write(dir, JSON.stringify({ runtimes: [] }))
    expect(() => loadCloudRuntimeTable(dir, {})).toThrow(/invalid/)
    write(dir, JSON.stringify({ runtimes: [{ version: '1' }] }))
    expect(() => loadCloudRuntimeTable(dir, {})).toThrow(/invalid/)
  })

  it('loads a valid table from the env-pointed path', () => {
    const dir = root()
    const path = write(dir, JSON.stringify({ runtimes: [{ id: 'claude', models: ['a'] }] }), 'pinned.json')
    expect(loadCloudRuntimeTable(dir, { [CLOUD_RUNTIMES_ENV]: path })).toEqual({
      runtimes: [{ id: 'claude', models: ['a'] }]
    })
  })
})

describe('declaredRuntimeCatalog', () => {
  it('keeps only declared runtimes and reports the image pin as their version', () => {
    const result = declaredRuntimeCatalog(catalog(), {
      runtimes: [{ id: 'claude', version: '9.9.9', models: ['sonnet', 'opus'] }]
    })
    expect(Object.keys(result.catalog.entries)).toEqual(['claude'])
    expect(result.catalog.entries.claude?.version).toBe('9.9.9')
    // Command/args still come from the resolved catalog — the table only declares presence.
    expect(result.catalog.runtimes.claude?.command).toBe('claude-code-acp')
    expect(result.models).toEqual({ claude: ['sonnet', 'opus'] })
    expect(result.unresolved).toEqual([])
  })

  it('leaves the catalog-declared version alone when the table omits one', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'claude' }] })
    expect(result.catalog.entries.claude?.version).toBe('1.2.3')
    expect(result.models).toEqual({})
  })

  it('reports declared ids the catalog does not know', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'claude' }, { id: 'ghost' }] })
    expect(result.unresolved).toEqual(['ghost'])
    expect(Object.keys(result.catalog.entries)).toEqual(['claude'])
  })

  it('drops curated runtimes, which cannot be admitted without a probe', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'hermes-agent' }] })
    expect(result.rejectedCurated).toEqual(['hermes-agent'])
    expect(result.catalog.entries).toEqual({})
  })

  it('flags declared runtimes that would fetch at launch time', () => {
    const result = declaredRuntimeCatalog(catalog(), { runtimes: [{ id: 'codex-acp' }] })
    expect(result.packageLaunchers).toEqual(['codex-acp'])
    // Still advertised — the image is expected to pre-install it; this is a warning, not a gate.
    expect(Object.keys(result.catalog.entries)).toEqual(['codex-acp'])
  })
})
