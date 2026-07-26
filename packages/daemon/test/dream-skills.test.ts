import { mkdtemp, mkdir, readFile, rename, symlink, writeFile, readdir } from 'node:fs/promises'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installAcceptedDreamSkills } from '../src/skills/dream-skills.js'

/** An agent root holding one accepted dream skill. */
async function agentWithAcceptedSkill() {
  const dir = await mkdtemp(join(tmpdir(), 'ac-agent-'))
  await mkdir(join(dir, 'skills', 'deploy-staging'), { recursive: true })
  await writeFile(join(dir, 'skills', 'deploy-staging', 'SKILL.md'), '# Deploy\n', 'utf8')
  return dir
}

describe('accepted dream skills — workspace containment', () => {
  it('materializes into the runtime skill root', async () => {
    const dir = await agentWithAcceptedSkill()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-ws-'))
    expect(await installAcceptedDreamSkills({ dir, runtime: 'claude-acp' }, cwd)).toEqual(['deploy-staging'])
    expect(await readFile(join(cwd, '.claude/skills/deploy-staging/SKILL.md'), 'utf8')).toContain('# Deploy')
  })

  it('refuses to follow a skill-root symlink planted in the workspace', async () => {
    // The workspace is agent-writable and the daemon runs OUTSIDE the agent's
    // sandbox, so following this link would let the agent steer daemon writes
    // (and a recursive rm) to any path on the host.
    const dir = await agentWithAcceptedSkill()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await writeFile(join(outside, 'precious.txt'), 'do not delete', 'utf8')
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await symlink(outside, join(cwd, '.claude', 'skills'), 'dir')

    const warnings: string[] = []
    const installed = await installAcceptedDreamSkills({ dir, runtime: 'claude-acp' }, cwd, (m) => warnings.push(m))

    expect(installed).toEqual([]) // nothing installed
    expect(warnings.join(' ')).toMatch(/symlink/)
    // Nothing was written to — or deleted from — the linked-to directory.
    expect(await readdir(outside)).toEqual(['precious.txt'])
  })

  it('refuses a symlinked leaf even when the root itself is honest', async () => {
    const dir = await agentWithAcceptedSkill()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await writeFile(join(outside, 'precious.txt'), 'do not delete', 'utf8')
    await mkdir(join(cwd, '.claude', 'skills'), { recursive: true })
    await symlink(outside, join(cwd, '.claude', 'skills', 'deploy-staging'), 'dir')

    const warnings: string[] = []
    expect(await installAcceptedDreamSkills({ dir, runtime: 'claude-acp' }, cwd, (m) => warnings.push(m))).toEqual([])
    expect(await readdir(outside)).toEqual(['precious.txt'])
  })

  it('is a no-op for an agent with no accepted skills, and for an unmapped runtime', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ac-agent-'))
    const cwd = await mkdtemp(join(tmpdir(), 'ac-ws-'))
    expect(await installAcceptedDreamSkills({ dir: empty, runtime: 'claude-acp' }, cwd)).toEqual([])

    const dir = await agentWithAcceptedSkill()
    expect(await installAcceptedDreamSkills({ dir, runtime: 'no-such-runtime' }, cwd)).toEqual([])
  })
})

describe('accepted dream skills — concurrent swap (check/use)', () => {
  it('detects the skill root being replaced AFTER validation and writes nothing outside', async () => {
    // Validating once and then writing by path is a check/use gap: the workspace
    // is agent-writable, so a concurrent process can swap `.claude/skills` for a
    // symlink between the check and the copy. Swap in the window right after the
    // destination `rm` — the real window an attacker races for.
    const dir = await agentWithAcceptedSkill()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await writeFile(join(outside, 'precious.txt'), 'do not delete', 'utf8')
    const root = join(cwd, '.claude', 'skills')

    const realRm = fsp.rm.bind(fsp)
    let swapped = false
    const spy = vi.spyOn(fsp, 'rm').mockImplementation(async (...args: Parameters<typeof realRm>) => {
      const out = await realRm(...args)
      if (!swapped) {
        swapped = true
        await realRm(root, { recursive: true, force: true })
        await symlink(outside, root, 'dir')
      }
      return out
    })

    const warnings: string[] = []
    const installed = await installAcceptedDreamSkills({ dir, runtime: 'claude-acp' }, cwd, (m) => warnings.push(m))
    spy.mockRestore()

    expect(swapped).toBe(true) // the race actually happened
    expect(installed).toEqual([]) // …and was detected, not followed
    expect(warnings.join(' ')).toMatch(/changed while installing/)
    // The attacker-controlled target is untouched: nothing written, nothing deleted.
    expect(await readdir(outside)).toEqual(['precious.txt'])
  })

  it('reports a swap that lands mid-copy instead of counting it as installed', async () => {
    const dir = await agentWithAcceptedSkill()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-ws-'))
    const cwd2 = await mkdtemp(join(tmpdir(), 'ac-ws2-'))
    // Validate against cwd, then rename the whole verified dir away mid-run.
    const root = join(cwd, '.claude', 'skills')
    await mkdir(root, { recursive: true })

    const realCp = fsp.cp.bind(fsp)
    const spy = vi.spyOn(fsp, 'cp').mockImplementation(async (...args: Parameters<typeof realCp>) => {
      const out = await realCp(...args)
      await rename(root, join(cwd2, 'moved-away')) // identity behind the path is gone
      return out
    })

    const warnings: string[] = []
    const installed = await installAcceptedDreamSkills({ dir, runtime: 'claude-acp' }, cwd, (m) => warnings.push(m))
    spy.mockRestore()

    expect(installed).toEqual([])
    expect(warnings.join(' ')).toMatch(/changed while installing/)
  })
})
