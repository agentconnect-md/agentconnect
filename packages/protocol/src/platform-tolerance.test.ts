import { describe, it, expect } from 'vitest'
import {
  decodeEnvelope,
  decodeRelayDaemonFrame,
  decodeRelayCpFrame,
  CollabRoutesSnapshot,
  IntegrationSpec,
  KNOWN_PLATFORMS,
  isKnownPlatform,
  originKindOf,
  continuableOrigin
} from './index.js'

/**
 * Tolerant readers (integration-plugin-architecture.md §6.2).
 *
 * Every platform field on the wire reads as an open string: an id no peer has
 * shipped yet ('teams-x' below) must DECODE on every wire, because a closed
 * enum makes the whole payload — and for `register`, the handshake — fail.
 * This is what lets a platform ship without a lockstep fleet upgrade: a daemon
 * older than the CP keeps working, and the id it does not recognize stays inert
 * rather than fatal. These fixtures pin the per-frame policy:
 *   - register: accept; unknown capability ids are simply never matched
 *   - event/session: store the value verbatim
 *   - rd/msg: decode succeeds; refusal (if any) is a semantic per-item verdict
 * Writers still emit only KNOWN_PLATFORMS values; nothing here licenses
 * emitting an id the registry does not know.
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

describe('§6.4 IntegrationSpec final shape (S3 flatten)', () => {
  const base = { integrationId: INTEGRATION_ID, agentId: AGENT_ID, platform: 'telegram' }
  const telegram = { botToken: '12345:AAA' }
  const core = { mode: 'direct' as const, bindRules: [], mutedChannels: [], gated: false }

  it('decodes the flat envelope + opaque config, with an OPEN platform id', () => {
    const flat = IntegrationSpec.safeParse({ ...base, core, config: telegram })
    expect(flat.success).toBe(true)
    if (flat.success) {
      expect(flat.data.platform).toBe('telegram')
      expect(flat.data.core.gated).toBe(false)
      expect(flat.data.config).toEqual(telegram)
    }
    // An id no deployed writer emits yet decodes too — the daemon's platform
    // registry (not the schema) refuses the spec, per the S1a per-frame policy.
    expect(IntegrationSpec.safeParse({ ...base, platform: UNKNOWN, core, config: {} }).success).toBe(true)
  })

  it('strips a stale legacy nested block (unknown key) instead of failing the frame', () => {
    const r = IntegrationSpec.safeParse({ ...base, telegram, core, config: telegram })
    expect(r.success).toBe(true)
    if (r.success) expect('telegram' in r.data).toBe(false)
  })

  it('REQUIRES core (the retired dual-shape tolerance) but leaves config to the reader', () => {
    // core absent ⇒ frame fails: defaulting it would mint a rule-less
    // integration out of a stale writer, silently.
    expect(IntegrationSpec.safeParse({ ...base, config: telegram }).success).toBe(false)
    // config absent ⇒ frame still decodes: one unusable spec is the reader's
    // per-item skip (+ warn), never the whole snapshot's failure.
    expect(IntegrationSpec.safeParse({ ...base, core }).success).toBe(true)
  })
})

describe('§6.5 generic thread coordinates + adapterExt', () => {
  const im = (payload: Record<string, unknown>) =>
    decodeRelayDaemonFrame(
      envelope('rd/msg', {
        source: 'im',
        agentId: AGENT_ID,
        sessionKey: 'telegram:C1:-',
        msgId: 'evt-1',
        botId: BOT_ID,
        integrationId: INTEGRATION_ID,
        payload: {
          msgId: 'evt-1',
          traceId: 'trace-1',
          source: 'user',
          platform: 'telegram',
          channel: '-100123',
          sender: { id: 'U1', isBot: false },
          text: 'hello',
          mentionedBots: [],
          isDm: false,
          ...payload
        }
      })
    )

  it('decodes generic coordinates; a legacy named twin from an older peer is stripped', () => {
    // §6.5 legacy RETIRED: named twins are unknown keys now — stripped by the
    // non-strict object, never a decode failure, and the generic field carries.
    const dual = im({ telegramTopicId: '55', topicId: '55' })
    expectOk(dual)
    if (dual.ok && dual.frame.type === 'rd/msg' && dual.frame.payload.source === 'im') {
      expect(dual.frame.payload.payload.topicId).toBe('55')
      expect('telegramTopicId' in dual.frame.payload.payload).toBe(false)
    }
    expectOk(im({ threadRoot: '6', promoteToThread: true }))
  })

  it('round-trips the opaque adapterExt bag verbatim', () => {
    const r = im({ adapterExt: { telegram: { customEmojiIds: ['e1'] } } })
    expectOk(r)
    if (r.ok && r.frame.type === 'rd/msg' && r.frame.payload.source === 'im') {
      expect(r.frame.payload.payload.adapterExt).toEqual({ telegram: { customEmojiIds: ['e1'] } })
    }
  })
})

describe('§6.6 platform_action envelope', () => {
  const pa = (over: Record<string, unknown> = {}) =>
    decodeRelayDaemonFrame(
      envelope('rd/msg', {
        source: 'platform_action',
        platformId: 'slack',
        agentId: AGENT_ID,
        sessionKey: 'slack:C1:T1',
        msgId: 'pa-1',
        botId: BOT_ID,
        integrationId: INTEGRATION_ID,
        payload: { kind: 'open-config', triggerId: 'trig-1' },
        ...over
      })
    )

  it('decodes with a core-typed envelope and an OPAQUE payload for any platform id', () => {
    const slack = pa()
    expectOk(slack)
    if (slack.ok && slack.frame.type === 'rd/msg' && slack.frame.payload.source === 'platform_action') {
      expect(slack.frame.payload.platformId).toBe('slack')
      expect(slack.frame.payload.payload).toEqual({ kind: 'open-config', triggerId: 'trig-1' })
    }
    // A platform id this build predates decodes too — refusal is the daemon's
    // per-item verdict, never the schema's.
    expectOk(pa({ platformId: UNKNOWN, payload: { anything: true } }))
  })

  it('rd/ack carries the generic opaque response; the retired Feishu slot is stripped', () => {
    // A pre-flip daemon still dual-fills; the named slot is an unknown key now and
    // strips cleanly while the generic response carries.
    const r = decodeRelayDaemonFrame(
      envelope('rd/ack', {
        msgId: 'pa-1',
        accepted: true,
        feishuCardAction: { toast: { type: 'info', content: 'ok' } },
        response: { toast: { type: 'info', content: 'ok' } }
      })
    )
    expectOk(r)
    if (r.ok && r.frame.type === 'rd/ack') {
      expect(r.frame.payload.response).toEqual({ toast: { type: 'info', content: 'ok' } })
      expect('feishuCardAction' in r.frame.payload).toBe(false)
    }
  })
})

describe('§6.7 rc/bot-assign opaque secrets + ingress', () => {
  it('decodes an opaque secret bag for a platform this build predates + the ingress bag', () => {
    const r = decodeRelayCpFrame(
      envelope('rc/bot-assign', {
        botId: BOT_ID,
        platform: UNKNOWN,
        originKind: 'chat',
        secrets: { apiKey: 'k-1', webhookSecret: 'w-1' },
        ingress: { appId: 'app-1', tenant: 't-1' },
        members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
        routes: []
      })
    )
    expectOk(r)
    if (r.ok && r.frame.type === 'rc/bot-assign') {
      expect(r.frame.payload.secrets).toEqual({ apiKey: 'k-1', webhookSecret: 'w-1' })
      expect(r.frame.payload.ingress).toEqual({ appId: 'app-1', tenant: 't-1' })
    }
  })

  it('preserves EXTRA credential keys when a bag also satisfies a typed prefix', () => {
    // zod object branches strip unknown keys by default; the typed variants carry
    // a catchall so the platform module receives everything that was on the wire.
    const r = decodeRelayCpFrame(
      envelope('rc/bot-assign', {
        botId: BOT_ID,
        platform: 'slack',
        secrets: { botToken: 'xoxb-x', signingSecret: 'sig', clientSecret: 'extra-for-new-module' },
        members: [],
        routes: []
      })
    )
    expectOk(r)
    if (r.ok && r.frame.type === 'rc/bot-assign') {
      expect(r.frame.payload.secrets).toEqual({
        botToken: 'xoxb-x',
        signingSecret: 'sig',
        clientSecret: 'extra-for-new-module'
      })
    }
  })

  it('keeps validating the typed Slack/Feishu secret shapes', () => {
    const bad = decodeRelayCpFrame(
      envelope('rc/bot-assign', {
        botId: BOT_ID,
        platform: 'slack',
        secrets: 'not-an-object',
        members: [],
        routes: []
      })
    )
    expect(bad.ok).toBe(false)
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

  // The console composer's platform gate (webchat-cross-integration-continuation.md §9).
  it('continuableOrigin admits chat and hook, and nothing it cannot classify', () => {
    for (const chat of ['slack', 'telegram', 'discord', 'feishu']) expect(continuableOrigin(chat)).toBe(true)
    expect(continuableOrigin('hook')).toBe(true)
    // webchat continues in place, dream is not a conversation, and an unknown id fails closed.
    expect(continuableOrigin('webchat')).toBe(false)
    expect(continuableOrigin('dream')).toBe(false)
    expect(continuableOrigin(UNKNOWN)).toBe(false)
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
