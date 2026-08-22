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

// These tests assume a POSIX host (X_OK semantics); the CI/dev targets are darwin/linux.

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

const env = (extra: NodeJS.ProcessEnv = {}) => ({ PATH: binDir, HOME: home, ...extra }) as NodeJS.ProcessEnv

const npx = (): RuntimeDef => ({ command: 'npx', args: ['-y', 'pkg'], env: [] })

describe('isCommandAvailable', () => {
  it('finds a bare command on PATH', () => {
    makeExecutable(binDir, 'npx')
    expect(isCommandAvailable('npx', env())).toBe(true)
  })

  it('returns false when the command is absent from PATH', () => {
    expect(isCommandAvailable('npx', env())).toBe(false)
  })

  it('does not count a non-executable file as available', () => {
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
  it('returns the absolute path of a bare command found on PATH', () => {
    const p = makeExecutable(binDir, 'claude')
    expect(resolveCommandPath('claude', env())).toBe(p)
  })

  it('returns undefined when the command is absent', () => {
    expect(resolveCommandPath('claude', env())).toBeUndefined()
  })

  it('ignores a non-executable file of the same name', () => {
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

  it('opencode counts XDG config, XDG-data auth, or the ~/.opencode fallback', () => {
    const rt: RuntimeDef = { command: 'opencode', args: ['acp'], env: [] }
    makeExecutable(binDir, 'opencode')
    expect(isRuntimeAvailable('opencode', rt, env())).toBe(false)
    mkdirSync(join(home, '.opencode'))
    expect(isRuntimeAvailable('opencode', rt, env())).toBe(true)
  })

  it('pi-acp needs ~/.pi even when npx is present', () => {
    makeExecutable(binDir, 'npx')
    expect(isRuntimeAvailable('pi-acp', npx(), env())).toBe(false)
    mkdirSync(join(home, '.pi'))
    expect(isRuntimeAvailable('pi-acp', npx(), env())).toBe(true)
  })

  it('hermes needs ~/.hermes and honors $HERMES_HOME', () => {
    makeExecutable(binDir, 'hermes')
    const rt: RuntimeDef = { command: 'hermes', args: [], env: [] }
    expect(isRuntimeAvailable('hermes', rt, env())).toBe(false)
    mkdirSync(join(home, '.hermes'))
    expect(isRuntimeAvailable('hermes', rt, env())).toBe(true)

    const hermesHome = mkdtempSync(join(tmpdir(), 'ac-hermes-'))
    const cleanHome = mkdtempSync(join(tmpdir(), 'ac-home2-'))
    expect(isRuntimeAvailable('hermes', rt, env({ HOME: cleanHome }))).toBe(false)
    expect(isRuntimeAvailable('hermes', rt, env({ HOME: cleanHome, HERMES_HOME: hermesHome }))).toBe(true)
  })

  it.each([
    ['hermes-agent', 'hermes', 'HERMES_HOME'],
    ['open-interpreter', 'interpreter', 'INTERPRETER_HOME'],
    ['kiro-cli', 'kiro-cli', 'KIRO_HOME'],
    ['zeroclaw', 'zeroclaw', 'ZEROCLAW_CONFIG_DIR'],
    ['omp', 'omp', 'PI_CODING_AGENT_DIR']
  ])('%s honors its reviewed state-root override', (id, command, variable) => {
    makeExecutable(binDir, command)
    const stateDir = mkdtempSync(join(tmpdir(), `ac-${id}-state-`))
    const cleanHome = mkdtempSync(join(tmpdir(), `ac-${id}-home-`))
    const rt: RuntimeDef = { command, args: ['acp'], env: [] }

    expect(isRuntimeAvailable(id, rt, env({ HOME: cleanHome }))).toBe(false)
    expect(isRuntimeAvailable(id, rt, env({ HOME: cleanHome, [variable]: stateDir }))).toBe(true)
  })

  it('Maki accepts XDG state and the legacy ~/.maki fallback', () => {
    makeExecutable(binDir, 'maki')
    const rt: RuntimeDef = { command: 'maki', args: ['acp'], env: [] }
    const xdgConfig = mkdtempSync(join(tmpdir(), 'ac-maki-config-'))

    expect(isRuntimeAvailable('maki', rt, env())).toBe(false)
    mkdirSync(join(xdgConfig, 'maki'))
    expect(isRuntimeAvailable('maki', rt, env({ XDG_CONFIG_HOME: xdgConfig }))).toBe(true)

    const legacyHome = mkdtempSync(join(tmpdir(), 'ac-maki-legacy-'))
    mkdirSync(join(legacyHome, '.maki'))
    expect(isRuntimeAvailable('maki', rt, env({ HOME: legacyHome }))).toBe(true)
  })

  it('qoder-cli needs ~/.qoder even when qodercli is on PATH', () => {
    makeExecutable(binDir, 'qodercli')
    const rt: RuntimeDef = { command: 'qodercli', args: ['--acp'], env: [] }
    expect(isRuntimeAvailable('qoder-cli', rt, env())).toBe(false)
    mkdirSync(join(home, '.qoder'))
    expect(isRuntimeAvailable('qoder-cli', rt, env())).toBe(true)
  })

  it('qoder-cli honors $QODER_CONFIG_DIR and $QODER_CLI_HOME overrides', () => {
    makeExecutable(binDir, 'qodercli')
    const rt: RuntimeDef = { command: 'qodercli', args: ['--acp'], env: [] }
    const cleanHome = mkdtempSync(join(tmpdir(), 'ac-qoder-home-'))

    const configDir = mkdtempSync(join(tmpdir(), 'ac-qoder-cfg-'))
    expect(isRuntimeAvailable('qoder-cli', rt, env({ HOME: cleanHome }))).toBe(false)
    expect(isRuntimeAvailable('qoder-cli', rt, env({ HOME: cleanHome, QODER_CONFIG_DIR: configDir }))).toBe(true)

    const cliHome = mkdtempSync(join(tmpdir(), 'ac-qoder-clihome-'))
    mkdirSync(join(cliHome, '.qoder'))
    expect(isRuntimeAvailable('qoder-cli', rt, env({ HOME: cleanHome, QODER_CLI_HOME: cliHome }))).toBe(true)
    expect(isRuntimeAvailable('qoder-cli', rt, env({ HOME: cleanHome, GEMINI_CLI_HOME: cliHome }))).toBe(true)

    const namedHome = mkdtempSync(join(tmpdir(), 'ac-qoder-named-home-'))
    mkdirSync(join(namedHome, '\u00e9-qoder'))
    expect(isRuntimeAvailable('qoder-cli', rt, env({ HOME: namedHome, QODER_CONFIG_DIR_NAME: 'e\u0301-qoder' }))).toBe(
      true
    )
  })

  it('qoder-cli-cn needs ~/.qoder-cn even when qoderclicn is on PATH', () => {
    makeExecutable(binDir, 'qoderclicn')
    const rt: RuntimeDef = { command: 'qoderclicn', args: ['--acp'], env: [] }
    expect(isRuntimeAvailable('qoder-cli-cn', rt, env())).toBe(false)
    mkdirSync(join(home, '.qoder-cn'))
    expect(isRuntimeAvailable('qoder-cli-cn', rt, env())).toBe(true)
  })

  it('qoder-cli-cn honors its config directory overrides', () => {
    makeExecutable(binDir, 'qoderclicn')
    const rt: RuntimeDef = { command: 'qoderclicn', args: ['--acp'], env: [] }
    const cleanHome = mkdtempSync(join(tmpdir(), 'ac-qodercn-home-'))
    const configDir = mkdtempSync(join(tmpdir(), 'ac-qodercn-cfg-'))
    expect(isRuntimeAvailable('qoder-cli-cn', rt, env({ HOME: cleanHome }))).toBe(false)
    expect(isRuntimeAvailable('qoder-cli-cn', rt, env({ HOME: cleanHome, QODERCN_CONFIG_DIR: configDir }))).toBe(true)

    mkdirSync(join(cleanHome, 'custom-qoder-cn'))
    expect(
      isRuntimeAvailable('qoder-cli-cn', rt, env({ HOME: cleanHome, QODERCN_CONFIG_DIR_NAME: 'custom-qoder-cn' }))
    ).toBe(true)
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

  it('cursor needs the CLI-specific cli-config.json (dir alone is not enough)', () => {
    makeExecutable(binDir, 'cursor-agent')
    const rt: RuntimeDef = { command: 'cursor-agent', args: [], env: [] }
    mkdirSync(join(home, '.cursor')) // shared with the editor — not sufficient
    expect(isRuntimeAvailable('cursor', rt, env())).toBe(false)
    writeFileSync(join(home, '.cursor', 'cli-config.json'), '{}')
    expect(isRuntimeAvailable('cursor', rt, env())).toBe(true)
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

  it('applies curated state gates only when the curated source wins', () => {
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

    expect(Object.keys(installedRuntimeCatalog(curatedCatalog, env()).runtimes)).toEqual([])
    expect(Object.keys(installedRuntimeCatalog(userCatalog, env()).runtimes)).toEqual(['hermes-agent', 'hermes'])
    expect(Object.keys(installedRuntimeCatalog(registryCatalog, env()).runtimes)).toEqual([])
  })
})
