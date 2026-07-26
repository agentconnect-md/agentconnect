import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptedDreamSkillNames } from '../src/skills/dream-skills.js'

async function agentWithAcceptedSkill(name = 'deploy-staging') {
  const dir = await mkdtemp(join(tmpdir(), 'ac-agent-'))
  await mkdir(join(dir, 'skills', name), { recursive: true })
  await writeFile(join(dir, 'skills', name, 'SKILL.md'), '# Deploy\n', 'utf8')
  return dir
}

describe('accepted dream skills', () => {
  it('lists what the agent has accepted, from the daemon-owned agent root', async () => {
    const dir = await agentWithAcceptedSkill()
    expect(await acceptedDreamSkillNames({ dir })).toEqual(['deploy-staging'])
  })

  it('is empty when nothing has been accepted', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ac-agent-'))
    expect(await acceptedDreamSkillNames({ dir: empty })).toEqual([])
    expect(await acceptedDreamSkillNames({ dir: join(empty, 'nope') })).toEqual([])
  })

  it('never lists a symlink or an invalid skill name', async () => {
    const dir = await agentWithAcceptedSkill()
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await symlink(outside, join(dir, 'skills', 'sneaky'), 'dir')
    await mkdir(join(dir, 'skills', 'Not Kebab'), { recursive: true })
    await writeFile(join(dir, 'skills', 'loose-file.md'), 'x', 'utf8')
    expect(await acceptedDreamSkillNames({ dir })).toEqual(['deploy-staging'])
  })
})
