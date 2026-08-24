import { describe, expect, it } from 'vitest'
import {
  AgentLaunch,
  EventSession,
  FRAME_SCHEMAS,
  SESSION_VISIBILITY_FEATURE,
  SLACK_SESSION_AUDIENCE_FEATURE,
  SessionVisibilityOk,
  SessionVisibilityPush,
  SessionVisibilitySnapshot,
  decodeEnvelope,
  isFrame
} from '../index.js'

const ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555'
const CORRELATION_ID = '99999999-9999-4999-8999-999999999999'
const TS = '2026-07-30T00:00:00.000Z'

function envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, id: ID, ts: TS, type, payload, ...extra })
}

describe('session/visibility frames (session-visibility.md §5.1)', () => {
  const push = { sessionId: 'acp-sess-01H9', visibility: 'private', visibilityRev: 3 }

  it('SessionVisibilityPush parses a literal wire push and rejects malformed ones', () => {
    expect(SessionVisibilityPush.parse(push)).toEqual(push)
    expect(SessionVisibilityPush.safeParse({ ...push, visibility: 'org' }).success).toBe(true)
    // the vocabulary is closed and the rev is a nonnegative durable counter
    expect(SessionVisibilityPush.safeParse({ ...push, visibility: 'hidden' }).success).toBe(false)
    expect(SessionVisibilityPush.safeParse({ ...push, visibilityRev: -1 }).success).toBe(false)
    expect(SessionVisibilityPush.safeParse({ ...push, visibilityRev: 1.5 }).success).toBe(false)
    expect(SessionVisibilityPush.safeParse({ ...push, sessionId: '' }).success).toBe(false)
  })

  it('carries the owning agent, optional so an older CP still decodes (#1037)', () => {
    // ACP session ids are runtime-local, so the daemon keys its capture gate by
    // (agent, session id) — the id alone would answer for a colliding neighbour.
    expect(SessionVisibilityPush.parse(push).agentId).toBeUndefined()
    expect(SessionVisibilityPush.parse({ ...push, agentId: AGENT_ID }).agentId).toBe(AGENT_ID)
    expect(SessionVisibilityPush.safeParse({ ...push, agentId: '' }).success).toBe(false)
  })

  it('SessionVisibilityOk carries both settlement statuses — superseded is an ACK, not an error', () => {
    const ok = { sessionId: 'acp-sess-01H9', visibilityRev: 3, status: 'applied' }
    expect(SessionVisibilityOk.parse(ok).status).toBe('applied')
    // a stale rev is acknowledged as superseded (never answered with an error frame)
    expect(SessionVisibilityOk.safeParse({ ...ok, status: 'superseded' }).success).toBe(true)
    expect(SessionVisibilityOk.safeParse({ ...ok, status: 'rejected' }).success).toBe(false)
  })

  it('SessionVisibilitySnapshot bounds the register-time replay at 1000 entries', () => {
    expect(SessionVisibilitySnapshot.safeParse({ entries: [] }).success).toBe(true)
    expect(SessionVisibilitySnapshot.parse({ entries: [push] }).entries).toHaveLength(1)
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ ...push, sessionId: `s-${i}` }))
    expect(SessionVisibilitySnapshot.safeParse({ entries: tooMany }).success).toBe(false)
  })

  it('all three frames are registered on the daemon↔CP wire and decode', () => {
    const req = decodeEnvelope(envelope('session/visibility', push))
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('session/visibility')(req.frame)) throw new Error('expected session/visibility')
    expect(req.frame.payload.visibility).toBe('private')
    expect(req.frame.payload.visibilityRev).toBe(3)

    const rep = decodeEnvelope(
      envelope(
        'session/visibility/ok',
        { sessionId: push.sessionId, visibilityRev: 3, status: 'superseded' },
        { corr: ID }
      )
    )
    expect(rep.ok).toBe(true)
    if (!rep.ok || !isFrame('session/visibility/ok')(rep.frame)) throw new Error('expected session/visibility/ok')
    expect(rep.frame.corr).toBe(ID)
    expect(rep.frame.payload.status).toBe('superseded')

    const snap = decodeEnvelope(envelope('session/visibility/snapshot', { entries: [push] }))
    expect(snap.ok).toBe(true)
    if (!snap.ok || !isFrame('session/visibility/snapshot')(snap.frame)) {
      throw new Error('expected session/visibility/snapshot')
    }
    expect(snap.frame.payload.entries[0]!.sessionId).toBe(push.sessionId)

    expect(FRAME_SCHEMAS['session/visibility']).toBe(SessionVisibilityPush)
    expect(FRAME_SCHEMAS['session/visibility/ok']).toBe(SessionVisibilityOk)
    expect(FRAME_SCHEMAS['session/visibility/snapshot']).toBe(SessionVisibilitySnapshot)
  })

  it('exports the feature flag the daemon advertises and the CP gates pushes on', () => {
    expect(SESSION_VISIBILITY_FEATURE).toBe('session-visibility-v1')
    expect(SLACK_SESSION_AUDIENCE_FEATURE).toBe('slack-session-audience-v1')
  })
})

describe('EventSession visibility-classification fields (session-visibility.md §4.1)', () => {
  const legacyMilestone = {
    sessionId: 'acp-sess-01H9',
    agentId: AGENT_ID,
    phase: 'start',
    platform: 'slack',
    channel: 'D0ALICE',
    triggeredBy: 'U-DANA',
    ts: TS
  }

  it('a milestone from an old daemon (no new fields) still parses', () => {
    const parsed = EventSession.parse(legacyMilestone)
    expect(parsed.conversationKind).toBeUndefined()
    expect(parsed.transportScope).toBeUndefined()
    expect(parsed.launchCorrelationId).toBeUndefined()
    expect(parsed.sourceBindingKind).toBeUndefined()
    expect(parsed.directDestination).toBeUndefined()
  })

  it('carries conversationKind + durable transportScope + launchCorrelationId + source provenance', () => {
    const parsed = EventSession.parse({
      ...legacyMilestone,
      conversationKind: 'dm',
      transportScope: 'T024BE7LD',
      launchCorrelationId: CORRELATION_ID,
      sourceBindingKind: 'local'
    })
    expect(parsed.conversationKind).toBe('dm')
    expect(parsed.transportScope).toBe('T024BE7LD')
    expect(parsed.launchCorrelationId).toBe(CORRELATION_ID)
    expect(parsed.sourceBindingKind).toBe('local')
    expect(EventSession.safeParse({ ...legacyMilestone, conversationKind: 'group_dm' }).success).toBe(true)
    expect(EventSession.safeParse({ ...legacyMilestone, conversationKind: 'channel' }).success).toBe(true)
    expect(EventSession.safeParse({ ...legacyMilestone, sourceBindingKind: 'external' }).success).toBe(true)
  })

  // §4.2: the row's coordinates ARE its own conversation, so its parent is lineage only. Only the
  // true case is on the wire — `false` would be a claim the classifier has no use for.
  it('carries directDestination beside the parent link, true-only', () => {
    const parsed = EventSession.parse({ ...legacyMilestone, parentSessionId: 'acp-parent-1', directDestination: true })
    expect(parsed.directDestination).toBe(true)
    expect(parsed.parentSessionId).toBe('acp-parent-1')
    expect(EventSession.safeParse({ ...legacyMilestone, directDestination: false }).success).toBe(false)
  })

  it('carries the exact accepted GitHub delivery as repository-scope proof', () => {
    const externalOrigin = {
      provider: 'github' as const,
      realmKey: 'github.com' as const,
      resourceKind: 'repository' as const,
      resourceKey: '123456789',
      hookId: '88888888-8888-4888-8888-888888888888',
      deliveryKey: 'delivery-1',
      sourceInstallationId: '456',
      repoFullName: 'acme/repo'
    }
    expect(EventSession.parse({ ...legacyMilestone, externalOrigin }).externalOrigin).toEqual(externalOrigin)
    expect(
      EventSession.safeParse({
        ...legacyMilestone,
        externalOrigin: { ...externalOrigin, resourceKey: 'acme/repo' }
      }).success
    ).toBe(false)
  })

  it('carries a Feishu/Lark conversation source with its app-qualified realm', () => {
    const externalOrigin = {
      provider: 'feishu' as const,
      realmKey: 'lark:cli_platform',
      resourceKind: 'conversation' as const,
      resourceKey: 'oc_chat',
      integrationId: '88888888-8888-4888-8888-888888888888'
    }
    expect(
      EventSession.parse({ ...legacyMilestone, platform: 'feishu', channel: 'oc_chat', externalOrigin }).externalOrigin
    ).toEqual(externalOrigin)
  })

  it('rejects an unknown conversationKind, an empty scope, and a non-uuid correlation id', () => {
    expect(EventSession.safeParse({ ...legacyMilestone, conversationKind: 'thread' }).success).toBe(false)
    expect(EventSession.safeParse({ ...legacyMilestone, transportScope: '' }).success).toBe(false)
    expect(EventSession.safeParse({ ...legacyMilestone, transportScope: 'x'.repeat(201) }).success).toBe(false)
    expect(EventSession.safeParse({ ...legacyMilestone, launchCorrelationId: 'not-a-uuid' }).success).toBe(false)
    expect(EventSession.safeParse({ ...legacyMilestone, sourceBindingKind: 'unknown' }).success).toBe(false)
  })
})

describe('agent/launch launchCorrelationId (session-visibility.md §4.4)', () => {
  const launch = {
    agentId: AGENT_ID,
    runtime: 'claude',
    workspaceId: WORKSPACE_ID,
    capabilities: [],
    spec: { name: 'helper' }
  }

  it('remains optional (an older CP omits it) and rides as a uuid when present', () => {
    expect(AgentLaunch.parse(launch).launchCorrelationId).toBeUndefined()
    expect(AgentLaunch.parse({ ...launch, launchCorrelationId: CORRELATION_ID }).launchCorrelationId).toBe(
      CORRELATION_ID
    )
    expect(AgentLaunch.safeParse({ ...launch, launchCorrelationId: 'not-a-uuid' }).success).toBe(false)
  })
})
