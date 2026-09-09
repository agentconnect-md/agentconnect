import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installedRuntimeCatalog,
  installedRuntimes,
  isCommandAvailable,
  isRuntimeAvailable,
  resolveCommandPath
} from '../src/runtimes/probe.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import type { RuntimeDef } from '../src/config/config-schema.js'

// Cases that turn on X_OK skip on Windows, which has no execute bit — a plain file is spawnable
// there if its extension says so, which is what `it.runIf(win32)` below covers instead.

let binDir: string
let home: string

function makeExecutable(dir: string, name: string) {
  const p = join(dir, name)
  writeFileSync(p, '#!/bin/sh\n')
  chmodSync(p, 0o755)
  return p
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'ac-bin-'))
  home = mkdtempSync(join(tmpdir(), 'ac-home-'))
})

// `home()` in probe.ts reads USERPROFILE on Windows and HOME elsewhere, so every fake home has to
// set both — including the per-case `env({ HOME: … })` overrides, which is why it mirrors after merge.
const env = (extra: NodeJS.ProcessEnv = {}) => {
  const merged = { PATH: binDir, HOME: home, ...extra }
  return { ...merged, USERPROFILE: merged.HOME } as NodeJS.ProcessEnv
}

const npx = (): RuntimeDef => ({ command: 'npx', args: ['-y', 'pkg'], env: [] })

describe('isCommandAvailable', () => {
  it('finds a bare command on PATH', () => {
    makeExecutable(binDir, 'npx')
    expect(isCommandAvailable('npx', env())).toBe(true)
  })

  it('returns false when the command is absent from PATH', () => {
    expect(isCommandAvailable('npx', env())).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('does not count a non-executable file as available', () => {
    writeFileSync(join(binDir, 'uvx'), 'plain')
    expect(isCommandAvailable('uvx', env())).toBe(false)
  })

  it('resolves a path-qualified command directly', () => {
    const p = makeExecutable(binDir, 'goose')
    expect(isCommandAvailable(p, env())).toBe(true)
    expect(isCommandAvailable(join(binDir, 'nope'), env())).toBe(false)
  })
})

describe('resolveCommandPath', () => {
  it.runIf(process.platform === 'win32')('prefers a spawnable PATHEXT launcher over an extensionless sibling', () => {
    writeFileSync(join(binDir, 'npx'), 'shell launcher')
    writeFileSync(join(binDir, 'npx.cmd'), '@echo off\r\n')
    expect(resolveCommandPath('npx', { PATH: binDir, PATHEXT: '.EXE;.CMD' })).toBe(join(binDir, 'npx.CMD'))
  })

  it('returns the absolute path of a bare command found on PATH', () => {
    const p = makeExecutable(binDir, 'claude')
    expect(resolveCommandPath('claude', env())).toBe(p)
  })

  it('returns undefined when the command is absent', () => {
    expect(resolveCommandPath('claude', env())).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('ignores a non-executable file of the same name', () => {
    writeFileSync(join(binDir, 'claude'), 'plain')
    expect(resolveCommandPath('claude', env())).toBeUndefined()
  })

  it('resolves a path-qualified command directly (or undefined if missing)', () => {
    const p = makeExecutable(binDir, 'claude')
    expect(resolveCommandPath(p, env())).toBe(p)
    expect(resolveCommandPath(join(binDir, 'nope'), env())).toBeUndefined()
  })
})

describe('isRuntimeAvailable / custom probes', () => {
  it('an npx runtime with no custom probe is NOT available even when npx is present', () => {
    makeExecutable(binDir, 'npx')
    expect(isRuntimeAvailable('deepagents', npx(), env())).toBe(false) // no CUSTOM_PROBES entry → not trusted
  })

  it('a binary runtime with no custom probe is available when its binary is on PATH', () => {
    makeExecutable(binDir, 'some-agent-bin')
    const rt: RuntimeDef = { command: 'some-agent-bin', args: [], env: [] }
    expect(isRuntimeAvailable('mystery-binary-agent', rt, env())).toBe(true) // real binary on PATH is meaningful
  })

  it('claude-acp needs ~/.claude even when npx is present', () => {
    makeExecutable(binDir, 'npx')
    expect(isRuntimeAvailable('claude-acp', npx(), env())).toBe(false)
    mkdirSync(join(home, '.claude'))
    expect(isRuntimeAvailable('claude-acp', npx(), env())).toBe(true)
  })

  it('codex-acp honors $CODEX_HOME', () => {
    makeExecutable(binDir, 'npx')
    const codexHome = mkdtempSync(join(tmpdir(), 'ac-codex-'))
    expect(isRuntimeAvailable('codex-acp', npx(), env())).toBe(false)
    expect(isRuntimeAvailable('codex-acp', npx(), env({ CODEX_HOME: codexHome }))).toBe(true)
  })

  it('goose resolves under XDG_CONFIG_HOME', () => {
    makeExecutable(binDir, 'npx')
    const xdg = mkdtempSync(join(tmpdir(), 'ac-xdg-'))
    expect(isRuntimeAvailable('goose', npx(), env({ XDG_CONFIG_HOME: xdg }))).toBe(false)
    mkdirSync(join(xdg, 'goose'))
    expect(isRuntimeAvailable('goose', npx(), env({ XDG_CONFIG_HOME: xdg }))).toBe(true)
  })

  it('goose falls back to ~/.config/goose without XDG_CONFIG_HOME', () => {
    makeExecutable(binDir, 'npx')
    mkdirSync(join(home, '.config', 'goose'), { recursive: true })
    expect(isRuntimeAvailable('goose', npx(), env())).toBe(true)
  })

  it('pi-acp needs ~/.pi even when npx is present', () => {
    makeExecutable(binDir, 'npx')
    expect(isRuntimeAvailable('pi-acp', npx(), env())).toBe(false)
    mkdirSync(join(home, '.pi'))
    expect(isRuntimeAvailable('pi-acp', npx(), env())).toBe(true)
  })

  it.each([
    ['opencode', 'opencode'],
    ['hermes-agent', 'hermes'],
    ['open-interpreter', 'interpreter'],
    ['kiro-cli', 'kiro-cli'],
    ['zeroclaw', 'zeroclaw'],
    ['omp', 'omp'],
    ['maki', 'maki'],
    ['qoder-cli', 'qodercli'],
    ['qoder-cli-cn', 'qoderclicn'],
    ['openclaw', 'openclaw'],
    ['cursor', 'cursor-agent']
  ])('%s is installed when its binary exists, even with an empty HOME', (id, command) => {
    const rt: RuntimeDef = { command, args: ['acp'], env: [] }
    expect(isRuntimeAvailable(id, rt, env())).toBe(false)
    makeExecutable(binDir, command)
    expect(isRuntimeAvailable(id, rt, env())).toBe(true)
  })

  it('dsh-acp is fetched by npx, so ~/.dsh (or $DSH_HOME) is the only install signal', () => {
    makeExecutable(binDir, 'npx')
    const rt: RuntimeDef = {
      command: 'npx',
      args: ['-y', '-p', '@openma/deepseek-harness-acp@^0.4', 'dsh-acp'],
      env: []
    }
    expect(isRuntimeAvailable('dsh-acp', rt, env())).toBe(false)

    const dshHome = mkdtempSync(join(tmpdir(), 'ac-dsh-home-'))
    expect(isRuntimeAvailable('dsh-acp', rt, env({ DSH_HOME: dshHome }))).toBe(true)

    mkdirSync(join(home, '.dsh'))
    expect(isRuntimeAvailable('dsh-acp', rt, env())).toBe(true)
  })

  it('a custom-probed runtime is still dropped when the launcher is missing', () => {
    mkdirSync(join(home, '.claude'))
    expect(isRuntimeAvailable('claude-acp', npx(), env())).toBe(false)
  })
})

describe('installedRuntimes', () => {
  it('keeps only runnable runtimes', () => {
    makeExecutable(binDir, 'npx')
    makeExecutable(binDir, 'goose-bin')
    mkdirSync(join(home, '.claude'))
    const all: Record<string, RuntimeDef> = {
      'claude-acp': npx(), // npx present + ~/.claude → kept
      'codex-acp': npx(), // npx present but no ~/.codex → dropped
      deepagents: npx(), // no custom probe + npx launcher → dropped (launcher alone is meaningless)
      'binary-agent': { command: 'goose-bin', args: [], env: [] }, // real binary on PATH, no probe → kept
      'fast-agent': { command: 'uvx', args: ['fast-agent-acp'], env: [] } // uvx missing → dropped
    }
    expect(Object.keys(installedRuntimes(all, env())).sort()).toEqual(['binary-agent', 'claude-acp'])
  })

  it('does not read an Antigravity install as a Gemini CLI one, though they share ~/.gemini', () => {
    makeExecutable(binDir, 'npx')
    const gemini: RuntimeDef = { command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'], env: [] }
    // What `agy` itself writes: the shared root exists, but no Gemini CLI file in it does.
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    expect(isRuntimeAvailable('gemini', gemini, env())).toBe(false)

    writeFileSync(join(home, '.gemini', 'settings.json'), '{}')
    expect(isRuntimeAvailable('gemini', gemini, env())).toBe(true)
  })

  it('keeps the command probe for an archive format the store cannot install', () => {
    // opencode/amp/kimi ship `.tar.gz` on Linux with a flat `./cmd`. The store inflates ZIP only,
    // so these must stay on the probe they already pass rather than be admitted and then dropped.
    makeExecutable(binDir, 'amp-acp')
    const runtime: RuntimeDef = { command: './amp-acp', args: [], env: [] }
    const catalog = (): ResolvedRuntimeCatalog => ({
      entries: {
        'amp-acp': {
          runtime,
          source: 'registry',
          name: 'Amp',
          version: '0.1.0',
          skillsAgentId: null,
          archive: 'https://packages.example.test/amp-acp-linux-x86_64.tar.gz'
        }
      },
      runtimes: { 'amp-acp': runtime }
    })

    // On PATH and initialized → kept, exactly as before archives were classified at all.
    mkdirSync(join(home, '.config', 'amp'), { recursive: true })
    expect(Object.keys(installedRuntimeCatalog(catalog(), env()).runtimes)).toEqual(['amp-acp'])
  })

  it('gates an archive-distributed runtime on its own state, not on the command the store fetches', () => {
    // `./agy_acp_server.par` cannot be on PATH before the runtime store extracts it, so the host
    // signal is ~/.gemini/antigravity-* — the product itself being installed and initialized here.
    const runtime: RuntimeDef = { command: './agy_acp_server.par', args: ['--uid='], env: [] }
    const catalog = (): ResolvedRuntimeCatalog => ({
      entries: {
        'antigravity-acp': {
          runtime,
          source: 'registry',
          name: 'Google Antigravity',
          version: '1.0.0',
          skillsAgentId: null,
          archive: 'https://dl.example.test/agy-acp-server.zip'
        }
      },
      runtimes: { 'antigravity-acp': runtime }
    })

    expect(Object.keys(installedRuntimeCatalog(catalog(), env()).runtimes)).toEqual([])
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    expect(Object.keys(installedRuntimeCatalog(catalog(), env()).runtimes)).toEqual(['antigravity-acp'])
  })

  it('keeps direct curated binaries without state and rejects an unconfigured package launcher', () => {
    makeExecutable(binDir, 'hermes')
    makeExecutable(binDir, 'custom-hermes')
    makeExecutable(binDir, 'npx')
    const direct: RuntimeDef = { command: 'hermes', args: ['acp'], env: [] }
    const user: RuntimeDef = { command: 'custom-hermes', args: ['acp'], env: [] }
    const packageRuntime = npx()
    const curatedCatalog: ResolvedRuntimeCatalog = {
      entries: {
        'hermes-agent': { runtime: direct, source: 'curated', name: 'Hermes', version: '', skillsAgentId: null }
      },
      runtimes: { 'hermes-agent': direct }
    }
    const userCatalog: ResolvedRuntimeCatalog = {
      entries: {
        'hermes-agent': { runtime: user, source: 'user', name: 'Wrapped Hermes', version: '', skillsAgentId: null },
        hermes: { runtime: user, source: 'user', name: 'Legacy wrapped Hermes', version: '', skillsAgentId: null }
      },
      runtimes: { 'hermes-agent': user, hermes: user }
    }
    const registryCatalog: ResolvedRuntimeCatalog = {
      entries: {
        omp: { runtime: packageRuntime, source: 'registry', name: 'OMP package', version: '', skillsAgentId: null }
      },
      runtimes: { omp: packageRuntime }
    }

    expect(Object.keys(installedRuntimeCatalog(curatedCatalog, env()).runtimes)).toEqual(['hermes-agent'])
    expect(Object.keys(installedRuntimeCatalog(userCatalog, env()).runtimes)).toEqual(['hermes-agent', 'hermes'])
    expect(Object.keys(installedRuntimeCatalog(registryCatalog, env()).runtimes)).toEqual([])
  })
})
