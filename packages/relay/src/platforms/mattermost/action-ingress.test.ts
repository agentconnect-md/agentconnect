import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import {
  MATTERMOST_ACTION_PATH,
  MATTERMOST_PLATFORM,
  deriveMattermostOrgActionSecret,
  signMattermostActionToken,
  type MattermostActionClaims,
  type RdAck,
  type RdMsgPlatformAction
} from '@agentconnect.md/protocol'
import { HookRateLimiter } from '../../hooks/rate-limit.js'
import { mattermostActionMsgId, registerMattermostActionIngress } from './action-ingress.js'

const DAEMON_A = '11111111-1111-4111-8111-111111111111'
const DAEMON_B = '99999999-9999-4999-8999-999999999999'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'
const CARD_ID = '44444444-4444-4444-8444-444444444444'
const CHANNEL_ID = 'mmchan1234567890abcdefghij'
const POST_ID = 'mmpost1234567890abcdefghij'
const USER_ID = 'mmuser1234567890abcdefghij'
const SECRET = 'mattermost-action-test-secret-0123456789abcd'

function buildApp(
  over: {
    secret?: string | undefined
    daemons?: Record<string, { sendMsg: (msg: RdMsgPlatformAction) => Promise<RdAck> }>
    daemonForAgent?: (agentId: string) => string | undefined
    now?: number
    timeoutMs?: number
  } = {}
) {
  const app = Fastify()
  const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
  const daemons = over.daemons ?? { [DAEMON_A]: { sendMsg } }
  const log = { debug: vi.fn(), warn: vi.fn() }
  registerMattermostActionIngress(app, {
    secret: () => ('secret' in over ? over.secret : SECRET),
    getDaemon: (id) => daemons[id] as never,
    daemonForAgent: over.daemonForAgent ?? (() => undefined),
    clock: { now: () => over.now ?? 1_000_000 },
    log,
    ...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {})
  })
  return { app, sendMsg, log }
}

function claims(over: Partial<MattermostActionClaims> = {}): MattermostActionClaims {
  return {
    v: 1,
    daemonId: DAEMON_A,
    agentId: AGENT_ID,
    integrationId: INTEGRATION_ID,
    channelId: CHANNEL_ID,
    kind: 'approval',
    requestId: 'req-1',
    option: 0,
    exp: 2_000_000,
    ...over
  }
}

function callbackBody(token: string, over: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    user_name: 'alice',
    channel_id: CHANNEL_ID,
    team_id: 'mmteam1234567890abcdefghij',
    post_id: POST_ID,
    trigger_id: 'trig-1',
    context: { token },
    ...over
  }
}

describe('Mattermost action HTTP ingress', () => {
  it.each<{ kind: MattermostActionClaims['kind']; extra: Partial<MattermostActionClaims> }>([
    { kind: 'approval', extra: { option: 1 } },
    { kind: 'elicit', extra: { token: 'opt:0' } },
    { kind: 'capability', extra: { cardId: CARD_ID, generation: 2 } },
    { kind: 'draft', extra: { token: 'approve' } }
  ])('verifies signed $kind click and forwards RdMsgPlatformAction to daemon', async ({ kind, extra }) => {
    const { app, sendMsg } = buildApp()
    const c = claims({
      kind,
      option: extra.option,
      token: extra.token,
      cardId: extra.cardId,
      generation: extra.generation
    })
    if (kind !== 'approval') delete c.option
    if (kind !== 'elicit' && kind !== 'draft') delete c.token
    const signed = signMattermostActionToken(c, SECRET)
    const body = callbackBody(signed)

    const res = await app.inject({ method: 'POST', url: MATTERMOST_ACTION_PATH, payload: body })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({})
    expect(sendMsg).toHaveBeenCalledTimes(1)

    const forwarded = sendMsg.mock.calls[0]![0]
    expect(forwarded).toMatchObject({
      source: 'platform_action',
      platformId: MATTERMOST_PLATFORM,
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      botId: INTEGRATION_ID,
      sessionKey: `mattermost-action:${POST_ID}`,
      userId: USER_ID,
      payload: {
        postId: POST_ID,
        channelId: CHANNEL_ID,
        userId: USER_ID,
        userName: 'alice',
        kind,
        requestId: 'req-1'
      }
    })
    expect(forwarded.msgId).toBe(mattermostActionMsgId(body, forwarded.payload as never))
  })

  it('propagates ephemeralText refusals from daemon ack with HTTP 200', async () => {
    const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({
      msgId: msg.msgId,
      accepted: true,
      response: { ephemeralText: 'Only an Agent editor can answer this request.' }
    }))
    const { app } = buildApp({ daemons: { [DAEMON_A]: { sendMsg } } })
    const res = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(signMattermostActionToken(claims(), SECRET))
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ephemeral_text: 'Only an Agent editor can answer this request.' })
  })

  it('routes moved agent to live daemonForAgent before falling back to token daemonId', async () => {
    const sendMsgA = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const sendMsgB = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const { app } = buildApp({
      daemons: { [DAEMON_A]: { sendMsg: sendMsgA }, [DAEMON_B]: { sendMsg: sendMsgB } },
      daemonForAgent: (id) => (id === AGENT_ID ? DAEMON_B : undefined)
    })
    const res = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(signMattermostActionToken(claims(), SECRET))
    })
    expect(res.statusCode).toBe(200)
    expect(sendMsgA).not.toHaveBeenCalled()
    expect(sendMsgB).toHaveBeenCalledTimes(1)
  })

  it('rejects missing secret (503), invalid/expired tokens (401), channel mismatch (403), and bad JSON (400)', async () => {
    const noSecret = buildApp({ secret: undefined })
    const r503 = await noSecret.app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody('any.token')
    })
    expect(r503.statusCode).toBe(503)

    const { app, sendMsg } = buildApp({ now: 2_500_000 })
    const r400 = await app.inject({ method: 'POST', url: MATTERMOST_ACTION_PATH, payload: { bad: true } })
    expect(r400.statusCode).toBe(400)

    const expired = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(signMattermostActionToken(claims({ exp: 2_000_000 }), SECRET))
    })
    expect(expired.statusCode).toBe(401)

    const tampered = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(
        signMattermostActionToken(claims({ exp: 3_000_000 }), 'other-secret-0123456789abcdef0123456789')
      )
    })
    expect(tampered.statusCode).toBe(401)

    const mismatch = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(signMattermostActionToken(claims({ exp: 3_000_000 }), SECRET), {
        channel_id: 'otherchannel12345678901234'
      })
    })
    expect(mismatch.statusCode).toBe(403)
    expect(sendMsg).not.toHaveBeenCalled()
  })

  it('answers 200 ephemeral_text when daemon is offline or slow', async () => {
    const offline = buildApp({ daemons: {} })
    const rOffline = await offline.app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(signMattermostActionToken(claims(), SECRET))
    })
    expect(rOffline.statusCode).toBe(200)
    expect(rOffline.json()).toMatchObject({ ephemeral_text: expect.stringContaining('offline') })

    const slow = buildApp({
      timeoutMs: 10,
      daemons: {
        [DAEMON_A]: {
          sendMsg: () => new Promise(() => {})
        }
      }
    })
    const rTimeout = await slow.app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(signMattermostActionToken(claims(), SECRET))
    })
    expect(rTimeout.statusCode).toBe(200)
    expect(rTimeout.json()).toMatchObject({ ephemeral_text: expect.stringContaining('Processing') })
  })

  it('accepts long Mattermost trigger_id values (>128 chars) and nullable optional fields', async () => {
    const { app, sendMsg } = buildApp()
    const signed = signMattermostActionToken(claims({ kind: 'approval', option: 0 }), SECRET)
    const longTriggerId = `${'A'.repeat(140)}.${'B'.repeat(98)}`
    const body = callbackBody(signed, {
      trigger_id: longTriggerId,
      team_id: null,
      user_name: null
    })

    const res = await app.inject({ method: 'POST', url: MATTERMOST_ACTION_PATH, payload: body })
    expect(res.statusCode).toBe(200)
    expect(sendMsg).toHaveBeenCalledTimes(1)
    const forwarded = sendMsg.mock.calls[0]![0]
    expect(forwarded.msgId).toBe(mattermostActionMsgId(body, forwarded.payload as never))
  })

  it('enforces mm1 org-scoped tokens with masterSecret, blocks cross-tenant forgery, dot-traversal IDs, and rate limits', async () => {
    const app = Fastify()
    const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const now = 1_000_000
    registerMattermostActionIngress(app, {
      masterSecret: () => SECRET,
      getDaemon: (id) => (id === DAEMON_A ? ({ sendMsg } as never) : undefined),
      daemonForAgent: (id) => (id === AGENT_ID ? DAEMON_A : undefined),
      orgForAgent: (id) => (id === AGENT_ID ? 'org-a' : undefined),
      limiter: new HookRateLimiter({ now: () => now }, { capacity: 1, refillPerSec: 0 }),
      clock: { now: () => now },
      log: { debug: vi.fn(), warn: vi.fn() }
    })

    const orgBSecret = deriveMattermostOrgActionSecret(SECRET, 'org-b')
    // Tenant B attempts to target Tenant A's agent using Tenant B's own derived secret or claimed org.
    const crossTenantRes = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(signMattermostActionToken(claims({ orgId: 'org-b' }), orgBSecret))
    })
    expect(crossTenantRes.statusCode).toBe(403)
    expect(sendMsg).not.toHaveBeenCalled()

    // Rejects path-traversal dot segments in post_id.
    const orgASecret = deriveMattermostOrgActionSecret(SECRET, 'org-a')
    const validToken = signMattermostActionToken(claims({ orgId: 'org-a' }), orgASecret)
    const dotRes = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(validToken, { post_id: '..' })
    })
    expect(dotRes.statusCode).toBe(400)

    // Legitimate org-a callback succeeds, then second within burst is rate-limited (429).
    const okRes = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(validToken)
    })
    expect(okRes.statusCode).toBe(200)
    expect(sendMsg).toHaveBeenCalledTimes(1)

    const rateRes = await app.inject({
      method: 'POST',
      url: MATTERMOST_ACTION_PATH,
      payload: callbackBody(validToken)
    })
    expect(rateRes.statusCode).toBe(429)
    expect(sendMsg).toHaveBeenCalledTimes(1)
  })
})
