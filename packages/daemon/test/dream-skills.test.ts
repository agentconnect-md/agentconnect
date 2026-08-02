import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptedDreamSkillSources, publishAcceptedDreamSkill } from '../src/skills/dream-skills.js'

async function fixture(body: string): Promise<{ agentDir: string; sourceDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'ac-accepted-skill-'))
  const agentDir = join(base, 'agent')
  const sourceDir = join(base, 'staged')
  await mkdir(agentDir, { mode: 0o700 })
  await mkdir(sourceDir, { mode: 0o700 })
  await writeFile(join(sourceDir, 'SKILL.md'), body)
  return { agentDir, sourceDir }
}

describe('accepted Dream skill registry', () => {
  it('publishes immutable revisions and atomically selects the latest bytes', async () => {
    const { agentDir, sourceDir } = await fixture('# version one\n')
    const first = await publishAcceptedDreamSkill({ agentDir, sourceDir, name: 'deploy-staging' })

    // Republishing identical reviewed bytes is idempotent on every supported
    // rename errno and still verifies the existing digest-addressed directory.
    await expect(publishAcceptedDreamSkill({ agentDir, sourceDir, name: 'deploy-staging' })).resolves.toEqual(first)

    await writeFile(join(sourceDir, 'SKILL.md'), '# version two\n')
    const second = await publishAcceptedDreamSkill({ agentDir, sourceDir, name: 'deploy-staging' })
    expect(second.digest).not.toBe(first.digest)

    const active = await acceptedDreamSkillSources({ dir: agentDir })
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ name: 'deploy-staging', contentDigest: second.digest })
    expect(await readFile(join(active[0]!.sourceDir, 'SKILL.md'), 'utf8')).toBe('# version two\n')
  })

  it('fails closed when immutable accepted bytes no longer match the published digest', async () => {
    const { agentDir, sourceDir } = await fixture('# reviewed\n')
    const published = await publishAcceptedDreamSkill({ agentDir, sourceDir, name: 'deploy-staging' })
    await writeFile(join(published.sourceDir, 'SKILL.md'), '# tampered\n')

    await expect(acceptedDreamSkillSources({ dir: agentDir })).rejects.toThrow(/published digest/)
  })

  it('bounds orphan-registry traversal before admitting another immutable bundle', async () => {
    const { agentDir, sourceDir } = await fixture('# reviewed\n')
    const bundles = join(agentDir, 'skills/.bundles')
    await mkdir(bundles, { recursive: true })
    for (let index = 0; index < 513; index += 1) {
      await mkdir(join(bundles, `orphan-${index.toString().padStart(3, '0')}`))
    }

    await expect(publishAcceptedDreamSkill({ agentDir, sourceDir, name: 'deploy-staging' })).rejects.toThrow(
      /too many entries/
    )
  })

  it('never auto-enrolls legacy-shaped directories when the reviewed index is absent', async () => {
    const { agentDir } = await fixture('# staged but not accepted\n')
    const planted = join(agentDir, 'skills/evil')
    await mkdir(planted, { recursive: true })
    await writeFile(join(planted, 'SKILL.md'), '# planted by an untrusted child\n')

    await expect(acceptedDreamSkillSources({ dir: agentDir })).resolves.toEqual([])
  })
})
