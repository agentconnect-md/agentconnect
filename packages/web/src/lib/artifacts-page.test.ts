import { describe, expect, it } from 'vitest'
import { ARTIFACT_TITLE_MAX as PROTOCOL_TITLE_MAX } from '@agentconnect.md/protocol'
import type { OrgArtifactDto } from '@/lib/artifact'
import {
  ARTIFACT_TITLE_MAX,
  artifactFilterKey,
  artifactFiltersActive,
  artifactOwnerLabel,
  artifactRowActions,
  artifactSharedState,
  artifactsPageQuery,
  followNextPage,
  moderationActions,
  parseArtifactFilterKey,
  readArtifactFilters,
  readArtifactsTab,
  uniqueRows
} from './artifacts-page'

const AGENT = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const params = (query: string) => new URLSearchParams(query)
const none = { rename: false, changeAudience: false, sharePublic: false, revokeShares: false }
const all = { rename: true, changeAudience: true, sharePublic: true, revokeShares: true }
const row = (
  over: Partial<Pick<OrgArtifactDto, 'originSessionVisible' | 'permissions' | 'audience'>> = {}
): Pick<OrgArtifactDto, 'originSessionVisible' | 'permissions' | 'audience'> => ({
  originSessionVisible: false,
  permissions: none,
  audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
  ...over
})

describe('filters in the page URL', () => {
  it('reads the defaults from an empty query and keeps them out of the URL', () => {
    const filters = readArtifactFilters(params(''))
    expect(filters).toEqual({ scope: 'org', agentId: null, type: null, publiclyShared: false })
    expect(artifactsPageQuery(filters)).toBe('')
    expect(artifactFiltersActive(filters)).toBe(false)
  })

  it('round-trips every filter and the public-links tab', () => {
    const filters = { scope: 'mine' as const, agentId: AGENT, type: 'pdf' as const, publiclyShared: true }
    const query = artifactsPageQuery(filters, 'public')
    expect(readArtifactFilters(params(query))).toEqual(filters)
    expect(readArtifactsTab(params(query))).toBe('public')
    expect(artifactFiltersActive(filters)).toBe(true)
  })

  it('ignores values the CP would refuse', () => {
    expect(readArtifactFilters(params('scope=all&agent=atlas&type=video&public=true'))).toEqual({
      scope: 'org',
      agentId: null,
      type: null,
      publiclyShared: false
    })
    expect(readArtifactsTab(params('tab=other'))).toBe('artifacts')
  })

  it('turns the cache key back into the list route’s filters', () => {
    expect(parseArtifactFilterKey(artifactFilterKey(readArtifactFilters(params(''))))).toEqual({})
    expect(
      parseArtifactFilterKey(artifactFilterKey({ scope: 'mine', agentId: AGENT, type: 'page', publiclyShared: true }))
    ).toEqual({ scope: 'mine', agentId: AGENT, type: 'page', publiclyShared: true })
  })

  it('keeps the title cap in step with the protocol', () => {
    expect(ARTIFACT_TITLE_MAX).toBe(PROTOCOL_TITLE_MAX)
  })
})

describe('paging', () => {
  it('follows a short page while more remain, and stops at the target, the end, a failure or a read in flight', () => {
    const base = { rows: 3, target: 25, nextCursor: 'c1', failed: false, loading: false }
    expect(followNextPage(base)).toBe(true)
    expect(followNextPage({ ...base, rows: 0 })).toBe(true)
    expect(followNextPage({ ...base, rows: 25 })).toBe(false)
    expect(followNextPage({ ...base, nextCursor: null })).toBe(false)
    expect(followNextPage({ ...base, failed: true })).toBe(false)
    expect(followNextPage({ ...base, loading: true })).toBe(false)
  })

  it('keeps the first copy of a row that moved between pages', () => {
    const rows = uniqueRows([
      {
        rows: [
          { id: 'b', n: 1 },
          { id: 'a', n: 1 }
        ]
      },
      {
        rows: [
          { id: 'a', n: 2 },
          { id: 'c', n: 1 }
        ]
      }
    ])
    expect(rows).toEqual([
      { id: 'b', n: 1 },
      { id: 'a', n: 1 },
      { id: 'c', n: 1 }
    ])
  })
})

describe('columns', () => {
  it('says public over org, and none without a link', () => {
    expect(artifactSharedState({ shared: { any: true, public: true } })).toBe('public')
    expect(artifactSharedState({ shared: { any: true, public: false } })).toBe('org')
    expect(artifactSharedState({ shared: { any: false, public: false } })).toBe('none')
  })

  it('names the owner, and organization owners for an artifact without one', () => {
    const person = { userId: 'u1', displayName: 'Ada', email: 'ada@example.test', platform: null }
    expect(artifactOwnerLabel(person, true)).toEqual({ kind: 'you' })
    expect(artifactOwnerLabel(null)).toEqual({ kind: 'orgOwners' })
    expect(artifactOwnerLabel(person)).toEqual({ kind: 'name', name: 'Ada' })
    expect(artifactOwnerLabel({ ...person, displayName: null })).toEqual({ kind: 'name', name: 'ada@example.test' })
    expect(artifactOwnerLabel({ userId: null, displayName: null, email: null, platform: 'slack' })).toEqual({
      kind: 'platform',
      platform: 'slack'
    })
    expect(artifactOwnerLabel({ userId: null, displayName: null, email: null, platform: null })).toEqual({
      kind: 'unknown'
    })
  })
})

describe('row actions', () => {
  it('gives a member who can view only open, revisions and share', () => {
    expect(artifactRowActions(row())).toEqual({
      open: true,
      revisions: true,
      share: true,
      session: false,
      rename: false,
      audience: 'hidden',
      delete: false
    })
  })

  it('offers the session link only while the session is visible', () => {
    expect(artifactRowActions(row({ originSessionVisible: true })).session).toBe(true)
  })

  it('gives the owner rename, audience and delete', () => {
    const actions = artifactRowActions(row({ permissions: all }))
    expect(actions).toMatchObject({ rename: true, audience: 'allowed', delete: true })
  })

  it('explains a fixed audience to someone who could otherwise change it', () => {
    for (const visibility of ['external', 'editors'] as const) {
      const fixed = row({
        permissions: { ...all, changeAudience: false },
        audience: { visibility, externalProvider: visibility === 'external' ? 'slack' : null, editorsAgentId: null }
      })
      expect(artifactRowActions(fixed).audience).toBe('fixed')
    }
    const member = row({ audience: { visibility: 'external', externalProvider: 'slack', editorsAgentId: null } })
    expect(artifactRowActions(member).audience).toBe('hidden')
  })

  it('lets an organization owner delete what they cannot rename', () => {
    const actions = artifactRowActions(row({ permissions: { ...none, revokeShares: true } }))
    expect(actions).toMatchObject({ rename: false, audience: 'hidden', delete: true })
  })

  it('opens a moderated share only for a viewer of the artifact', () => {
    const artifact = { id: 'a', title: 'T', owner: null }
    expect(moderationActions({ artifact: { ...artifact, viewerCanView: false } })).toEqual({
      open: false,
      revoke: true,
      delete: true
    })
    expect(moderationActions({ artifact: { ...artifact, viewerCanView: true } }).open).toBe(true)
  })
})
