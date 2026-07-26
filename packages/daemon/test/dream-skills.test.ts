import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptedDreamSkillSources } from '../src/skills/dream-skills.js'

async function agentWithAcceptedSkill(name = 'deploy-staging') {
  const dir = await mkdtemp(join(tmpdir(), 'ac-agent-'))
  await mkdir(join(dir, 'skills', name), { recursive: true })
  await writeFile(join(dir, 'skills', name, 'SKILL.md'), '# Deploy\n', 'utf8')
  return dir
}

describe('accepted dream skills → installer sources', () => {
  it('presents each accepted skill as a local source for the existing installer', async () => {
    // The daemon does no filesystem work in the agent-writable workspace: the
    // `npx skills` installer that already owns that directory materializes these.
    const dir = await agentWithAcceptedSkill()
    expect(await acceptedDreamSkillSources({ dir })).toEqual([
      { name: 'dream:deploy-staging', source: join(dir, 'skills', 'deploy-staging'), skills: [] }
    ])
  })

  it('is empty for an agent that has accepted nothing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ac-agent-'))
    expect(await acceptedDreamSkillSources({ dir: empty })).toEqual([])
    // …and for an agent root that does not exist at all.
    expect(await acceptedDreamSkillSources({ dir: join(empty, 'nope') })).toEqual([])
  })

  it('never hands a symlink to the installer as a source', async () => {
    // The accepted-skills dir sits under the agent root, but treat a link there
    // as hostile anyway rather than passing an escaping path to a subprocess.
    const dir = await agentWithAcceptedSkill()
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'))
    await symlink(outside, join(dir, 'skills', 'sneaky'), 'dir')
    const sources = await acceptedDreamSkillSources({ dir })
    expect(sources.map((s) => s.name)).toEqual(['dream:deploy-staging'])
  })

  it('ignores entries whose names are not valid skill names', async () => {
    const dir = await agentWithAcceptedSkill()
    await mkdir(join(dir, 'skills', 'Not Kebab'), { recursive: true })
    await writeFile(join(dir, 'skills', 'loose-file.md'), 'x', 'utf8')
    const sources = await acceptedDreamSkillSources({ dir })
    expect(sources.map((s) => s.name)).toEqual(['dream:deploy-staging'])
  })
})
