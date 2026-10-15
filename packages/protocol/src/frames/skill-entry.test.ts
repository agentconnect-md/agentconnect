import { describe, it, expect } from 'vitest'
import { AgentSkillEntry, AgentSpec, InstallableAgentSkills, skillSourceCredential } from './agent.js'

describe('AgentSkillEntry — argument-injection guards', () => {
  it('accepts a normal entry and defaults skills to []', () => {
    const e = AgentSkillEntry.parse({ name: 'platform', source: 'acme/platform-skills', githubRepoId: '123' })
    expect(e.skills).toEqual([])
  })

  it('requires an exact positive numeric GitHub repository identity on current projections', () => {
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r' }).success).toBe(false)
    for (const githubRepoId of ['', '0', '-1', '+1', '01', '1.0', 'x', '1'.repeat(21)]) {
      expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId }).success, githubRepoId).toBe(false)
    }
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '12345678901234567890' }).success).toBe(
      true
    )
  })

  it('rejects an option-like source (would be parsed as a CLI flag)', () => {
    expect(AgentSkillEntry.safeParse({ name: 'x', source: '--all', githubRepoId: '1' }).success).toBe(false)
    expect(AgentSkillEntry.safeParse({ name: 'x', source: '-rf', githubRepoId: '1' }).success).toBe(false)
  })

  it('rejects selections outside the publisher bundle grammar', () => {
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['--all'] }).success).toBe(
      false
    )
    expect(
      AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['ok', '-bad'] }).success
    ).toBe(false)
    expect(
      AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['.hidden'] }).success
    ).toBe(false)
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['_tool'] }).success).toBe(
      false
    )
    expect(
      AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['bad/name'] }).success
    ).toBe(false)
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['Foo'] }).success).toBe(
      false
    )
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['foo.'] }).success).toBe(
      false
    )
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['foo-'] }).success).toBe(
      false
    )
  })

  it('accepts ordinary skill names', () => {
    const e = AgentSkillEntry.parse({
      name: 'x',
      source: 'o/r',
      githubRepoId: '1',
      skills: ['review-pr', 'safe_deploy', 'a.-_']
    })
    expect(e.skills).toEqual(['review-pr', 'safe_deploy', 'a.-_'])
  })

  it('accepts only the bounded GitHub source vocabulary', () => {
    for (const source of [
      'o/r',
      'github.com/o/r',
      'https://github.com/o/r.git',
      'https://github.com/o/r/tree/main/skills',
      'ssh://git@github.com/o/r.git',
      'git@github.com:o/r.git'
    ]) {
      expect(AgentSkillEntry.safeParse({ name: 'x', source, githubRepoId: '1' }).success, source).toBe(true)
    }

    for (const source of [
      'https://github.com:8443/o/r',
      'ssh://git@github.com:2222/o/r',
      'ssh://deploy@github.com/o/r',
      'git@github.com:/o/r'
    ]) {
      expect(AgentSkillEntry.safeParse({ name: 'x', source, githubRepoId: '1' }).success, source).toBe(false)
    }
  })

  it('accepts a plain HTTPS address on another host, without a GitHub identity', () => {
    for (const source of ['https://gitlab.com/group/sub/project', 'https://git.example.test/team/skills.git']) {
      expect(AgentSkillEntry.safeParse({ name: 'x', source }).success, source).toBe(true)
      expect(AgentSkillEntry.safeParse({ name: 'x', source, githubRepoId: '1' }).success, source).toBe(false)
    }
    for (const source of [
      'git@gitlab.com:group/project.git',
      'ssh://git@git.example.test/team/skills.git',
      'https://git.example.test/team/../skills',
      'https://user@git.example.test/team/skills',
      'https://git.example.test/team/skills?x=1'
    ]) {
      expect(AgentSkillEntry.safeParse({ name: 'x', source }).success, source).toBe(false)
    }
  })

  it('pairs a credential with the host it vouches for', () => {
    const gitlab = { name: 'x', source: 'https://gitlab.com/group/project' }
    expect(AgentSkillEntry.safeParse({ ...gitlab, credential: { provider: 'gitlab', projectId: '42' } }).success).toBe(
      true
    )
    expect(AgentSkillEntry.safeParse({ ...gitlab, credential: { provider: 'gitlab', projectId: '042' } }).success).toBe(
      false
    )
    expect(AgentSkillEntry.safeParse({ ...gitlab, credential: { provider: 'github' } }).success).toBe(false)
    expect(AgentSkillEntry.safeParse({ ...gitlab, private: true }).success).toBe(false)

    const github = { name: 'x', source: 'o/r', githubRepoId: '7' }
    expect(AgentSkillEntry.safeParse({ ...github, credential: { provider: 'github' }, private: true }).success).toBe(
      true
    )
    expect(AgentSkillEntry.safeParse({ ...github, credential: { provider: 'gitlab', projectId: '1' } }).success).toBe(
      false
    )
  })

  it('reads the legacy private flag as a GitHub credential', () => {
    expect(skillSourceCredential({ private: true })).toEqual({ provider: 'github' })
    expect(skillSourceCredential({ private: false })).toBeUndefined()
    expect(skillSourceCredential({})).toBeUndefined()
    expect(skillSourceCredential({ credential: { provider: 'gitlab', projectId: '42' } })).toEqual({
      provider: 'gitlab',
      projectId: '42'
    })
  })

  it('bounds refs, subdirectories, and selections', () => {
    expect(
      AgentSkillEntry.safeParse({
        name: 'x',
        source: 'o/r',
        githubRepoId: '1',
        ref: 'main',
        subDir: 'packs/core'
      }).success
    ).toBe(true)
    const sourceAtCap = `${'o'.repeat(255)}/${'r'.repeat(256)}`
    expect(sourceAtCap).toHaveLength(512)
    expect(AgentSkillEntry.safeParse({ name: 'x', source: sourceAtCap, githubRepoId: '1' }).success).toBe(true)
    expect(AgentSkillEntry.safeParse({ name: 'x', source: `${sourceAtCap}x`, githubRepoId: '1' }).success).toBe(false)
    for (const ref of ['', 'main\nother', 'r'.repeat(257)]) {
      expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', ref }).success, ref).toBe(false)
    }
    for (const subDir of ['/absolute', '../escape', 'packs//core', 'packs\\core', 'p'.repeat(1_025)]) {
      expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', subDir }).success, subDir).toBe(
        false
      )
    }

    const selection = 's'.repeat(128)
    expect(
      AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: [selection] }).success
    ).toBe(true)
    expect(
      AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['s'.repeat(129)] }).success
    ).toBe(false)
    expect(
      AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', githubRepoId: '1', skills: ['one', 'one'] }).success
    ).toBe(false)
    expect(
      AgentSkillEntry.safeParse({
        name: 'x',
        source: 'o/r',
        githubRepoId: '1',
        skills: Array.from({ length: 65 }, (_, i) => `skill-${i}`)
      }).success
    ).toBe(false)
  })

  it('caps current projections while retaining the prior wire grammar for rolling upgrades', () => {
    const entry = (name: string) => ({ name, source: `org/${name}`, githubRepoId: '1' })
    expect(InstallableAgentSkills.safeParse(Array.from({ length: 64 }, (_, i) => entry(`s${i}`))).success).toBe(true)
    expect(InstallableAgentSkills.safeParse([entry('same'), entry('same')]).success).toBe(false)
    expect(InstallableAgentSkills.safeParse(Array.from({ length: 65 }, (_, i) => entry(`s${i}`))).success).toBe(false)
    expect(
      AgentSpec.safeParse({
        name: 'agent',
        skills: Array.from({ length: 65 }, (_, i) => ({ name: `legacy-${i}`, source: 'https://gitlab.com/o/r' }))
      }).success
    ).toBe(true)

    const rolling = AgentSpec.parse({
      name: 'agent',
      skills: [
        { name: 'old-cp', source: 'o/old' },
        { name: 'current-cp', source: 'o/current', githubRepoId: '9007199254740993' },
        { name: 'credentialed', source: 'https://gitlab.com/g/p', credential: { provider: 'gitlab', projectId: '5' } }
      ]
    })
    expect(rolling.skills).toEqual([
      { name: 'old-cp', source: 'o/old', skills: [] },
      { name: 'current-cp', source: 'o/current', githubRepoId: '9007199254740993', skills: [] },
      {
        name: 'credentialed',
        source: 'https://gitlab.com/g/p',
        credential: { provider: 'gitlab', projectId: '5' },
        skills: []
      }
    ])
  })
})
