import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('REFUSES a planted .agentconnect symlink instead of writing the marker through it', async () => {
    // The marker is a daemon-authority write under the agent-writable cwd too —
    // a plain writeFile followed `.agentconnect -> outside` and clobbered a file
    // there.
    const { dir, cwd } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await writeFile(join(outside, 'dream-skills-install.json'), 'CANARY', 'utf8')
    await symlink(outside, join(cwd, '.agentconnect'), 'dir')

    const warnings: string[] = []
    await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd, { warn: (m) => warnings.push(m) })

    // The canary is intact and the refusal was reported as a security event.
    expect(await readFile(join(outside, 'dream-skills-install.json'), 'utf8')).toBe('CANARY')
    expect(warnings.join(' ')).toContain('refused to write the dream-skill marker')
  })

  it('serializes concurrent preparation so neither agent’s ownership is lost', async () => {
    // Both agents read the same prior marker, both install, and each overwrites
    // the other's record — leaving one skill on disk that no later pass can
    // reconcile away. The transaction must be serialized per canonical cwd.
    const { dir: dirA, cwd, name: nameA } = await fixture('skill-a')
    const { dir: dirB, name: nameB } = await fixture('skill-b')

    await Promise.all([
      materializeAcceptedDreamSkills({ dir: dirA, runtime: 'claude' }, cwd),
      materializeAcceptedDreamSkills({ dir: dirB, runtime: 'claude' }, cwd)
    ])

    // A third agent with nothing accepted must be able to clear the root: that
    // only works if the marker recorded whichever set actually survived.
    const dirC = await mkdtemp(join(tmpdir(), 'ac-agent-c-'))
    await materializeAcceptedDreamSkills({ dir: dirC, runtime: 'claude' }, cwd)

    expect(existsSync(join(cwd, '.claude/skills', nameA))).toBe(false)
    expect(existsSync(join(cwd, '.claude/skills', nameB))).toBe(false)
  })

  it('REFUSES a symlinked marker FILE rather than reading through it', async () => {
    // containedTarget validates parents but returns the final name — so an
    // outside marker was still read, and drove deletion of a peer skill.
    const { dir, cwd, name } = await fixture()
    await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)

    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await writeFile(join(outside, 'marker.json'), JSON.stringify({ installed: [`.claude/skills/${name}`] }), 'utf8')
    await rm(join(cwd, '.agentconnect', 'dream-skills-install.json'))
    await symlink(join(outside, 'marker.json'), join(cwd, '.agentconnect', 'dream-skills-install.json'), 'file')

    // A second agent with nothing accepted must NOT act on that outside marker.
    const dirB = await mkdtemp(join(tmpdir(), 'ac-agent-b-'))
    const result = await materializeAcceptedDreamSkills({ dir: dirB, runtime: 'claude' }, cwd)
    expect(result.removed).toEqual([]) // the planted marker was not obeyed
  })

  it('fails closed when ownership cannot be recorded, rather than installing untracked', async () => {
    // Marker refused (.agentconnect symlinked out) + skill installed anyway =
    // an untracked skill no later pass can reconcile away. Install nothing.
    const { dir, cwd, name } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await symlink(outside, join(cwd, '.agentconnect'), 'dir')

    const result = await materializeAcceptedDreamSkills({ dir, runtime: 'claude' }, cwd)
    expect(result.installed).toEqual([])
    expect(existsSync(join(cwd, '.claude/skills', name))).toBe(false)
    expect(result.errors.some((e) => /ownership could not be recorded/.test(e.error))).toBe(true)
  })

  it('keeps owning a stale skill whose removal was REFUSED, even when another succeeds', async () => {
    // Mixed pass: A's removal is refused (planted symlink), B's succeeds.
    // Deriving ownership only from successes forgets A — and once A's real
    // directory is restored nothing ever reconciles it away again.
    const { dir: dirA, cwd } = await fixture('skill-a')
    await materializeAcceptedDreamSkills({ dir: dirA, runtime: 'claude' }, cwd)
    const { dir: dirB } = await fixture('skill-b')
    // Install B alongside A by pointing one agent root at both.
    await mkdir(join(dirA, 'skills', 'skill-b'), { recursive: true })
    await writeFile(join(dirA, 'skills', 'skill-b', 'SKILL.md'), '# B\n', 'utf8')
    await materializeAcceptedDreamSkills({ dir: dirA, runtime: 'claude' }, cwd)
    expect(existsSync(join(cwd, '.claude/skills/skill-a'))).toBe(true)
    expect(existsSync(join(cwd, '.claude/skills/skill-b'))).toBe(true)

    // Make skill-a's removal refuse, then prepare an agent that wants neither.
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await rm(join(cwd, '.claude/skills/skill-a'), { recursive: true })
    await symlink(outside, join(cwd, '.claude/skills/skill-a'), 'dir')
    const empty = await mkdtemp(join(tmpdir(), 'ac-agent-e-'))
    const mixed = await materializeAcceptedDreamSkills({ dir: empty, runtime: 'claude' }, cwd)
    expect(mixed.removed).toEqual(['.claude/skills/skill-b']) // only B went

    // Restore skill-a as a real directory; a later pass must still reconcile it.
    await rm(join(cwd, '.claude/skills/skill-a'))
    await mkdir(join(cwd, '.claude/skills/skill-a'), { recursive: true })
    await writeFile(join(cwd, '.claude/skills/skill-a', 'SKILL.md'), '# A\n', 'utf8')
    const after = await materializeAcceptedDreamSkills({ dir: empty, runtime: 'claude' }, cwd)
    expect(after.removed).toEqual(['.claude/skills/skill-a'])
    expect(existsSync(join(cwd, '.claude/skills/skill-a'))).toBe(false)
    void dirB
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
