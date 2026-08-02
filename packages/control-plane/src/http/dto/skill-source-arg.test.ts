/**
 * `SkillSourceArg` acceptance (docs/designs/shared-skills.md).
 *
 * A skill source is org metadata: it travels inline on every referring AgentSpec
 * and `GET /agents/:id/skill-sources` shows it to anyone who can view an agent
 * that enables it, ACROSS the source's own sharing. That only holds if the string
 * cannot carry a secret, so the schema — not a convention — enforces it.
 */
import { describe, it, expect } from 'vitest'
import { CreateAgentBody, CreateSkillSourceBody, UpdateSkillSourceBody } from './index.js'

const accepts = (source: string) => CreateSkillSourceBody.safeParse({ name: 'kit', source }).success

describe('SkillSourceArg', () => {
  it('rejects every place a credential can hide in a source string', () => {
    for (const bad of [
      'https://user:pw@git.example.test/ops/skills.git', // userinfo password
      'https://ghp_tokenlike@github.com/example-org/kit', // token AS the username
      'https://user:p@ss@git.example.test/ops/skills.git', // password containing "@"
      'https://git.example.test/ops/skills.git?access_token=tokenlike', // query
      'https://git.example.test/ops/skills.git#tokenlike', // fragment
      'https://good.example\\user:token@127.0.0.1/repo', // backslash authority ambiguity
      '--flag-not-a-source' // pre-existing guard: never an npx option
    ]) {
      expect({ bad, accepted: accepts(bad) }).toEqual({ bad, accepted: false })
    }
  })

  it('accepts the bounded GitHub forms the acquisition path supports', () => {
    for (const good of [
      'example-org/example-ai-kit', // shorthand
      'git@github.com:example-org/example-kit.git', // scp-like: no "://", no userinfo
      'ssh://git@github.com/example-org/example-kit.git', // standard GitHub SSH role
      'https://github.com/example-org/example-kit.git',
      'https://github.com/example-org/kit/tree/main/skills' // ref + subdir form
    ]) {
      expect({ good, accepted: accepts(good) }).toEqual({ good, accepted: true })
    }
  })

  it('rejects hosts and transports outside the bounded GitHub acquisition contract', () => {
    for (const bad of [
      'https://gitlab.com/example-org/kit',
      'ssh://git@git.example.test/ops/skills.git',
      'https://example.test/example-org/kit',
      'https://github.com:8443/example-org/kit',
      'ssh://git@github.com:2222/example-org/kit',
      'ssh://deploy@github.com/example-org/kit',
      'git@github.com:/example-org/kit'
    ]) {
      expect({ bad, accepted: accepts(bad) }).toEqual({ bad, accepted: false })
    }
  })

  it('bounds and validates source, ref, subdir, and skill-filter fields', () => {
    expect(
      CreateSkillSourceBody.safeParse({
        name: 'kit',
        source: 'example-org/kit',
        ref: 'main',
        subDir: 'packs/core',
        skills: ['review-pr', 'safe_deploy']
      }).success
    ).toBe(true)

    const sourceAtCap = `${'o'.repeat(255)}/${'r'.repeat(256)}`
    expect(sourceAtCap).toHaveLength(512)
    expect(accepts(sourceAtCap)).toBe(true)
    expect(accepts(`${sourceAtCap}x`)).toBe(false)
    for (const ref of ['', 'main\nother', 'r'.repeat(257)]) {
      expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', ref }).success, ref).toBe(false)
      expect(UpdateSkillSourceBody.safeParse({ ref }).success, ref).toBe(false)
    }
    for (const subDir of ['/absolute', '../escape', 'packs//core', 'packs\\core', 'p'.repeat(1_025)]) {
      expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', subDir }).success, subDir).toBe(false)
      expect(UpdateSkillSourceBody.safeParse({ subDir }).success, subDir).toBe(false)
    }
    expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', skills: ['same', 'same'] }).success).toBe(
      false
    )
    expect(
      CreateSkillSourceBody.safeParse({
        name: 'kit',
        source: 'o/r',
        skills: Array.from({ length: 65 }, (_, i) => `skill-${i}`)
      }).success
    ).toBe(false)
    expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', skills: ['s'.repeat(129)] }).success).toBe(
      false
    )
    expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', skills: ['a.-_'] }).success).toBe(true)
    for (const skill of ['.hidden', '_tool', '-flag', 'bad/name', 'Foo', 'foo.', 'foo-']) {
      expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', skills: [skill] }).success, skill).toBe(
        false
      )
    }
  })

  it('accepts only a positive integer githubRepoId within BIGINT range', () => {
    // Max signed BIGINT (2^63-1) is the largest a PostgreSQL BIGINT column holds.
    for (const githubRepoId of ['1', '42', '9223372036854775807']) {
      expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', githubRepoId }).success, githubRepoId).toBe(
        true
      )
    }
    for (const githubRepoId of [
      'not-a-number',
      '0',
      '-1',
      '1.5',
      '01',
      '',
      ' 1',
      '1 ',
      '9223372036854775808', // 2^63 (one past BIGINT max)
      '99999999999999999999' // 20 digits, far beyond BIGINT
    ]) {
      expect(CreateSkillSourceBody.safeParse({ name: 'kit', source: 'o/r', githubRepoId }).success, githubRepoId).toBe(
        false
      )
      expect(UpdateSkillSourceBody.safeParse({ githubRepoId }).success, githubRepoId).toBe(false)
    }
    // Update accepts null (clear the binding) and a valid id.
    expect(UpdateSkillSourceBody.safeParse({ githubRepoId: null }).success).toBe(true)
    expect(UpdateSkillSourceBody.safeParse({ githubRepoId: '42' }).success).toBe(true)
  })

  it('bounds and deduplicates per-agent skill enablement refs', () => {
    const body = (skills: string[]) => ({ name: 'agent', runtime: 'codex', skills })
    expect(CreateAgentBody.safeParse(body(Array.from({ length: 64 }, (_, i) => `source/skill-${i}`))).success).toBe(
      true
    )
    expect(CreateAgentBody.safeParse(body(['source/skill', 'source/skill'])).success).toBe(false)
    expect(CreateAgentBody.safeParse(body(Array.from({ length: 65 }, (_, i) => `source/skill-${i}`))).success).toBe(
      false
    )
    expect(CreateAgentBody.safeParse(body([`${'s'.repeat(64)}/${'k'.repeat(128)}`])).success).toBe(true)
    expect(CreateAgentBody.safeParse(body([`${'s'.repeat(64)}/${'k'.repeat(129)}`])).success).toBe(false)
    expect(CreateAgentBody.safeParse(body(['source/.hidden'])).success).toBe(false)
    expect(CreateAgentBody.safeParse(body(['source/_tool'])).success).toBe(false)
  })
})
