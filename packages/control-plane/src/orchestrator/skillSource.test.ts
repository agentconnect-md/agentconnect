import { describe, it, expect } from 'vitest'
import { parseSkillRef, resolveAgentSkillEntries } from './skillSource.js'
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

  it('intersects picks with the source own filter when the source scopes a subset', async () => {
    const repo = repoWith([source({ name: 'platform', skills: ['review-pr'] })])
    const out = await resolveAgentSkillEntries(
      { orgId: ORG, skills: ['platform/review-pr', 'platform/not-allowed'] },
      repo
    )
    expect(out[0]!.skills).toEqual(['review-pr'])
  })

  it('drops enable-list entries whose source no longer exists', async () => {
    const repo = repoWith([source({ name: 'platform' })])
    const out = await resolveAgentSkillEntries({ orgId: ORG, skills: ['gone/x', 'platform/*'] }, repo)
    expect(out.map((e) => e.name)).toEqual(['platform'])
  })
})
