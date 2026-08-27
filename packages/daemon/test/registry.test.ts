import { describe, it, expect } from 'vitest'
import {
  toRuntimeDef,
  platformKey,
  RegistryEntry,
  fetchRegistry,
  resolveRuntimes,
  cachedRuntimeNames,
  resolveRuntimeCatalog
} from '../src/runtimes/registry.js'
import { CURATED_RUNTIME_CATALOG } from '../src/runtimes/curated.js'
import { MANAGED_RUNTIME_CATALOG } from '../src/runtimes/managed.js'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const npxEntry: RegistryEntry = {
  id: 'claude-acp',
  name: 'Claude Agent',
  version: '0.51.0',
  distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.51.0', args: [] } }
}
const uvxEntry: RegistryEntry = {
  id: 'fast-agent',
  name: 'fast-agent',
  version: '0.7.21',
  distribution: { uvx: { package: 'fast-agent-acp==0.7.21', args: ['-x'] } }
}
const gemini: RegistryEntry = {
  id: 'gemini',
  name: 'Gemini CLI',
  version: '0.47.0',
  distribution: { npx: { package: '@google/gemini-cli@0.47.0', args: ['--acp'] } }
}

describe('toRuntimeDef', () => {
  it('maps an npx entry to npx -y <package> with version locked', () => {
    expect(toRuntimeDef(npxEntry)).toEqual({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp@0.51.0'],
      env: []
    })
  })
  it('appends npx distribution args', () => {
    expect(toRuntimeDef(gemini)).toEqual({
      command: 'npx',
      args: ['-y', '@google/gemini-cli@0.47.0', '--acp'],
      env: []
    })
  })
  it('maps a uvx entry', () => {
    expect(toRuntimeDef(uvxEntry)).toEqual({
      command: 'uvx',
      args: ['fast-agent-acp==0.7.21', '-x'],
      env: []
    })
  })
  it('maps a binary entry for the current platform', () => {
    const plat = platformKey()
    if (!plat) throw new Error('platformKey() returned null on this platform')
    const entry: RegistryEntry = {
      id: 'goose',
      name: 'goose',
      version: '1.38.0',
      distribution: { binary: { [plat]: { archive: 'http://x', cmd: './goose', args: ['acp'], env: { FOO: 'bar' } } } }
    }
    expect(toRuntimeDef(entry)).toEqual({
      command: './goose',
      args: ['acp'],
      env: [{ name: 'FOO', value: 'bar' }]
    })
  })
  it('returns null when binary has no entry for the current platform', () => {
    const entry: RegistryEntry = {
      id: 'x',
      name: 'x',
      version: '1',
      distribution: { binary: { 'solaris-sparc': { archive: 'h', cmd: './x', args: [], env: {} } } }
    }
    expect(toRuntimeDef(entry)).toBeNull()
  })
})

const REG = {
  agents: {
    'claude-acp': { id: 'claude-acp', name: 'Claude', version: '1', distribution: { npx: { package: 'p@1' } } }
  }
}

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'ac-reg-'))
}

describe('fetchRegistry', () => {
  it('fetches 200, returns doc, and writes body + cache validators', async () => {
    const root = tmpRoot()
    const fetchImpl = (async () =>
      new Response(JSON.stringify(REG), {
        status: 200,
        headers: { etag: 'W/"abc"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' }
      })) as unknown as typeof fetch
    const doc = await fetchRegistry(root, { fetchImpl })
    expect(doc.agents['claude-acp']!.id).toBe('claude-acp')
    expect(existsSync(join(root, 'acp_registry.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'acp_registry.cache.json'), 'utf8')).etag).toBe('W/"abc"')
  })

  it('on 304 returns the cached body', async () => {
    const root = tmpRoot()
    writeFileSync(join(root, 'acp_registry.json'), JSON.stringify(REG))
    writeFileSync(join(root, 'acp_registry.cache.json'), JSON.stringify({ etag: '"v1"' }))
    const fetchImpl = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch
    const doc = await fetchRegistry(root, { fetchImpl })
    expect(doc.agents['claude-acp']!.id).toBe('claude-acp')
  })

  it('on network error falls back to cached body', async () => {
    const root = tmpRoot()
    writeFileSync(join(root, 'acp_registry.json'), JSON.stringify(REG))
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const doc = await fetchRegistry(root, { fetchImpl })
    expect(doc.agents['claude-acp']!.id).toBe('claude-acp')
  })

  it('on network error with no cache returns empty agents', async () => {
    const root = tmpRoot()
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const doc = await fetchRegistry(root, { fetchImpl })
    expect(doc.agents).toEqual({})
  })
})

const REG2 = {
  agents: {
    'claude-acp': { id: 'claude-acp', name: 'Claude', version: '1', distribution: { npx: { package: 'claude@1' } } },
    gemini: { id: 'gemini', name: 'Gemini', version: '1', distribution: { npx: { package: 'gem@1', args: ['--acp'] } } }
  }
}

describe('cachedRuntimeNames', () => {
  it('maps registry id -> display name from the cached doc', () => {
    const root = tmpRoot()
    writeFileSync(
      join(root, 'acp_registry.json'),
      JSON.stringify({
        agents: {
          'claude-acp': {
            id: 'claude-acp',
            name: 'Claude Agent',
            version: '1',
            distribution: { npx: { package: 'p' } }
          },
          gemini: { id: 'gemini', name: 'Gemini CLI', version: '1', distribution: { npx: { package: 'g' } } }
        }
      })
    )
    expect(cachedRuntimeNames(root)).toEqual({ 'claude-acp': 'Claude Agent', gemini: 'Gemini CLI' })
  })

  it('omits entries with no name, and returns {} when no cache exists', () => {
    const root = tmpRoot()
    expect(cachedRuntimeNames(root)).toEqual({})
    writeFileSync(
      join(root, 'acp_registry.json'),
      JSON.stringify({ agents: { x: { id: 'x', distribution: { npx: { package: 'p' } } } } })
    )
    expect(cachedRuntimeNames(root)).toEqual({}) // name defaults to '' -> omitted
  })
})

describe('resolveRuntimes', () => {
  it('uses the managed Codex build by default while preserving operator overrides', async () => {
    const root = tmpRoot()
    const registry = {
      agents: {
        'codex-acp': {
          id: 'codex-acp',
          name: 'Registry Codex',
          version: '1.1.8',
          distribution: { npx: { package: '@agentclientprotocol/codex-acp@1.1.8' } }
        }
      }
    }
    const fetchImpl = (async () => new Response(JSON.stringify(registry), { status: 200 })) as typeof fetch

    const managed = await resolveRuntimeCatalog({} as any, root, { neededRuntimes: ['other'], fetchImpl })
    expect(managed.entries['codex-acp']).toEqual({
      ...MANAGED_RUNTIME_CATALOG['codex-acp'],
      source: 'managed',
      skillsAgentId: 'codex'
    })

    const configured = await resolveRuntimeCatalog(
      { runtimes: { 'codex-acp': { command: '/custom/codex-acp', args: [], env: [] } } } as any,
      root,
      { neededRuntimes: ['codex-acp'], fetchImpl }
    )
    expect(configured.entries['codex-acp']).toEqual({
      runtime: { command: '/custom/codex-acp', args: [], env: [] },
      source: 'user',
      name: 'codex-acp',
      version: '',
      skillsAgentId: null
    })
  })

  it('skips the registry fetch entirely when config covers all needed runtimes', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    const cfg: any = { runtimes: { fake: { command: 'node', args: [], env: [] } } }
    const out = await resolveRuntimes(cfg, '/nonexistent', { neededRuntimes: ['fake'], fetchImpl })
    expect(called).toBe(false)
    expect(out.fake!.command).toBe('node')
  })

  it('merges registry defaults with config (config wins by name)', async () => {
    const root = tmpRoot()
    const fetchImpl = (async () => new Response(JSON.stringify(REG2), { status: 200 })) as unknown as typeof fetch
    const cfg: any = { runtimes: { 'claude-acp': { command: 'custom', args: [], env: [] } } }
    const out = await resolveRuntimes(cfg, root, { neededRuntimes: ['gemini'], mode: 'blocking', fetchImpl })
    expect(out['gemini']).toEqual({ command: 'npx', args: ['-y', 'gem@1', '--acp'], env: [] })
    expect(out['claude-acp']!.command).toBe('custom') // config override preserved
  })

  it('works when config has no runtimes (all from registry)', async () => {
    const root = tmpRoot()
    const fetchImpl = (async () => new Response(JSON.stringify(REG2), { status: 200 })) as unknown as typeof fetch
    const cfg: any = {}
    const out = await resolveRuntimes(cfg, root, { neededRuntimes: ['claude-acp'], mode: 'blocking', fetchImpl })
    expect(out['claude-acp']).toEqual({ command: 'npx', args: ['-y', 'claude@1'], env: [] })
  })
})

describe('curated native ACP runtimes', () => {
  it('declares the nine reviewed native ACP commands', () => {
    expect(CURATED_RUNTIME_CATALOG).toEqual({
      'hermes-agent': {
        name: 'Hermes Agent',
        runtime: { command: 'hermes', args: ['acp'], env: [], skillsAgentId: 'hermes-agent' }
      },
      'open-interpreter': {
        name: 'Open Interpreter',
        runtime: { command: 'interpreter', args: ['acp'], env: [] }
      },
      'kiro-cli': {
        name: 'Kiro CLI',
        runtime: { command: 'kiro-cli', args: ['acp'], env: [], skillsAgentId: 'kiro-cli' }
      },
      maki: {
        name: 'Maki',
        runtime: { command: 'maki', args: ['acp'], env: [] }
      },
      zeroclaw: {
        name: 'ZeroClaw',
        runtime: { command: 'zeroclaw', args: ['acp'], env: [] }
      },
      omp: {
        name: 'Oh My Pi',
        runtime: { command: 'omp', args: ['acp'], env: [] }
      },
      'qoder-cli': {
        name: 'Qoder CLI',
        runtime: { command: 'qodercli', args: ['--acp'], env: [], skillsAgentId: 'qoder' }
      },
      'qoder-cli-cn': {
        name: 'Qoder CN CLI',
        runtime: { command: 'qoderclicn', args: ['--acp'], env: [], skillsAgentId: 'qoder-cn' }
      },
      'dsh-acp': {
        name: 'DeepSeek Harness',
        runtime: {
          command: 'npx',
          args: ['-y', '-p', '@openma/deepseek-harness-acp@^0.4', 'dsh-acp'],
          env: [],
          skillsAgentId: 'universal'
        }
      }
    })
  })

  it('uses curated entries when the registry is empty', async () => {
    const root = tmpRoot()
    const fetchImpl = (async () => new Response(JSON.stringify({ agents: {} }), { status: 200 })) as typeof fetch

    const catalog = await resolveRuntimeCatalog({} as any, root, { mode: 'blocking', fetchImpl })

    expect(catalog.entries.omp).toMatchObject({ source: 'curated', name: 'Oh My Pi', version: '' })
    expect(catalog.runtimes.omp).toEqual({ command: 'omp', args: ['acp'], env: [] })
  })

  it('lets a usable registry entry take over a curated id', async () => {
    const root = tmpRoot()
    const plat = platformKey()
    if (!plat) throw new Error('platformKey() returned null on this platform')
    const registry = {
      agents: {
        omp: {
          id: 'omp',
          name: 'OMP Registry',
          version: '17.0.0',
          distribution: { binary: { [plat]: { cmd: 'omp-registry', args: ['acp'] } } }
        }
      }
    }
    const fetchImpl = (async () => new Response(JSON.stringify(registry), { status: 200 })) as typeof fetch

    const catalog = await resolveRuntimeCatalog({} as any, root, { mode: 'blocking', fetchImpl })

    expect(catalog.entries.omp).toEqual({
      source: 'registry',
      name: 'OMP Registry',
      version: '17.0.0',
      skillsAgentId: null,
      runtime: { command: 'omp-registry', args: ['acp'], env: [] }
    })
  })

  it('keeps a curated fallback when the registry distribution is unusable on this platform', async () => {
    const root = tmpRoot()
    const registry = {
      agents: {
        omp: {
          id: 'omp',
          name: 'Unusable OMP',
          version: '17.0.0',
          distribution: { binary: { 'solaris-sparc': { cmd: 'omp-solaris', args: ['acp'] } } }
        }
      }
    }
    const fetchImpl = (async () => new Response(JSON.stringify(registry), { status: 200 })) as typeof fetch

    const catalog = await resolveRuntimeCatalog({} as any, root, { mode: 'blocking', fetchImpl })

    expect(catalog.entries.omp).toMatchObject({
      source: 'curated',
      name: 'Oh My Pi',
      runtime: { command: 'omp', args: ['acp'], env: [] }
    })
  })

  it('lets explicit config win without inheriting registry metadata', async () => {
    const root = tmpRoot()
    const cfg: any = { runtimes: { omp: { command: '/custom/omp', args: ['acp'], env: [] } } }
    const fetchImpl = (async () => new Response(JSON.stringify({ agents: {} }), { status: 200 })) as typeof fetch

    const catalog = await resolveRuntimeCatalog(cfg, root, { mode: 'blocking', fetchImpl })

    expect(catalog.entries.omp).toEqual({
      source: 'user',
      name: 'omp',
      version: '',
      skillsAgentId: null,
      runtime: { command: '/custom/omp', args: ['acp'], env: [] }
    })
  })

  it('does not inherit built-in skill admission when a user replaces an audited runtime id', async () => {
    const root = tmpRoot()
    const fetchImpl = (async () => new Response(JSON.stringify({ agents: {} }), { status: 200 })) as typeof fetch
    const implicit: any = {
      runtimes: { 'claude-acp': { command: 'unrelated-custom-harness', args: [], env: [] } }
    }
    const explicit: any = {
      runtimes: {
        'claude-acp': {
          command: 'reviewed-custom-harness',
          args: [],
          env: [],
          skillsAgentId: 'custom-reviewed-id'
        }
      }
    }

    expect(
      (await resolveRuntimeCatalog(implicit, root, { mode: 'blocking', fetchImpl })).entries['claude-acp']
    ).toMatchObject({ source: 'user', skillsAgentId: null })
    expect(
      (await resolveRuntimeCatalog(explicit, root, { mode: 'blocking', fetchImpl })).entries['claude-acp']
    ).toMatchObject({ source: 'user', skillsAgentId: 'custom-reviewed-id' })
  })

  it('merges usable cache on the needed-runtime fast path without fetching', async () => {
    const root = tmpRoot()
    writeFileSync(join(root, 'acp_registry.json'), JSON.stringify(REG2))
    let fetched = false
    const fetchImpl = (async () => {
      fetched = true
      throw new Error('must not fetch')
    }) as typeof fetch
    const cfg: any = { runtimes: { local: { command: 'local', args: ['acp'], env: [] } } }

    const catalog = await resolveRuntimeCatalog(cfg, root, {
      neededRuntimes: ['local'],
      mode: 'cache-first',
      fetchImpl
    })

    expect(fetched).toBe(false)
    expect(catalog.entries.local!.source).toBe('user')
    expect(catalog.entries.gemini!.source).toBe('registry')
    expect(catalog.entries.maki!.source).toBe('curated')
  })

  it('collapses an automatic canonical Hermes entry behind an explicit legacy alias', async () => {
    const root = tmpRoot()
    const plat = platformKey()
    if (!plat) throw new Error('platformKey() returned null on this platform')
    const registry = {
      agents: {
        'hermes-agent': {
          id: 'hermes-agent',
          name: 'Hermes Registry',
          version: '1.0.0',
          distribution: { binary: { [plat]: { cmd: 'hermes', args: ['acp'] } } }
        }
      }
    }
    const cfg: any = { runtimes: { hermes: { command: '/custom/hermes', args: ['acp'], env: [] } } }
    const fetchImpl = (async () => new Response(JSON.stringify(registry), { status: 200 })) as typeof fetch

    const catalog = await resolveRuntimeCatalog(cfg, root, { mode: 'blocking', fetchImpl })

    expect(catalog.entries.hermes!.source).toBe('user')
    expect(catalog.entries['hermes-agent']).toBeUndefined()
  })

  it('keeps both Hermes ids when both are explicit', async () => {
    const root = tmpRoot()
    const cfg: any = {
      runtimes: {
        hermes: { command: 'legacy-hermes', args: ['acp'], env: [] },
        'hermes-agent': { command: 'canonical-hermes', args: ['acp'], env: [] }
      }
    }
    const fetchImpl = (async () => new Response(JSON.stringify({ agents: {} }), { status: 200 })) as typeof fetch

    const catalog = await resolveRuntimeCatalog(cfg, root, { mode: 'blocking', fetchImpl })

    expect(catalog.entries.hermes!.source).toBe('user')
    expect(catalog.entries['hermes-agent']!.source).toBe('user')
  })
})
