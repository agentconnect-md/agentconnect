import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bakePreset, presetCandidates, withSearchDisabled } from '../../../docker/runtime-sandbox/bake-dsh-preset.mjs'
import { AcpRunner } from '../src/shim/acp-runner.js'
import {
  DSH_WEB_SEARCH_POD_ENV,
  dshHomeOf,
  podKeepsWebSearch,
  seedDshPreset,
  settingsWithPresetDefault
} from '../src/shim/dsh-preset.js'
import { SANDBOX_DSH_PRESET_ID } from '../src/shim/sandbox-paths.js'

// dsh offers `web_search` from the AGENT PRESET, and the harness's search provider ignores
// $DEEPSEEK_BASE_URL — it takes $DEEPSEEK_API_KEY to api.deepseek.com itself, so a pod carrying a
// gateway key answers every search with an invalid-key error. The image bakes a copy of the shipped
// preset with the tool deregistered and the shim seeds it, which is the only supported way to drop
// a preset row: the host-plane patch layer cannot reach into a preset subtree.

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

describe('baking the no-search preset', () => {
  it('inserts search: false into the tool-web row and leaves every other row alone', () => {
    const baked = withSearchDisabled(STANDARD_ROW)
    expect(baked).toContain('  config:\n    search: false\n    fetch: false')
    // The comment above the row, and the rows around it, survive: a re-emitted YAML document would
    // drop exactly the comments that explain what each row is for.
    expect(baked).toContain('# The `web` service stays in the host composition')
    expect(baked.match(/search: false/g)).toHaveLength(1)
    expect(baked).toContain('- id: tool-presentation')
  })

  it('gives a row with no config block one', () => {
    const text = ['- id: tool-web', "  name: '@deepseek-ai/dsh-tool-web'", ''].join('\n')
    expect(withSearchDisabled(text)).toBe(
      ['- id: tool-web', "  name: '@deepseek-ai/dsh-tool-web'", '  config:', '    search: false', ''].join('\n')
    )
  })

  it('is idempotent when the row already disables search', () => {
    const once = withSearchDisabled(STANDARD_ROW)
    expect(withSearchDisabled(once)).toBe(once)
  })

  // Each of these means the build is guessing at an upstream shape it no longer recognizes, and a
  // guess here ships a preset that quietly still has the tool.
  it('fails the build when the row is missing, duplicated, or deliberately enables search', () => {
    expect(() => withSearchDisabled('- id: tool-todo\n  name: my-todo\n')).toThrow(/exactly one/)
    expect(() => withSearchDisabled(`${STANDARD_ROW}${STANDARD_ROW}`)).toThrow(/exactly one/)
    expect(() => withSearchDisabled(STANDARD_ROW.replace('fetch: false', 'search: true'))).toThrow(
      /upstream intent changed/
    )
  })
})

describe('finding the preset the adapter ships', () => {
  // The adapter has installed dsh beside itself, under itself, and as a vendored archive across
  // versions the image has pinned, and only the built image proves which layout is there.
  it('tries the hoisted install before the one nested under the adapter', () => {
    const [hoisted, nested] = presetCandidates('/n')
    expect(hoisted).toBe(join('/n', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard'))
    expect(nested).toBe(
      join(
        '/n',
        '@openma',
        'deepseek-harness-acp',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'config',
        'agent-presets',
        'standard'
      )
    )
  })

  it('bakes from a nested install, which is how the pinned adapter ships it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-dsh-root-'))
    try {
      const source = join(
        root,
        '@openma',
        'deepseek-harness-acp',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'config',
        'agent-presets',
        'standard'
      )
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'agent.cordis.yml'), STANDARD_ROW)
      const target = join(root, 'out', SANDBOX_DSH_PRESET_ID)
      expect(readFileSync(bakePreset(target, root), 'utf8')).toContain('search: false')
      expect(readFileSync(join(target, 'preset.yml'), 'utf8')).toContain('name: ')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('names every path it tried when no layout has one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ac-dsh-empty-'))
    try {
      expect(() => bakePreset(join(empty, 'out'), empty)).toThrow(
        /no shipped standard preset: tried .*deepseek-harness-acp/
      )
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
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
    writeFileSync(join(source, 'agent.cordis.yml'), withSearchDisabled(STANDARD_ROW))
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

  it('seeds for the DeepSeek runtime and for no other', async () => {
    const openOf = (runner: AcpRunner): ((payload: unknown) => Promise<void>) =>
      (runner as unknown as { open(payload: unknown): Promise<void> }).open.bind(runner)
    // One runner per open: a runner that already holds a child refuses the next open outright. Both
    // resolve to a real no-op binary — the seed keys on the REQUESTED command, so what runs is
    // irrelevant, and a command that does not exist would fail this file on the spawn instead.
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
