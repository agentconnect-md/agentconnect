import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeSource, installSkills, SKILLS_CLI_VERSION } from '../src/skills/install-skills.js'
import { skillsAgentId } from '../src/skills/runtime-agent-map.js'

describe('skillsAgentId', () => {
  it('maps known runtimes (bare + acp-suffixed) to skills CLI agent ids', () => {
    expect(skillsAgentId('claude')).toBe('claude-code')
    expect(skillsAgentId('claude-acp')).toBe('claude-code')
    expect(skillsAgentId('codex-acp')).toBe('codex')
    expect(skillsAgentId('opencode')).toBe('opencode')
    expect(skillsAgentId('qwen-code')).toBe('gemini-cli')
    expect(skillsAgentId('cursor')).toBe('cursor')
  })

  it('returns undefined for an unmapped runtime', () => {
    expect(skillsAgentId('some-exotic-agent')).toBeUndefined()
  })
})

describe('trusted skills CLI', () => {
  it('keeps the bundled CLI constant aligned with the exact package dependency', () => {
    const req = createRequire(import.meta.url)
    const manifest = req('skills/package.json') as { version: string }
    expect(manifest.version).toBe(SKILLS_CLI_VERSION)
  })
})

describe('composeSource', () => {
  const base = { name: 'x', skills: [] as string[] }

  it('passes a bare source through untouched', () => {
    expect(composeSource({ ...base, source: 'acme/skills' })).toBe('acme/skills')
  })

  it('composes a shorthand + ref into a github tree URL', () => {
    expect(composeSource({ ...base, source: 'acme/skills', ref: 'v1.2.0' })).toBe(
      'https://github.com/acme/skills/tree/v1.2.0'
    )
  })

  it('appends the subdir to the tree path', () => {
    expect(composeSource({ ...base, source: 'acme/skills', ref: 'main', subDir: 'skills' })).toBe(
      'https://github.com/acme/skills/tree/main/skills'
    )
  })

  it('defaults ref to main when only a subdir is given', () => {
    expect(composeSource({ ...base, source: 'acme/skills', subDir: 'pack' })).toBe(
      'https://github.com/acme/skills/tree/main/pack'
    )
  })

  it('leaves an already-tree source alone', () => {
    const source = 'https://github.com/acme/skills/tree/main/pack'
    expect(composeSource({ ...base, source, ref: 'ignored' })).toBe(source)
  })

  it('does not compose non-github sources', () => {
    expect(composeSource({ ...base, source: 'https://gitlab.com/acme/skills', ref: 'v1' })).toBe(
      'https://gitlab.com/acme/skills'
    )
  })
})

describe('installSkills reconcile and containment', () => {
  let root: string
  let cwd: string
  let stateDir: string
  let outside: string
  const marker = () => join(stateDir, '.agentconnect', 'skills-install.json')
  const writeMarker = (value: unknown) => {
    mkdirSync(join(stateDir, '.agentconnect'), { recursive: true })
    writeFileSync(marker(), JSON.stringify(value))
  }
  const readMarker = () =>
    JSON.parse(readFileSync(marker(), 'utf8')) as {
      workspaces: Record<string, { fingerprint?: string; installed: string[] }>
    }
  const markerRecords = () => Object.values(readMarker().workspaces)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'agent')
    outside = join(root, 'outside')
    mkdirSync(cwd)
    mkdirSync(stateDir)
    mkdirSync(outside)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('stores reconciliation state in the daemon-owned agent directory', async () => {
    const legacy = join(cwd, '.agentconnect', 'skills-install.json')
    mkdirSync(join(cwd, '.agentconnect'))
    writeFileSync(legacy, JSON.stringify({ fingerprint: 'untrusted', installed: ['/etc'] }))

    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })

    expect(existsSync(marker())).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })

  it.each([
    { runtime: 'claude', agentId: 'claude-code', rootRel: '.claude/skills' },
    { runtime: 'codex-acp', agentId: 'codex', rootRel: '.agents/skills' }
  ])('installs and later reconciles $runtime copies', async ({ runtime, agentId, rootRel }) => {
    const calls: Array<{ file: string; args: string[] }> = []
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args })
      mkdirSync(join(cwd, ...rootRel.split('/'), 'review-pr'), { recursive: true })
    }

    const installed = await installSkills(
      { id: 'a1', runtime, skills: [{ name: 'source', source: 'acme/skills', skills: ['review-pr'] }] },
      cwd,
      { stateDir, execFile: exec }
    )

    expect(installed.installed).toEqual(['source'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe(process.execPath)
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(['__skills-cli', 'add', 'acme/skills', '-a', agentId, '-y', '--copy'])
    )
    expect(markerRecords()).toEqual([expect.objectContaining({ installed: [`${rootRel}/review-pr`] })])

    const removed = await installSkills({ id: 'a1', runtime, skills: [] }, cwd, { stateDir })
    expect(removed.removed).toEqual([`${rootRel}/review-pr`])
    expect(existsSync(join(cwd, ...rootRel.split('/'), 'review-pr'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('runs the bundled CLI, not a workspace-local skills package', async () => {
    const sentinel = join(outside, 'workspace-package-ran')
    const localBin = join(cwd, 'node_modules', '.bin', 'skills')
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(localBin, `#!/bin/sh\ntouch '${sentinel}'\n`)
    chmodSync(localBin, 0o755)
    const source = join(outside, 'source')
    mkdirSync(source)
    writeFileSync(
      join(source, 'SKILL.md'),
      [
        '---',
        'name: safe-copy',
        'description: Verifies the daemon-bundled skills CLI.',
        '---',
        '',
        '# Safe copy',
        ''
      ].join('\n')
    )
    mkdirSync(join(cwd, '.claude', 'skills', 'safe-copy'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'skills', 'safe-copy', 'OLD'), 'old daemon copy')

    const result = await installSkills(
      { id: 'a1', runtime: 'claude', skills: [{ name: 'source', source, skills: [] }] },
      cwd,
      { stateDir }
    )

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual(['source'])
    expect(existsSync(join(cwd, '.claude', 'skills', 'safe-copy', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(cwd, '.claude', 'skills', 'safe-copy', 'OLD'))).toBe(false)
    expect(markerRecords()).toEqual([expect.objectContaining({ installed: ['.claude/skills/safe-copy'] })])
    expect(existsSync(sentinel)).toBe(false)
  })

  it('keeps manually-authored skills while removing recorded copies', async () => {
    mkdirSync(join(cwd, '.claude', 'skills', 'mine'), { recursive: true })
    await installSkills(
      { id: 'a1', runtime: 'claude', skills: [{ name: 'source', source: 'acme/skills', skills: [] }] },
      cwd,
      {
        stateDir,
        execFile: async () => {
          mkdirSync(join(cwd, '.claude', 'skills', 'daemon-installed'), { recursive: true })
        }
      }
    )

    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })

    expect(existsSync(join(cwd, '.claude', 'skills', 'mine'))).toBe(true)
    expect(existsSync(join(cwd, '.claude', 'skills', 'daemon-installed'))).toBe(false)
  })

  it('does not carry daemon ownership into a different workspace', async () => {
    const desired = {
      id: 'a1',
      runtime: 'claude',
      skills: [{ name: 'source', source: 'acme/skills', skills: ['same-name'] }]
    }
    await installSkills(desired, cwd, {
      stateDir,
      execFile: async () => {
        mkdirSync(join(cwd, '.claude', 'skills', 'same-name'), { recursive: true })
      }
    })

    const nextCwd = join(root, 'workspace-b')
    const manual = join(nextCwd, '.claude', 'skills', 'same-name')
    mkdirSync(manual, { recursive: true })
    writeFileSync(join(manual, 'MANUAL'), 'keep')
    let installs = 0

    const reconciled = await installSkills(desired, nextCwd, {
      stateDir,
      execFile: async () => {
        installs += 1
      }
    })
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, nextCwd, { stateDir })

    expect(reconciled.skipped).toBeNull()
    expect(installs).toBe(1)
    expect(readFileSync(join(manual, 'MANUAL'), 'utf8')).toBe('keep')
  })

  it('retains independent ownership when switching away and back', async () => {
    const installed = join(cwd, '.claude', 'skills', 'owned-in-a')
    await installSkills(
      { id: 'a1', runtime: 'claude', skills: [{ name: 'source', source: 'acme/skills', skills: [] }] },
      cwd,
      {
        stateDir,
        execFile: async () => {
          mkdirSync(installed, { recursive: true })
        }
      }
    )

    const nextCwd = join(root, 'workspace-b')
    mkdirSync(nextCwd)
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, nextCwd, { stateDir })
    const reconciled = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })

    expect(reconciled.removed).toEqual(['.claude/skills/owned-in-a'])
    expect(existsSync(installed)).toBe(false)
  })

  it('reclaims ownership capacity after the workspace directory is replaced', async () => {
    const desired = {
      id: 'a1',
      runtime: 'claude',
      skills: [{ name: 'source', source: 'acme/skills', skills: [] }]
    }
    const replacements = Array.from({ length: 16 }, (_, index) => join(root, `replacement-${index}`))
    for (const replacement of replacements) mkdirSync(replacement)

    for (let replacement = 0; replacement <= 16; replacement += 1) {
      if (replacement > 0) {
        rmSync(cwd, { recursive: true, force: true })
        renameSync(replacements[replacement - 1]!, cwd)
      }
      const result = await installSkills(desired, cwd, {
        stateDir,
        execFile: async () => {
          mkdirSync(join(cwd, '.claude', 'skills', `copy-${replacement}`), { recursive: true })
        }
      })

      expect(result.errors).toEqual([])
    }

    expect(Object.keys(readMarker().workspaces)).toHaveLength(16)
  })

  it('uses an intact private fingerprint as the unchanged fast path', async () => {
    const first = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })
    expect(first.skipped).toBeNull()
    mkdirSync(join(cwd, '.claude', 'skills', 'untracked'), { recursive: true })

    const second = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })

    expect(second.skipped).toBe('unchanged')
    expect(existsSync(join(cwd, '.claude', 'skills', 'untracked'))).toBe(true)
  })

  it('an unmapped runtime still reconciles prior daemon-owned copies', async () => {
    await installSkills(
      { id: 'a1', runtime: 'codex', skills: [{ name: 'source', source: 'acme/skills', skills: [] }] },
      cwd,
      {
        stateDir,
        execFile: async () => {
          mkdirSync(join(cwd, '.agents', 'skills', 'x'), { recursive: true })
        }
      }
    )

    await installSkills(
      { id: 'a1', runtime: 'exotic-agent', skills: [{ name: 'x', source: 'o/r', skills: [] }] },
      cwd,
      { stateDir }
    )

    expect(existsSync(join(cwd, '.agents', 'skills', 'x'))).toBe(false)
  })

  it('ignores marker entries outside direct managed-root children', async () => {
    mkdirSync(join(cwd, 'sub', 'keep'), { recursive: true })
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })
    const saved = readMarker()
    const workspaceId = Object.keys(saved.workspaces)[0]!
    saved.workspaces[workspaceId] = {
      fingerprint: 'old',
      installed: ['.claude/skills/../../sub/keep', '../outside', '/etc']
    }
    writeMarker(saved)

    const result = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })

    expect(existsSync(join(cwd, 'sub', 'keep'))).toBe(true)
    expect(result.removed).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked private marker without touching its target',
    async () => {
      const canary = join(outside, 'marker.json')
      writeFileSync(canary, 'CANARY')
      mkdirSync(join(stateDir, '.agentconnect'))
      symlinkSync(canary, marker(), 'file')

      const result = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })

      expect(result.errors[0]?.source).toBe('*')
      expect(readFileSync(canary, 'utf8')).toBe('CANARY')
    }
  )

  it.skipIf(process.platform === 'win32')('refuses a symlinked skill root before invoking the CLI', async () => {
    const canary = join(outside, 'keep')
    writeFileSync(canary, 'CANARY')
    mkdirSync(join(cwd, '.claude'))
    symlinkSync(outside, join(cwd, '.claude', 'skills'), 'dir')
    let invoked = false

    const result = await installSkills(
      { id: 'a1', runtime: 'claude', skills: [{ name: 'source', source: 'acme/skills', skills: [] }] },
      cwd,
      {
        stateDir,
        execFile: async () => {
          invoked = true
        }
      }
    )

    expect(invoked).toBe(false)
    expect(result.errors[0]?.error).toMatch(/symlink|non-directory/)
    expect(readFileSync(canary, 'utf8')).toBe('CANARY')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked CLI lock before invoking the CLI', async () => {
    const canary = join(outside, 'lock.json')
    writeFileSync(canary, 'CANARY')
    symlinkSync(canary, join(cwd, 'skills-lock.json'), 'file')
    let invoked = false

    await installSkills(
      { id: 'a1', runtime: 'claude', skills: [{ name: 'source', source: 'acme/skills', skills: [] }] },
      cwd,
      {
        stateDir,
        execFile: async () => {
          invoked = true
        }
      }
    )

    expect(invoked).toBe(false)
    expect(readFileSync(canary, 'utf8')).toBe('CANARY')
  })
})
