import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { persistSkillSandboxRequirement, skillSandboxRequirementPresent } from '../src/skills/skill-sandbox-policy.js'

describe('daemon-wide executable-skill sandbox policy', () => {
  let root: string
  let agentDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-sandbox-policy-'))
    agentDir = join(root, 'agents', 'a1')
    await mkdir(agentDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('becomes sticky when any sibling declares an executable source', async () => {
    const empty = { dir: agentDir, skills: [], managedSkills: [] }
    const enabled = { dir: join(root, 'agents', 'a2'), skills: [{ source: 'acme/skills' }], managedSkills: [] }

    expect(skillSandboxRequirementPresent(root, [empty])).toBe(false)
    expect(skillSandboxRequirementPresent(root, [empty, enabled])).toBe(true)
    await persistSkillSandboxRequirement(root)

    expect(existsSync(join(root, 'skill-installs', 'sandbox-required-v1'))).toBe(true)
    expect(skillSandboxRequirementPresent(root, [empty])).toBe(true)
  })

  it('recognizes accepted-local authority and rolling pre-marker ledgers', async () => {
    await mkdir(join(agentDir, 'skills'), { recursive: true })
    await writeFile(join(agentDir, 'skills', 'accepted-skills.json'), '{"version":1,"skills":[]}\n')
    expect(skillSandboxRequirementPresent(root, [{ dir: agentDir }])).toBe(true)

    await rm(join(agentDir, 'skills'), { recursive: true })
    await mkdir(join(root, 'skill-installs', 'workspace-skills'), { recursive: true })
    await writeFile(join(root, 'skill-installs', 'workspace-skills', 'legacy.json'), '{}\n')
    expect(skillSandboxRequirementPresent(root, [{ dir: agentDir }])).toBe(true)
  })
})
