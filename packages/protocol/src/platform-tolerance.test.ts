import { describe, it, expect } from 'vitest'
import {
  decodeEnvelope,
  decodeRelayDaemonFrame,
  decodeRelayCpFrame,
  CollabRoutesSnapshot,
  KNOWN_PLATFORMS,
  isKnownPlatform,
  originKindOf
} from './index.js'

/**
 * S1a tolerant readers (integration-plugin-architecture.md §6.2 / §13).
 *
 * Every platform field on the wire reads as an open string: an id no peer has
 * shipped yet ('teams-x' below) must DECODE on every wire, because a closed
 * enum makes the whole payload — and for `register`, the handshake — fail.
 * These fixtures pin the per-frame policy:
 *   - register: accept; unknown capability ids are simply never matched
 *   - event/session: store the value verbatim
 *   - rd/msg: decode succeeds; refusal (if any) is a semantic per-item verdict
 * Writers still emit only KNOWN_PLATFORMS values until the fleet gate passes;
 * nothing here licenses emitting a new id (that is S1b).
 */

const ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const BOT_ID = '55555555-5555-4555-8555-555555555555'
const INTEGRATION_ID = '66666666-6666-4666-8666-666666666666'
const CRON_ID = '77777777-7777-4777-8777-777777777777'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const TS = '2026-08-03T00:00:00.000Z'

const UNKNOWN = 'teams-x' // a platform id no deployed writer emits yet

function envelope(type: string, payload: unknown) {
  return JSON.stringify({ v: 1, id: ID, ts: TS, type, payload })
}

function expectOk(r: { ok: boolean; [k: string]: unknown }) {
  if (!r.ok) throw new Error(`expected decode ok, got: ${JSON.stringify(r)}`)
}

describe('S1a tolerant platform readers — daemon↔CP wire', () => {
  it('register accepts an unknown id in capabilities.platforms (ignore-unknown policy)', () => {
    const r = decodeEnvelope(
      envelope('register', {
        host: 'edge-1',
        capabilities: { platforms: ['slack', UNKNOWN], runtimes: ['claude'], acp: true },
        maxAgents: 4,
        localState: { assignments: [], crons: [], leases: [] }
      })
    )
    expectOk(r)
    if (r.ok && r.frame.type === 'register') {
      expect(r.frame.payload.capabilities.platforms).toEqual(['slack', UNKNOWN])
    }
  })

  it('event/session stores an unknown platform verbatim', () => {
    const r = decodeEnvelope(
      envelope('event/session', {
        sessionId: 'acp-sess-1',
        agentId: AGENT_ID,
        phase: 'start',
        platform: UNKNOWN,
        channel: 'C123',
        ts: TS
      })
    )
    expectOk(r)
    if (r.ok && r.frame.type === 'event/session') {
      expect(r.frame.payload.platform).toBe(UNKNOWN)
    }
  })

  it('route/assign accepts a SessionKey with an unknown platform', () => {
    const r = decodeEnvelope(
      envelope('route/assign', {
        sessionKey: { platform: UNKNOWN, channel: 'C123' },
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID
      })
    )
    expectOk(r)
  })

  it('cron/upsert accepts an unknown target platform and keeps the legacy default when absent', () => {
    const withUnknown = decodeEnvelope(
      envelope('cron/upsert', {
        cronId: CRON_ID,
        agentId: AGENT_ID,
        schedule: '0 9 * * *',
        timezone: 'UTC',
        target: { platform: UNKNOWN, channel: 'C123' },
        trigger: 'do the thing'
      })
    )
    expectOk(withUnknown)
    if (withUnknown.ok && withUnknown.frame.type === 'cron/upsert') {
      expect(withUnknown.frame.payload.target?.platform).toBe(UNKNOWN)
    }

    const withDefault = decodeEnvelope(
      envelope('cron/upsert', {
        cronId: CRON_ID,
        agentId: AGENT_ID,
        schedule: '0 9 * * *',
        timezone: 'UTC',
        target: { channel: 'C123' },
        trigger: 'do the thing'
      })
    )
    expectOk(withDefault)
    if (withDefault.ok && withDefault.frame.type === 'cron/upsert') {
      expect(withDefault.frame.payload.target?.platform).toBe('slack')
    }
  })

  it('still refuses an EMPTY platform string (tolerant to unknown ids, not to malformed values)', () => {
    const r = decodeEnvelope(
      envelope('event/session', {
        sessionId: 'acp-sess-1',
        agentId: AGENT_ID,
        phase: 'start',
        platform: '',
        channel: 'C123',
        ts: TS
      })
    )
    expect(r.ok).toBe(false)
  })
})

describe('S1a tolerant platform readers — relay↔daemon wire', () => {
  it('rd/msg (im) decodes with an unknown payload platform (item verdict stays semantic)', () => {
    const r = decodeRelayDaemonFrame(
      envelope('rd/msg', {
        source: 'im',
        agentId: AGENT_ID,
        sessionKey: `${UNKNOWN}:C123:-`,
        msgId: 'evt-1',
        botId: BOT_ID,
        integrationId: INTEGRATION_ID,
        payload: {
          msgId: 'evt-1',
          traceId: 'trace-1',
          source: 'user',
          platform: UNKNOWN,
          channel: 'C123',
          sender: { id: 'U1', isBot: false },
          text: 'hello',
          mentionedBots: [],
          isDm: false
        }
      })
    )
    expectOk(r)
    if (r.ok && r.frame.type === 'rd/msg' && r.frame.payload.source === 'im') {
      expect(r.frame.payload.payload.platform).toBe(UNKNOWN)
    }
  })

  it('rd/agentmsg decodes with unknown coords/originCoords platforms (coordsDecision owns the refusal)', () => {
    const r = decodeRelayDaemonFrame(
      envelope('rd/agentmsg', {
        claimedFromAgentId: AGENT_ID,
        toAgentId: AGENT_ID,
        text: 'ping',
        coords: { platform: UNKNOWN, channel: 'C123' },
        originCoords: { platform: UNKNOWN, channel: 'C456' },
        hopCount: 0,
        deliveryId: 'd-1'
      })
    )
    expectOk(r)
  })
})

describe('S1a tolerant platform readers — relay↔CP wire', () => {
  it('rc/bot-assign decodes with an unknown platform (assign handler refuses gracefully, not the socket)', () => {
    const r = decodeRelayCpFrame(
      envelope('rc/bot-assign', {
        botId: BOT_ID,
        platform: UNKNOWN,
        secrets: { botToken: 'xoxb-test', signingSecret: 'sig' },
        members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
        routes: []
      })
    )
    expectOk(r)
    if (r.ok && r.frame.type === 'rc/bot-assign') {
      expect(r.frame.payload.platform).toBe(UNKNOWN)
    }
  })
})

describe('§6.1 origin-kind classification on the wire', () => {
  it('rc/bot-assign carries an optional originKind; absent stays decodable (older CP)', () => {
    const base = {
      botId: BOT_ID,
      platform: UNKNOWN,
      secrets: { botToken: 'xoxb-test', signingSecret: 'sig' },
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
      routes: []
    }
    const withKind = decodeRelayCpFrame(envelope('rc/bot-assign', { ...base, originKind: 'chat' }))
    expectOk(withKind)
    if (withKind.ok && withKind.frame.type === 'rc/bot-assign') {
      expect(withKind.frame.payload.originKind).toBe('chat')
    }
    const without = decodeRelayCpFrame(envelope('rc/bot-assign', base))
    expectOk(without)
  })

  it('collab snapshots default platformKinds to [] (pre-S1b CP) and carry entries verbatim', () => {
    const bare = CollabRoutesSnapshot.parse({ generation: 1 })
    expect(bare.platformKinds).toEqual([])
    const classified = CollabRoutesSnapshot.parse({
      generation: 2,
      platformKinds: [{ platformId: UNKNOWN, originKind: 'chat' }]
    })
    expect(classified.platformKinds).toEqual([{ platformId: UNKNOWN, originKind: 'chat' }])
  })

  it('originKindOf seeds the known ids and answers undefined for unknown ones', () => {
    expect(originKindOf('slack')).toBe('chat')
    expect(originKindOf('hook')).toBe('hook')
    expect(originKindOf('dream')).toBe('dream')
    expect(originKindOf('webchat')).toBe('webchat')
    expect(originKindOf(UNKNOWN)).toBeUndefined()
  })
})

describe('writer-side vocabulary stays closed until the fleet gate (S1b)', () => {
  it('KNOWN_PLATFORMS is exactly the legacy seven', () => {
    expect([...KNOWN_PLATFORMS]).toEqual(['slack', 'telegram', 'webchat', 'discord', 'feishu', 'hook', 'dream'])
  })

  it('isKnownPlatform narrows known ids and refuses unknown ones', () => {
    expect(isKnownPlatform('slack')).toBe(true)
    expect(isKnownPlatform('dream')).toBe(true)
    expect(isKnownPlatform(UNKNOWN)).toBe(false)
    expect(isKnownPlatform('')).toBe(false)
  })
})
