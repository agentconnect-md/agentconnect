import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalSkillMutationRoot } from '../src/skills/skill-workspace-mutator.js'

const roots: string[] = []

async function workspace(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ac-skill-alias-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return { root, cwd }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('canonicalSkillMutationRoot', () => {
  it('maps a workspace-local skill-root alias to its real relative path', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, '.claude/skills'), { recursive: true })
    await mkdir(join(cwd, '.agents'))
    await symlink('../.claude/skills', join(cwd, '.agents/skills'))

    await expect(canonicalSkillMutationRoot(cwd, '.agents/skills/audit')).resolves.toBe('.claude/skills/audit')
  })

  it('leaves an ordinary or not-yet-created skill root unchanged', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, '.claude/skills'), { recursive: true })

    await expect(canonicalSkillMutationRoot(cwd, '.claude/skills/audit')).resolves.toBe('.claude/skills/audit')
    await expect(canonicalSkillMutationRoot(cwd, '.runtime/skills/audit')).resolves.toBe('.runtime/skills/audit')
  })

  it('refuses a skill-root alias that resolves outside the workspace', async () => {
    const { root, cwd } = await workspace()
    await mkdir(join(root, 'outside/skills'), { recursive: true })
    await mkdir(join(cwd, '.agents'))
    await symlink(join(root, 'outside/skills'), join(cwd, '.agents/skills'))

    await expect(canonicalSkillMutationRoot(cwd, '.agents/skills/audit')).rejects.toThrow(
      /alias resolves outside workspace/
    )
  })
})
