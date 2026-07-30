import { describe, it, expect } from 'vitest'
import { parseSkillRef, redactSourceCredentials, resolveAgentSkillEntries } from './skillSource.js'
import type { SkillSourceRecord, SkillSourceRepo } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'

const ORG = OrgId('org-1')

function source(over: Partial<SkillSourceRecord>): SkillSourceRecord {
  return {
    id: 'id',
    orgId: ORG,
    name: 'platform',
    source: 'acme/platform-skills',
    githubRepoId: null,
    ref: null,
    subDir: null,
    skills: [],
    visibility: 'org',
    sharedWith: [],
    createdByUserId: null,
    ownerUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over
  }
}

function repoWith(rows: SkillSourceRecord[]): SkillSourceRepo {
  const byName = new Map(rows.map((r) => [r.name, r]))
  return {
    create: async () => rows[0]!,
    get: async () => null,
    listForOrg: async () => rows,
    getByName: async (_org, name) => byName.get(name) ?? null,
    setSharing: async () => rows[0]!,
    update: async () => rows[0]!,
    delete: async () => undefined
  }
}

describe('parseSkillRef', () => {
  it('splits <source>/<skill>', () => {
    expect(parseSkillRef('platform/review-pr')).toEqual({ source: 'platform', skill: 'review-pr' })
  })
  it('treats <source>/* and bare <source> as whole-source', () => {
    expect(parseSkillRef('platform/*')).toEqual({ source: 'platform', skill: null })
    expect(parseSkillRef('platform')).toEqual({ source: 'platform', skill: null })
  })
})

describe('resolveAgentSkillEntries', () => {
  it('returns [] with no repo or no enable-list', async () => {
    expect(await resolveAgentSkillEntries({ orgId: ORG, skills: ['a/b'] }, undefined)).toEqual([])
    expect(await resolveAgentSkillEntries({ orgId: ORG, skills: [] }, repoWith([source({})]))).toEqual([])
  })

  it('resolves a whole-source wildcard to an entry with all skills', async () => {
    const repo = repoWith([source({ name: 'platform', source: 'acme/platform-skills', ref: 'v1' })])
    const out = await resolveAgentSkillEntries({ orgId: ORG, skills: ['platform/*'] }, repo)
    expect(out).toEqual([{ name: 'platform', source: 'acme/platform-skills', ref: 'v1', skills: [] }])
  })

  it('collects specific skills per source', async () => {
    const repo = repoWith([source({ name: 'platform' })])
    const out = await resolveAgentSkillEntries(
      { orgId: ORG, skills: ['platform/review-pr', 'platform/safe-deploy'] },
      repo
    )
    expect(out[0]!.skills.sort()).toEqual(['review-pr', 'safe-deploy'])
  })

  it('whole-source wins over specific picks for the same source', async () => {
    const repo = repoWith([source({ name: 'platform' })])
    const out = await resolveAgentSkillEntries({ orgId: ORG, skills: ['platform/review-pr', 'platform/*'] }, repo)
    expect(out[0]!.skills).toEqual([])
  })

  it('a wildcard honors the source own filter instead of broadening to all', async () => {
    const repo = repoWith([source({ name: 'platform', skills: ['review-pr'] })])
    const out = await resolveAgentSkillEntries({ orgId: ORG, skills: ['platform/*'] }, repo)
    // NOT [] — that would mean "install every skill", broadening the restriction.
    expect(out[0]!.skills).toEqual(['review-pr'])
  })

  it('intersects picks with the source own filter when the source scopes a subset', async () => {
    const repo = repoWith([source({ name: 'platform', skills: ['review-pr'] })])
    const out = await resolveAgentSkillEntries(
      { orgId: ORG, skills: ['platform/review-pr', 'platform/not-allowed'] },
      repo
    )
    expect(out[0]!.skills).toEqual(['review-pr'])
  })

  it('omits a source when specific picks intersect the source filter to nothing', async () => {
    const repo = repoWith([source({ name: 'platform', skills: ['review-pr'] })])
    // The agent enabled only a skill the source no longer offers → omit, never fall back to all.
    const out = await resolveAgentSkillEntries({ orgId: ORG, skills: ['platform/gone'] }, repo)
    expect(out).toEqual([])
  })

  it('drops enable-list entries whose source no longer exists', async () => {
    const repo = repoWith([source({ name: 'platform' })])
    const out = await resolveAgentSkillEntries({ orgId: ORG, skills: ['gone/x', 'platform/*'] }, repo)
    expect(out.map((e) => e.name)).toEqual(['platform'])
  })
})

describe('redactSourceCredentials', () => {
  // The agent-scoped resolution shows a source to callers the source itself is
  // shared away from, so anything that could be a secret must not survive.
  it('strips userinfo from a scheme URL, whether it looks like a password or a token', () => {
    expect(redactSourceCredentials('https://user:pw@git.example.test/ops/skills.git')).toBe(
      'https://git.example.test/ops/skills.git'
    )
    expect(redactSourceCredentials('https://ghp_TOKEN@github.com/example-org/kit')).toBe(
      'https://github.com/example-org/kit'
    )
    // ssh keeps its role username (it isn't a secret and the URL stays cloneable)
    // but loses a password — the protocol codec's rule, inherited here.
    expect(redactSourceCredentials('ssh://git:secret@git.example.test/ops/skills.git')).toBe(
      'ssh://git@git.example.test/ops/skills.git'
    )
  })

  it('handles the forms a naive regex gets wrong (bypasses caught in review)', () => {
    // Minimal-match userinfo would stop at the FIRST `@` and echo `ss@host…`.
    expect(redactSourceCredentials('https://user:p@ss@git.example.test/ops/skills.git')).toBe(
      'https://git.example.test/ops/skills.git'
    )
    // A token can hide in a query or fragment instead of the authority.
    for (const s of [
      'https://git.example.test/ops/skills.git?access_token=visible-secret',
      'https://git.example.test/ops/skills.git#fragment-secret',
      'https://git.example.test/ops/skills.git?access_token=visible-secret#fragment-secret'
    ]) {
      const out = redactSourceCredentials(s)
      expect(out).toBe('https://git.example.test/ops/skills.git')
      expect(out).not.toContain('secret')
    }
  })

  it('never throws on a malformed historical value, and never echoes its secret', () => {
    for (const s of ['', 'not a url', 'https://user:secret@', 'https://good.example\\user:token@127.0.0.1/repo']) {
      expect(() => redactSourceCredentials(s)).not.toThrow()
      expect(redactSourceCredentials(s)).not.toMatch(/secret|token/)
    }
  })

  it('leaves credential-free forms untouched', () => {
    for (const s of [
      'example-org/example-ai-kit',
      'https://github.com/example-org/example-kit/tree/main/skills',
      'git@github.com:example-org/example-kit.git' // scp-like: no scheme, so no userinfo
    ]) {
      expect(redactSourceCredentials(s)).toBe(s)
    }
  })

  it('drops a query wholesale rather than guessing which parameter is a secret', () => {
    // `?ref=v1@2` is innocuous, but the query is stripped anyway — `SkillSourceArg`
    // no longer accepts one, so nothing legitimate depends on it surviving.
    expect(redactSourceCredentials('https://git.example.test/ops/skills.git?ref=v1@2')).toBe(
      'https://git.example.test/ops/skills.git'
    )
  })
})
