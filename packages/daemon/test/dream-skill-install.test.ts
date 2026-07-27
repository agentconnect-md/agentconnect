import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeAcceptedDreamSkills } from '../src/skills/dream-skill-install.js'
import { acceptedDreamSkillNames } from '../src/skills/dream-skills.js'

/** An agent root holding one accepted skill, plus an empty workspace cwd. */
async function fixture(name = 'deploy-staging') {
  const dir = await mkdtemp(join(tmpdir(), 'ac-agent-'))
  const cwd = await mkdtemp(join(tmpdir(), 'ac-cwd-'))
  await mkdir(join(dir, 'skills', name), { recursive: true })
  await writeFile(join(dir, 'skills', name, 'SKILL.md'), '---\nname: deploy\n---\n# Deploy\n', 'utf8')
  await writeFile(join(dir, 'skills', name, 'run.sh'), 'echo deploy\n', 'utf8')
  return { dir, cwd, name }
}

describe('materializeAcceptedDreamSkills', () => {
  it('copies an accepted skill into the runtime skill root the runtime actually reads', async () => {
    const { dir, cwd, name } = await fixture()
    const result = await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)

    expect(result.installed).toEqual([`.claude/skills/${name}`])
    expect(result.errors).toEqual([])
    expect(await readFile(join(cwd, '.claude/skills', name, 'SKILL.md'), 'utf8')).toContain('# Deploy')
    expect(await readFile(join(cwd, '.claude/skills', name, 'run.sh'), 'utf8')).toContain('echo deploy')
  })

  it('uses .agents/skills for non-Claude runtimes, and does nothing for an unmapped one', async () => {
    const { dir, cwd, name } = await fixture()
    expect((await materializeAcceptedDreamSkills({ dir, runtime: 'codex' }, cwd)).installed).toEqual([
      `.agents/skills/${name}`
    ])
    expect(existsSync(join(cwd, '.agents/skills', name, 'SKILL.md'))).toBe(true)

    const { dir: d2, cwd: c2 } = await fixture()
    expect((await materializeAcceptedDreamSkills({ dir: d2, runtime: 'not-a-runtime' }, c2)).installed).toEqual([])
  })

  it('REFUSES a workspace-planted skill-root symlink instead of writing through it', async () => {
    // The reproduced escape: a previous session points `.claude/skills` at an
    // outside directory, and a daemon-authority copy lands on the host.
    const { dir, cwd, name } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await writeFile(join(outside, 'canary.txt'), 'do not touch', 'utf8')
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await symlink(outside, join(cwd, '.claude', 'skills'), 'dir')

    const warnings: string[] = []
    const result = await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd, {
      warn: (m) => warnings.push(m)
    })

    expect(result.installed).toEqual([])
    expect(result.errors[0]?.error).toMatch(/symlink|non-directory/)
    expect(warnings.join(' ')).toContain('refused')
    // Nothing was created outside the workspace, and the canary is intact.
    expect(await readdir(outside)).toEqual(['canary.txt'])
    expect(existsSync(join(outside, name))).toBe(false)
  })

  it('REFUSES a symlink at the individual skill directory (the remove path)', async () => {
    const { dir, cwd, name } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8')
    await mkdir(join(cwd, '.claude', 'skills'), { recursive: true })
    // A prior copy replaced by a link — a naive rm -rf would delete `outside`.
    await symlink(outside, join(cwd, '.claude', 'skills', name), 'dir')

    const result = await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)
    expect(result.installed).toEqual([])
    expect(await readdir(outside)).toEqual(['keep.txt'])
  })

  it('replaces a previous real copy so an updated skill actually lands', async () => {
    const { dir, cwd, name } = await fixture()
    await mkdir(join(cwd, '.claude', 'skills', name), { recursive: true })
    await writeFile(join(cwd, '.claude/skills', name, 'SKILL.md'), 'stale', 'utf8')
    await writeFile(join(cwd, '.claude/skills', name, 'gone.md'), 'removed', 'utf8')

    await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)
    expect(await readFile(join(cwd, '.claude/skills', name, 'SKILL.md'), 'utf8')).toContain('# Deploy')
    expect(existsSync(join(cwd, '.claude/skills', name, 'gone.md'))).toBe(false)
  })

  it('copies the staged scripts/ subtree, not just the top level', async () => {
    // DreamRunner stages `<skill>/scripts/<file>`. Copying only top-level files
    // reported success while every reviewed script silently vanished.
    const { dir, cwd, name } = await fixture()
    await mkdir(join(dir, 'skills', name, 'scripts'), { recursive: true })
    await writeFile(join(dir, 'skills', name, 'scripts', 'run.sh'), '#!/bin/sh\necho go\n', 'utf8')

    const result = await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)
    expect(result.errors).toEqual([])
    expect(await readFile(join(cwd, '.claude/skills', name, 'scripts', 'run.sh'), 'utf8')).toContain('echo go')
  })

  it('does not leak one agent’s accepted skill into another sharing the checkout', async () => {
    // Shared checkouts are supported: preparing agent A then agent B must not
    // leave A's executable instruction content in B's discovery root.
    const { dir: dirA, cwd, name } = await fixture()
    await materializeAcceptedDreamSkills({ dir: dirA, runtime: 'claude' }, cwd)
    expect(existsSync(join(cwd, '.claude/skills', name, 'SKILL.md'))).toBe(true)

    // Agent B shares the cwd and has accepted nothing.
    const dirB = await mkdtemp(join(tmpdir(), 'ac-agent-b-'))
    const result = await materializeAcceptedDreamSkills({ dir: dirB, runtime: 'claude' }, cwd)

    expect(result.removed).toEqual([`.claude/skills/${name}`])
    expect(existsSync(join(cwd, '.claude/skills', name))).toBe(false)
  })

  it('leaves skills it does not own alone while reconciling', async () => {
    // Hand-authored skills (and anything installSkills owns) share the root.
    const { dir, cwd, name } = await fixture()
    await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)
    await mkdir(join(cwd, '.claude/skills', 'hand-written'), { recursive: true })
    await writeFile(join(cwd, '.claude/skills', 'hand-written', 'SKILL.md'), 'mine', 'utf8')

    const dirB = await mkdtemp(join(tmpdir(), 'ac-agent-b-'))
    await materializeAcceptedDreamSkills({ dir: dirB, runtime: 'claude' }, cwd)

    expect(existsSync(join(cwd, '.claude/skills', name))).toBe(false) // ours, reconciled away
    expect(existsSync(join(cwd, '.claude/skills', 'hand-written', 'SKILL.md'))).toBe(true) // not ours
  })

  it('skips a malformed accepted skill without failing the others', async () => {
    const { dir, cwd } = await fixture()
    await mkdir(join(dir, 'skills', 'broken'), { recursive: true })
    await writeFile(join(dir, 'skills', 'broken', 'notes.md'), 'no SKILL.md here', 'utf8')

    const result = await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)
    expect(result.installed).toEqual(['.claude/skills/deploy-staging'])
    expect(result.errors[0]).toMatchObject({ skill: 'broken' })
  })

  it('never lists a symlinked or badly-named entry as accepted', async () => {
    const { dir } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await symlink(outside, join(dir, 'skills', 'sneaky'), 'dir')
    await mkdir(join(dir, 'skills', 'Not Kebab'), { recursive: true })
    expect(await acceptedDreamSkillNames({ dir })).toEqual(['deploy-staging'])
  })
})
