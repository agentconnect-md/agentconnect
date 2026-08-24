import { describe, it, expect } from 'vitest'
import { classifySession } from './session-visibility.js'

describe('classifySession — the §4.2 default rules', () => {
  it('inherits for an A2A child before any other rule', () => {
    expect(classifySession({ parentSessionId: 'parent-1', platform: 'webchat' })).toEqual({ inherit: true })
    expect(classifySession({ parentSessionId: 'parent-1', platform: 'slack', conversationKind: 'channel' })).toEqual({
      inherit: true
    })
  })

  // A self-post channel ROOT (or a peer woken by a mention there) keeps its parent for lineage
  // but lives in its own conversation, so inheriting would hand it that conversation's readers.
  it('classifies a direct-destination child by its own conversation, unowned', () => {
    expect(
      classifySession({
        parentSessionId: 'parent-1',
        directDestination: true,
        platform: 'slack',
        conversationKind: 'dm',
        transportScope: 'T1',
        triggeredBy: 'agent-uuid'
      })
    ).toEqual({ visibility: 'private', ownerIdentity: null, source: 'default' })
    expect(
      classifySession({
        parentSessionId: 'parent-1',
        directDestination: true,
        platform: 'slack',
        conversationKind: 'channel',
        transportScope: 'T1',
        triggeredBy: 'agent-uuid'
      })
    ).toEqual({ visibility: 'org', ownerIdentity: null, source: 'default' })
    // Without the flag the same row still inherits — the ordinary A2A path is untouched.
    expect(classifySession({ parentSessionId: 'parent-1', platform: 'slack', conversationKind: 'dm' })).toEqual({
      inherit: true
    })
    // And the flag never widens a ROOT session: with no parent the ordinary IM rules own it.
    expect(
      classifySession({
        directDestination: true,
        platform: 'slack',
        conversationKind: 'dm',
        transportScope: 'T1',
        triggeredBy: 'U1'
      })
    ).toEqual({ visibility: 'private', ownerIdentity: 'slack:T1:U1', source: 'default' })
  })

  it('classifies webchat private and owns it via the resolved binding', () => {
    expect(classifySession({ platform: 'webchat', triggeredBy: 'dev@example.com', webchatOwnerUserId: 'u1' })).toEqual({
      visibility: 'private',
      ownerIdentity: 'user:u1',
      source: 'default'
    })
  })

  it('classifies a Web API launch private and owns it via the correlation principal', () => {
    expect(classifySession({ platform: 'slack', launchCorrelationId: 'c1', launchOwnerUserId: 'u2' })).toEqual({
      visibility: 'private',
      ownerIdentity: 'user:u2',
      source: 'default'
    })
  })

  it('classifies automation org with no owner', () => {
    for (const triggeredBy of ['cron:abc', 'hook:def', 'dream:ghi']) {
      expect(classifySession({ platform: 'slack', triggeredBy, transportScope: 'T1' })).toEqual({
        visibility: 'org',
        ownerIdentity: null,
        source: 'default'
      })
    }
    expect(classifySession({ platform: 'hook' })).toEqual({
      visibility: 'org',
      ownerIdentity: null,
      source: 'default'
    })
  })

  it('classifies an IM DM private with the three-part identity tuple', () => {
    expect(
      classifySession({ platform: 'slack', conversationKind: 'dm', transportScope: 'T024BE7LD', triggeredBy: 'U0123' })
    ).toEqual({ visibility: 'private', ownerIdentity: 'slack:T024BE7LD:U0123', source: 'default' })
  })

  it('classifies group DMs and channels org but still records the initiator', () => {
    const base = { platform: 'slack' as const, transportScope: 'T1', triggeredBy: 'U9' }
    for (const conversationKind of ['group_dm', 'channel'] as const) {
      expect(classifySession({ ...base, conversationKind })).toEqual({
        visibility: 'org',
        ownerIdentity: 'slack:T1:U9',
        source: 'default'
      })
    }
  })

  it('treats an absent conversationKind as a channel (old daemons stay org-visible)', () => {
    expect(classifySession({ platform: 'slack', transportScope: 'T1', triggeredBy: 'U9' })).toEqual({
      visibility: 'org',
      ownerIdentity: 'slack:T1:U9',
      source: 'default'
    })
  })
})

describe('classifySession — fail-closed paths', () => {
  it('keeps webchat private with no owner when the binding lookup misses', () => {
    expect(classifySession({ platform: 'webchat', webchatOwnerUserId: null })).toEqual({
      visibility: 'private',
      ownerIdentity: null,
      source: 'default'
    })
    // Lookup not even attempted (no channel on the frame) ⇒ same outcome.
    expect(classifySession({ platform: 'webchat' })).toEqual({
      visibility: 'private',
      ownerIdentity: null,
      source: 'default'
    })
  })

  it('keeps a launch-correlated session private with no owner when the correlation is unknown', () => {
    expect(classifySession({ platform: 'slack', launchCorrelationId: 'c1', launchOwnerUserId: null })).toEqual({
      visibility: 'private',
      ownerIdentity: null,
      source: 'default'
    })
  })

  it('records no IM owner when transportScope is missing — never a guessed one', () => {
    expect(classifySession({ platform: 'slack', conversationKind: 'dm', triggeredBy: 'U0123' })).toEqual({
      visibility: 'private',
      ownerIdentity: null,
      source: 'default'
    })
    expect(classifySession({ platform: 'slack', conversationKind: 'channel', triggeredBy: 'U0123' })).toEqual({
      visibility: 'org',
      ownerIdentity: null,
      source: 'default'
    })
  })

  it('records no IM owner when the sender or platform is missing', () => {
    expect(classifySession({ platform: 'slack', conversationKind: 'dm', transportScope: 'T1' })).toEqual({
      visibility: 'private',
      ownerIdentity: null,
      source: 'default'
    })
    expect(classifySession({ conversationKind: 'dm', transportScope: 'T1', triggeredBy: 'U1' })).toEqual({
      visibility: 'private',
      ownerIdentity: null,
      source: 'default'
    })
  })

  it('never widens a private default because a lookup failed', () => {
    // Every private-defaulting origin, with its ownership lookup failed.
    const failedLookups = [
      classifySession({ platform: 'webchat', webchatOwnerUserId: null }),
      classifySession({ launchCorrelationId: 'c1', launchOwnerUserId: null }),
      classifySession({ platform: 'slack', conversationKind: 'dm' })
    ]
    for (const c of failedLookups) expect(c).toMatchObject({ visibility: 'private' })
  })
})
