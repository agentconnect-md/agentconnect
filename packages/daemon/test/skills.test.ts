import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeSource, installSkills, resolveSkillsCliSpec } from '../src/skills/install-skills.js'
import { skillsAgentId } from '../src/skills/runtime-agent-map.js'

describe('skillsAgentId', () => {
  it('maps known runtimes (bare + acp-suffixed) to npx-skills agent ids', () => {
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

describe('resolveSkillsCliSpec (AC_SKILLS_CLI pin)', () => {
  it('defaults to "skills" when unset', () => {
    expect(resolveSkillsCliSpec({})).toBe('skills')
  })
  it('honors a clean pinned version spec', () => {
    expect(resolveSkillsCliSpec({ AC_SKILLS_CLI: 'skills@1.4.0' })).toBe('skills@1.4.0')
  })
  it('rejects option-like or whitespace-bearing values (no arg smuggling)', () => {
    expect(resolveSkillsCliSpec({ AC_SKILLS_CLI: '--evil' })).toBe('skills')
    expect(resolveSkillsCliSpec({ AC_SKILLS_CLI: 'skills --run x' })).toBe('skills')
    expect(resolveSkillsCliSpec({ AC_SKILLS_CLI: '   ' })).toBe('skills')
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
    const s = 'https://github.com/acme/skills/tree/main/pack'
    expect(composeSource({ ...base, source: s, ref: 'ignored' })).toBe(s)
  })

  it('does not compose non-github sources', () => {
    expect(composeSource({ ...base, source: 'https://gitlab.com/acme/skills', ref: 'v1' })).toBe(
      'https://gitlab.com/acme/skills'
    )
  })
})

describe('installSkills reconcile (no npx: empty/unmapped paths)', () => {
  let cwd: string
  const marker = () => join(cwd, '.agentconnect', 'skills-install.json')
  const writeMarker = (m: unknown) => {
    mkdirSync(join(cwd, '.agentconnect'), { recursive: true })
    writeFileSync(marker(), JSON.stringify(m))
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'skills-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('disabling the last skill removes previously-installed dirs and clears the marker', async () => {
    mkdirSync(join(cwd, '.claude', 'skills', 'review-pr'), { recursive: true })
    writeMarker({ fingerprint: 'old', installed: ['.claude/skills/review-pr'] })

    const res = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd)

    expect(existsSync(join(cwd, '.claude', 'skills', 'review-pr'))).toBe(false)
    expect(res.removed).toEqual(['.claude/skills/review-pr'])
    expect(JSON.parse(readFileSync(marker(), 'utf8'))).toMatchObject({ installed: [] })
  })

  it('never removes a manually-authored skill (one not recorded as daemon-installed)', async () => {
    mkdirSync(join(cwd, '.claude', 'skills', 'mine'), { recursive: true })
    mkdirSync(join(cwd, '.claude', 'skills', 'daemon-installed'), { recursive: true })
    writeMarker({ fingerprint: 'old', installed: ['.claude/skills/daemon-installed'] })

    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd)

    expect(existsSync(join(cwd, '.claude', 'skills', 'mine'))).toBe(true)
    expect(existsSync(join(cwd, '.claude', 'skills', 'daemon-installed'))).toBe(false)
  })

  it('changing AC_SKILLS_CLI invalidates the fingerprint (re-install, not skip)', async () => {
    const readFp = () => JSON.parse(readFileSync(marker(), 'utf8')).fingerprint as string
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { env: { AC_SKILLS_CLI: 'skills@1.0.0' } })
    const first = readFp()
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { env: { AC_SKILLS_CLI: 'skills@2.0.0' } })
    expect(readFp()).not.toBe(first) // the pinned CLI spec is part of the fingerprint
  })

  it('an unchanged fingerprint skips entirely (no removal)', async () => {
    // fingerprint of runtime=claude, agentId=claude-code, skills=[] — recompute-stable.
    const first = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd)
    expect(first.skipped).toBeNull() // first run writes the marker
    mkdirSync(join(cwd, '.claude', 'skills', 'untracked'), { recursive: true })
    const second = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd)
    expect(second.skipped).toBe('unchanged')
    expect(existsSync(join(cwd, '.claude', 'skills', 'untracked'))).toBe(true)
  })

  it('an unmapped runtime still reconciles away prior daemon-installed copies', async () => {
    mkdirSync(join(cwd, '.agents', 'skills', 'x'), { recursive: true })
    writeMarker({ fingerprint: 'old', installed: ['.agents/skills/x'] })
    await installSkills({ id: 'a1', runtime: 'exotic-agent', skills: [{ name: 'x', source: 'o/r', skills: [] }] }, cwd)
    expect(existsSync(join(cwd, '.agents', 'skills', 'x'))).toBe(false)
  })

  it('only removes marker paths that are direct children of a managed skill root', async () => {
    // The marker lives in the workspace, so its paths are untrusted input. An entry
    // that resolves outside a managed skill root must be ignored — the reconcile only
    // acts on paths matching the strict "<root>/<segment>" grammar.
    mkdirSync(join(cwd, 'sub', 'keep'), { recursive: true })
    writeMarker({ fingerprint: 'old', installed: ['.claude/skills/../../sub/keep', '../outside', '/etc'] })
    const res = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd)
    expect(existsSync(join(cwd, 'sub', 'keep'))).toBe(true) // unrelated dir untouched
    expect(res.removed).toEqual([]) // none matched the managed-root grammar
  })
})
