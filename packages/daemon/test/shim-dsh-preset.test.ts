import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bakeRegistryBundle, withSearchDisabled } from '../../../docker/runtime-sandbox/bake-dsh-preset.mjs'
import { AcpRunner } from '../src/shim/acp-runner.js'
import {
  DSH_WEB_SEARCH_POD_ENV,
  dshHomeOf,
  podKeepsWebSearch,
  seedDshPreset,
  settingsWithPresetDefault
} from '../src/shim/dsh-preset.js'
import { SANDBOX_DSH_PRESET_ID } from '../src/shim/sandbox-paths.js'

// The image disables the preset tool because gateway credentials cannot authenticate DeepSeek web search.

const STANDARD_ROW = [
  '- id: tool-todo',
  '  name: my-todo',
  '',
  '# The `web` service stays in the host composition; only the tool is per-session.',
  '- id: tool-web',
  "  name: '@deepseek-ai/dsh-tool-web'",
  '  config:',
  '    fetch: false',
  '    searchTimeoutMs: 60000',
  '',
  '- id: tool-presentation',
  '  name: my-presentation',
  ''
].join('\n')

const STANDARD_PRESET = [
  '- insert:',
  '    - id: preset-standard',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: standard',
  '        plugins:',
  ...STANDARD_ROW.split('\n').map((line) => (line ? `          ${line}` : ''))
].join('\n')

describe('baking the no-search bundle', () => {
  it('disables the nested tool without changing other settings, comments, or expressions', () => {
    const source = STANDARD_PRESET.replace('fetch: false', 'fetch: !!js true')
    const baked = withSearchDisabled(source)
    expect(baked).toBe(source.replace('fetch: !!js true', 'search: false\n              fetch: !!js true'))
    expect(withSearchDisabled(baked)).toBe(baked)
  })

  it('fails the build when the tool is missing, duplicated, or explicitly enables search', () => {
    expect(() => withSearchDisabled('- id: tool-todo\n')).toThrow(/exactly one/)
    expect(() => withSearchDisabled(`${STANDARD_PRESET}${STANDARD_PRESET}`)).toThrow(/exactly one/)
    expect(() => withSearchDisabled(STANDARD_PRESET.replace('fetch: false', 'search: true'))).toThrow(
      /upstream intent changed/
    )
  })

  // This Linux image bundle uses a directory symlink, which requires extra privileges on Windows.
  it.skipIf(process.platform === 'win32')(
    'keeps the shipped presets and selects a no-search copy from the installed runtime',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'ac-dsh-bundle-'))
      try {
        const cache = join(root, 'cache')
        const modules = join(cache, 'runtime', 'node_modules')
        const presets = join(modules, '@deepseek-ai', 'dsh-web-app', 'presets')
        mkdirSync(presets, { recursive: true })
        const shipped = ['standard', 'ptc', 'minimal', 'cordis'].map((name) => {
          const text = STANDARD_PRESET.replaceAll('standard', name)
          writeFileSync(join(presets, `${name}.patch.yml`), text)
          return text
        })
        const target = join(root, SANDBOX_DSH_PRESET_ID)
        const patch = readFileSync(bakeRegistryBundle(target, cache), 'utf8')
        for (const preset of shipped) expect(patch).toContain(preset)
        expect(patch).toContain('default: standard-no-search')
        expect(patch).toContain('id: preset-standard-no-search')
        expect(patch.match(/search: false/g)).toHaveLength(1)
        expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).dsh.bundle.patch).toBe('cordis.patch.yml')
        expect(realpathSync(join(target, 'node_modules'))).toBe(realpathSync(modules))
        expect(seedDshPreset({ env: {}, podEnv: {}, source: target })).toBe(target)
        expect(seedDshPreset({ env: {}, podEnv: { [DSH_WEB_SEARCH_POD_ENV]: 'on' }, source: target })).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})

describe('reading the pod switch', () => {
  it('keeps the shipped preset only on an affirmative value', () => {
    expect(podKeepsWebSearch({ [DSH_WEB_SEARCH_POD_ENV]: 'on' })).toBe(true)
    expect(podKeepsWebSearch({ [DSH_WEB_SEARCH_POD_ENV]: ' TRUE ' })).toBe(true)
    expect(podKeepsWebSearch({})).toBe(false)
    expect(podKeepsWebSearch({ [DSH_WEB_SEARCH_POD_ENV]: 'off' })).toBe(false)
  })

  it('names an unreadable value instead of letting it read as on', () => {
    const warnings: string[] = []
    expect(podKeepsWebSearch({ [DSH_WEB_SEARCH_POD_ENV]: 'enabled' }, (m) => warnings.push(m))).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(DSH_WEB_SEARCH_POD_ENV)
  })
})

describe('resolving $DSH_HOME', () => {
  it('prefers an explicit DSH_HOME and otherwise derives it from HOME', () => {
    expect(dshHomeOf({ DSH_HOME: '/state/dsh', HOME: '/agent' })).toBe('/state/dsh')
    expect(dshHomeOf({ HOME: '/agent' })).toBe(join('/agent', '.dsh'))
    expect(dshHomeOf({})).toBeUndefined()
  })
})

describe('pointing the default preset at the seeded copy', () => {
  it('writes the block when there is no settings document yet', () => {
    expect(settingsWithPresetDefault(undefined, 'p')).toBe('agent-presets:\n  default: p\n')
  })

  it('appends to a document that decides other things', () => {
    expect(settingsWithPresetDefault('permission:\n  defaultPreset: read-only', 'p')).toBe(
      'permission:\n  defaultPreset: read-only\nagent-presets:\n  default: p\n'
    )
  })

  // Either a deployment's choice or a session's own preset switch — both outrank this floor.
  it('leaves an existing agent-presets block untouched', () => {
    expect(settingsWithPresetDefault('agent-presets:\n  default: minimal\n', 'p')).toBeUndefined()
  })
})

describe('seeding the sandbox $DSH_HOME', () => {
  let root: string
  let source: string
  let home: string

  const composition = (dir: string): string =>
    join(dir, '.dsh', '.agent-presets', SANDBOX_DSH_PRESET_ID, 'agent.cordis.yml')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ac-dsh-seed-'))
    source = join(root, 'image', SANDBOX_DSH_PRESET_ID)
    home = join(root, 'agent')
    mkdirSync(source, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(source, 'agent.cordis.yml'), STANDARD_ROW.replace('fetch: false', 'search: false'))
    writeFileSync(join(source, 'preset.yml'), 'name: Standard (no web search)\n')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('copies the baked preset in and names it the default', () => {
    seedDshPreset({ env: { HOME: home }, podEnv: {}, source })
    expect(readFileSync(composition(home), 'utf8')).toContain('search: false')
    expect(readFileSync(join(home, '.dsh', 'settings.yaml'), 'utf8')).toBe(
      `agent-presets:\n  default: ${SANDBOX_DSH_PRESET_ID}\n`
    )
  })

  it('replaces a copy left by an earlier image rather than merging with it', () => {
    seedDshPreset({ env: { HOME: home }, podEnv: {}, source })
    const stale = join(home, '.dsh', '.agent-presets', SANDBOX_DSH_PRESET_ID, 'gone-upstream.yml')
    writeFileSync(stale, 'name: retired\n')
    seedDshPreset({ env: { HOME: home }, podEnv: {}, source })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(composition(home))).toBe(true)
  })

  it('does nothing when the deployment keeps web search', () => {
    seedDshPreset({ env: { HOME: home }, podEnv: { [DSH_WEB_SEARCH_POD_ENV]: 'on' }, source })
    expect(existsSync(join(home, '.dsh'))).toBe(false)
  })

  // An image built before this ships no preset, and such a pod must launch exactly as it always did.
  it('does nothing when the image bakes no preset', () => {
    seedDshPreset({ env: { HOME: home }, podEnv: {}, source: join(root, 'absent') })
    expect(existsSync(join(home, '.dsh'))).toBe(false)
  })

  it('reports rather than throws when the home cannot be written', () => {
    const warnings: string[] = []
    const blocked = join(root, 'not-a-dir')
    writeFileSync(blocked, 'file where a home should be\n')
    seedDshPreset({
      env: { DSH_HOME: join(blocked, '.dsh') },
      podEnv: {},
      source,
      log: { warn: (m) => warnings.push(m) }
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unseeded')
  })

  it('passes the current image bundle to the DeepSeek child', async () => {
    const bundle = join(root, 'bundle')
    mkdirSync(bundle)
    writeFileSync(join(bundle, 'package.json'), '{}')
    writeFileSync(join(bundle, 'cordis.patch.yml'), '')
    const chunks: string[] = []
    let onExit: (() => void) | undefined
    const exited = new Promise<void>((resolve) => (onExit = resolve))
    const runner = new AcpRunner({
      emit: (event) => {
        if (event.kind === 'chunk') chunks.push(Buffer.from(event.data, 'base64').toString('utf8'))
        if (event.kind === 'exit') onExit?.()
      },
      podEnv: { HOME: home },
      dshPresetSource: bundle,
      resolveCommand: () => process.execPath
    })
    try {
      await runner.apply({
        op: 'open',
        command: 'dsh-acp',
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--'],
        env: {}
      })
      await exited
      expect(JSON.parse(chunks.join(''))).toEqual(['--bundle', bundle])
      expect(existsSync(join(home, '.dsh'))).toBe(false)
    } finally {
      await runner.close(1_000)
    }
  })

  it('seeds for the DeepSeek runtime and for no other', async () => {
    const openOf = (runner: AcpRunner): ((payload: unknown) => Promise<void>) =>
      (runner as unknown as { open(payload: unknown): Promise<void> }).open.bind(runner)
    // Each runner gets one child; preset selection uses the requested command before resolution.
    const runnerFor = (): AcpRunner =>
      new AcpRunner({
        emit: () => {},
        podEnv: { HOME: home },
        dshPresetSource: source,
        resolveCommand: () => 'true'
      })
    const claude = runnerFor()
    await openOf(claude)({ op: 'open', command: 'claude-agent-acp', args: [], env: {} }).catch(() => {})
    expect(existsSync(join(home, '.dsh'))).toBe(false)
    const deepseek = runnerFor()
    await openOf(deepseek)({ op: 'open', command: 'dsh-acp', args: [], env: {} }).catch(() => {})
    expect(existsSync(composition(home))).toBe(true)
    await Promise.all([claude.close(1_000).catch(() => {}), deepseek.close(1_000).catch(() => {})])
  })
})
