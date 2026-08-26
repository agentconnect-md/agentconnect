import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { listLocalSkills, listSandboxSkills, originForSourceKey } from '../src/skills/local-skill-inventory.js'
import type { WorkspaceFiles } from '../src/workspace/workspace-files.js'

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
  it('classifies a cluster root only while its live receipt matches', async () => {
    const manifest = '---\nname: managed-one\ndescription: fixture\n---\n# body\n'
    let live = manifest
    const files = {
      async list(_root: string, req: { path: string }) {
        if (req.path === '.agents/skills')
          return { agentId: 'a', path: req.path, exists: true, entries: [{ name: 'managed-one', type: 'dir' }] }
        return { agentId: 'a', path: req.path, exists: false, entries: [] }
      },
      async read(_root: string, req: { path: string }) {
        return {
          agentId: 'a',
          path: req.path,
          exists: true,
          type: 'file',
          size: Buffer.byteLength(live),
          encoding: 'utf8',
          content: live,
          offset: 0,
          truncated: false
        }
      }
    } as WorkspaceFiles
    const ledger = {
      roots: [
        {
          path: '.agents/skills/managed-one',
          sourceId: 'managed:one',
          sourceKind: 'managed' as const,
          digest: 'a'.repeat(64),
          files: [
            {
              path: 'SKILL.md',
              size: Buffer.byteLength(manifest),
              sha256: createHash('sha256').update(manifest).digest('hex')
            }
          ]
        }
      ]
    }
    expect((await listSandboxSkills(files, '/workspace', 'a', ledger))[0]?.origin).toBe('managed')
    live += 'modified\n'
    expect((await listSandboxSkills(files, '/workspace', 'a', ledger))[0]?.origin).toBe('repo')
  })

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

  it('drops skills that escape the workspace via a symlinked root or a symlinked SKILL.md', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ac-localskills-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-skillstate-'))
    // A same-UID workspace elsewhere the hostile checkout tries to reach into.
    const other = await mkdtemp(join(tmpdir(), 'ac-otherws-'))
    await writeSkill(other, 'skills', 'stolen', 'name: stolen\ndescription: secret')

    // `.agents/skills` is a symlink to the other workspace's skills dir.
    await mkdir(join(cwd, '.agents'), { recursive: true })
    await symlink(join(other, 'skills'), join(cwd, '.agents/skills'))
    // A real skill dir whose SKILL.md is a symlink pointing outside.
    await mkdir(join(cwd, '.claude/skills', 'linkmd'), { recursive: true })
    await symlink(join(other, 'skills', 'stolen', 'SKILL.md'), join(cwd, '.claude/skills', 'linkmd', 'SKILL.md'))
    // A legitimate in-workspace skill that must still be listed.
    await writeSkill(cwd, '.claude/skills', 'ok', 'name: ok\ndescription: fine')

    const skills = await listLocalSkills(cwd, stateDir)
    expect(skills.map((s) => s.name)).toEqual(['ok']) // no 'stolen' (symlinked root), no 'linkmd' (symlinked SKILL.md)
  })

  it('lists a skill present under both roots only once', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ac-localskills-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-skillstate-'))
    // Same skill name installed/committed under both harness roots.
    await writeSkill(cwd, '.claude/skills', 'update-model-pricing', 'name: update-model-pricing\ndescription: prices')
    await writeSkill(cwd, '.agents/skills', 'update-model-pricing', 'name: update-model-pricing\ndescription: prices')
    await writeSkill(cwd, '.claude/skills', 'solo', 'name: solo\ndescription: one')

    const skills = await listLocalSkills(cwd, stateDir)
    expect(skills.map((s) => s.name)).toEqual(['solo', 'update-model-pricing']) // deduped, not two entries
    expect(skills.filter((s) => s.name === 'update-model-pricing')).toHaveLength(1)
  })

  it('returns [] for an unmaterialized workspace with no skill roots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ac-localskills-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-skillstate-'))
    expect(await listLocalSkills(cwd, stateDir)).toEqual([])
  })
})
