import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listLocalSkills, originForSourceKey } from '../src/skills/local-skill-inventory.js'

async function writeSkill(
  cwd: string,
  root: string,
  name: string,
  frontmatter: string,
  body = '# body\n'
): Promise<void> {
  const dir = join(cwd, root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8')
}

describe('local skill inventory', () => {
  it('maps a source key to its origin tag', () => {
    expect(originForSourceKey('dream:deploy:sha256:abc')).toBe('dream-accepted')
    expect(originForSourceKey('managed:id:1:sha256:abc')).toBe('managed')
    expect(originForSourceKey('git:github.com/acme/skills')).toBe('git-source')
  })

  it('lists workspace skills, parses frontmatter, and tags un-owned ones as repo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ac-localskills-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-skillstate-')) // no ledger here → all repo
    await writeSkill(cwd, '.claude/skills', 'deploy', 'name: deploy\ndescription: Ship the app')
    await writeSkill(cwd, '.claude/skills', 'triage', 'name: triage\ndescription: Triage issues')
    await writeSkill(cwd, '.agents/skills', 'notes', 'name: notes\ndescription: Take notes')
    // A directory without SKILL.md is not a skill and must be skipped.
    await mkdir(join(cwd, '.claude/skills', 'not-a-skill'), { recursive: true })
    // A symlinked skill dir must be ignored (no interpreting untrusted links).
    await mkdir(join(cwd, 'elsewhere', 'evil'), { recursive: true })
    await writeFile(join(cwd, 'elsewhere', 'evil', 'SKILL.md'), '---\nname: evil\ndescription: x\n---\n', 'utf8')
    await symlink(join(cwd, 'elsewhere', 'evil'), join(cwd, '.claude/skills', 'linked'))

    const skills = await listLocalSkills(cwd, stateDir)
    expect(skills.map((s) => s.name)).toEqual(['deploy', 'notes', 'triage']) // sorted, no not-a-skill / linked
    expect(skills.every((s) => s.origin === 'repo')).toBe(true)
    expect(skills.find((s) => s.name === 'deploy')).toMatchObject({
      description: 'Ship the app',
      path: '.claude/skills/deploy'
    })
    expect(skills.find((s) => s.name === 'notes')?.path).toBe('.agents/skills/notes')
  })

  it('falls back to the directory name and a null description when frontmatter is absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ac-localskills-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-skillstate-'))
    await mkdir(join(cwd, '.claude/skills', 'bare'), { recursive: true })
    await writeFile(join(cwd, '.claude/skills', 'bare', 'SKILL.md'), 'no frontmatter here\n', 'utf8')

    const skills = await listLocalSkills(cwd, stateDir)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'bare', description: null, origin: 'repo' })
  })

  it('returns [] for an unmaterialized workspace with no skill roots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ac-localskills-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-skillstate-'))
    expect(await listLocalSkills(cwd, stateDir)).toEqual([])
  })
})
