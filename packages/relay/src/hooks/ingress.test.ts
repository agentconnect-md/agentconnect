import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import {
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  type RcHookAssign,
  type RcRunReport,
  type RdAck,
  type RdMsg,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import { HookTable } from './hook-table.js'
import { HookRateLimiter } from './rate-limit.js'
import { registerHookIngress, HOOK_BODY_EXCERPT_MAX } from './ingress.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DAEMON_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function rule(overrides: Partial<RcHookAssign> = {}): RcHookAssign {
  return {
    hookId: HOOK,
    kind: 'webhook',
    agentId: AGENT,
    daemonId: DAEMON,
    configRevision: '3',
    dispatchRevision: '5',
    dispatchDaemonId: DAEMON,
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    sessionMode: 'perDelivery',
    webhook: { urlToken: 'wh_tok1' },
    ...overrides
  }
}

interface Harness {
  app: FastifyInstance
  table: HookTable
  clock: FakeClock
  sent: RdMsg[]
  dispatches: Array<{ daemonId: string; msg: RdMsg }>
  lookups: Array<{ daemonId: string; at: number }>
  reports: RcRunReport[]
  /** Per-call ack the fake daemon connection answers with. */
  ack: RdAck | (() => Promise<RdAck>)
  /** Toggle: no rd/* connection to the daemon at all. */
  offline: boolean
  /** Daemons for which the fake rd/* server has a connection. */
  onlineDaemons: Set<string>
  /** Make sendMsg throw before returning its promise. */
  throwSync: boolean
}

function makeHarness(): Harness {
  const clock = new FakeClock()
  const h: Partial<Harness> & {
    sent: RdMsg[]
    dispatches: Array<{ daemonId: string; msg: RdMsg }>
    lookups: Array<{ daemonId: string; at: number }>
    reports: RcRunReport[]
    onlineDaemons: Set<string>
  } = {
    sent: [],
    dispatches: [],
    lookups: [],
    reports: [],
    ack: { msgId: 'x', accepted: true },
    offline: false,
    onlineDaemons: new Set([DAEMON]),
    throwSync: false
  }
  const app = Fastify()
  const table = new HookTable()
  registerHookIngress(app, {
    table,
    daemons: () => ({
      get: (daemonId: string) => {
        h.lookups.push({ daemonId, at: clock.now() })
        if (h.offline || !h.onlineDaemons.has(daemonId)) return undefined
        return {
          sendMsg: (msg: RdMsg) => {
            h.sent.push(msg)
            h.dispatches.push({ daemonId, msg })
            if (h.throwSync) throw new Error('sync send failure')
            return typeof h.ack === 'function' ? h.ack() : Promise.resolve(h.ack!)
          }
        } as never
      }
    }),
    report: (r) => h.reports.push(r),
    limiter: new HookRateLimiter(clock, { capacity: 3, refillPerSec: 0 }),
    clock,
    log
  })
  h.app = app
  h.table = table
  h.clock = clock
  return h as Harness
}

async function flush(): Promise<void> {
  // dispatchHookFire settles on the microtask queue — one macrotask drains it.
  await new Promise((r) => setTimeout(r, 0))
}

describe('hook ingress', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(async () => {
    await h.app.close()
  })

  const post = (token: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) =>
    h.app.inject({
      method: 'POST',
      url: `/webhooks/in/${token}`,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      payload: JSON.stringify(opts.body ?? { ok: true })
    })

  it('unknown token answers a uniform 404 and dispatches nothing', async () => {
    const res = await post('wh_nope')
    expect(res.statusCode).toBe(404)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toHaveLength(0)
  })

  it('a valid token answers 202 with the deliveryKey and fires the daemon', async () => {
    h.table.upsert(rule())
    const res = await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'ci-42' } })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ deliveryKey: 'ci-42' })
    await flush()
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0]!
    expect(msg).toMatchObject({
      source: 'hook',
      agentId: AGENT,
      hookId: HOOK,
      deliveryKey: 'ci-42',
      msgId: `${HOOK}:ci-42`,
      sessionKey: `${HOOK}:ci-42`, // perDelivery
      configRevision: '3',
      dispatchRevision: '5',
      dispatchDaemonId: DAEMON,
      reviewPolicy: 'off',
      reportingMode: 'off',
      gateMode: 'informational'
    })
    if (msg.source !== 'hook') throw new Error('expected hook member')
    expect(msg.context).toMatchObject({ source: 'webhook', truncated: false })
    expect(h.reports).toEqual([
      expect.objectContaining({
        hookId: HOOK,
        deliveryKey: 'ci-42',
        status: 'accepted',
        daemonId: DAEMON,
        configRevision: '3',
        dispatchRevision: '5',
        dispatchDaemonId: DAEMON
      })
    ])
  })

  it('fails rolling policy fields closed when the compiled dispatch fence is incomplete', async () => {
    h.table.upsert(
      rule({
        configRevision: undefined,
        dispatchRevision: undefined,
        dispatchDaemonId: undefined,
        reviewPolicy: 'full',
        reportingMode: 'check'
      })
    )
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'legacy-1' } })
    await flush()
    const msg = h.sent[0]! as RdMsgHook
    expect(msg).toMatchObject({ reviewPolicy: 'off', reportingMode: 'off', gateMode: 'informational' })
    expect(msg.configRevision).toBeUndefined()
    expect(h.reports[0]).toMatchObject({ reviewPolicy: 'off', reportingMode: 'off' })
  })

  it('shared sessionMode keys the whole hook to one session', async () => {
    h.table.upsert(rule({ sessionMode: 'shared' }))
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'k1' } })
    await flush()
    const msg = h.sent[0]!
    expect(msg.sessionKey).toBe(HOOK)
    expect(msg.msgId).toBe(`${HOOK}:k1`)
  })

  it('perSubject keys deliveries sharing X-AC-Session-Key to one session, msgId stays per delivery', async () => {
    h.table.upsert(rule({ sessionMode: 'perSubject' }))
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'd1', 'x-ac-session-key': 'ticket-42' } })
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'd2', 'x-ac-session-key': 'ticket-42' } })
    await flush()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]!.sessionKey).toBe(`${HOOK}:subject:ticket-42`)
    expect(h.sent[1]!.sessionKey).toBe(`${HOOK}:subject:ticket-42`)
    expect(h.sent[0]!.msgId).toBe(`${HOOK}:d1`)
    expect(h.sent[1]!.msgId).toBe(`${HOOK}:d2`)
  })

  it('perSubject without the header falls back to per-delivery affinity', async () => {
    h.table.upsert(rule({ sessionMode: 'perSubject' }))
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'd3' } })
    await flush()
    expect(h.sent[0]!.sessionKey).toBe(`${HOOK}:d3`)
  })

  it('perSubject ignores an oversized session key like an absent one', async () => {
    h.table.upsert(rule({ sessionMode: 'perSubject' }))
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'd4', 'x-ac-session-key': 'x'.repeat(201) } })
    await flush()
    expect(h.sent[0]!.sessionKey).toBe(`${HOOK}:d4`)
  })

  it('the session-key header changes nothing outside perSubject mode', async () => {
    h.table.upsert(rule())
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'd5', 'x-ac-session-key': 'ticket-42' } })
    await flush()
    expect(h.sent[0]!.sessionKey).toBe(`${HOOK}:d5`)
  })

  it('mints a uuid deliveryKey when the header is absent', async () => {
    h.table.upsert(rule())
    const res = await post('wh_tok1')
    const { deliveryKey } = res.json() as { deliveryKey: string }
    expect(deliveryKey).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('carries the anchoring target through to the fire', async () => {
    h.table.upsert(rule({ target: { platform: 'slack', channel: 'C123' } }))
    await post('wh_tok1')
    await flush()
    const msg = h.sent[0]!
    if (msg.source !== 'hook') throw new Error('expected hook member')
    expect(msg.target).toEqual({ platform: 'slack', channel: 'C123' })
  })

  describe('HMAC second layer', () => {
    const SECRET = 'whs_sekret'
    const body = { alert: 'db down' }
    const sig = (payload: string, secret = SECRET) =>
      `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`

    beforeEach(() => h.table.upsert(rule({ webhook: { urlToken: 'wh_tok1', hmacSecret: SECRET } })))

    it('accepts a correctly signed body', async () => {
      const payload = JSON.stringify(body)
      const res = await h.app.inject({
        method: 'POST',
        url: '/webhooks/in/wh_tok1',
        headers: { 'content-type': 'application/json', 'x-ac-signature': sig(payload) },
        payload
      })
      expect(res.statusCode).toBe(202)
    })

    it('missing signature reads as 404 (no oracle)', async () => {
      const res = await post('wh_tok1', { body })
      expect(res.statusCode).toBe(404)
    })

    it('wrong-key signature reads as 404', async () => {
      const payload = JSON.stringify(body)
      const res = await h.app.inject({
        method: 'POST',
        url: '/webhooks/in/wh_tok1',
        headers: { 'content-type': 'application/json', 'x-ac-signature': sig(payload, 'whs_other') },
        payload
      })
      expect(res.statusCode).toBe(404)
      await flush()
      expect(h.sent).toHaveLength(0)
    })

    it('malformed signature header reads as 404', async () => {
      const res = await post('wh_tok1', { body, headers: { 'x-ac-signature': 'md5=zz' } })
      expect(res.statusCode).toBe(404)
    })
  })

  it('rate-limits per hook with 429 after the burst', async () => {
    h.table.upsert(rule())
    for (let i = 0; i < 3; i++) expect((await post('wh_tok1')).statusCode).toBe(202)
    expect((await post('wh_tok1')).statusCode).toBe(429)
  })

  it('truncates the envelope body at 64 KiB and flags it', async () => {
    h.table.upsert(rule())
    // Over the 64 KiB excerpt cap, under the 128 KiB route limit.
    const payload = `{"pad":"${'x'.repeat(HOOK_BODY_EXCERPT_MAX + 4096)}"}`
    const res = await h.app.inject({
      method: 'POST',
      url: '/webhooks/in/wh_tok1',
      headers: { 'content-type': 'application/json' },
      payload
    })
    expect(res.statusCode).toBe(202)
    await flush()
    const msg = h.sent[0]!
    if (msg.source !== 'hook') throw new Error('expected hook member')
    expect(msg.context?.truncated).toBe(true)
    expect(msg.context?.body).toHaveLength(HOOK_BODY_EXCERPT_MAX)
  })

  it('rejects oversized bodies via the per-route limit', async () => {
    h.table.upsert(rule())
    const res = await h.app.inject({
      method: 'POST',
      url: '/webhooks/in/wh_tok1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(150 * 1024) })
    })
    expect(res.statusCode).toBe(413)
  })

  it('retries an offline daemon at exactly t=0/1/4/12s, reports once after exhaustion, and still answers 202 immediately', async () => {
    h.table.upsert(rule())
    h.offline = true
    const res = await post('wh_tok1')
    expect(res.statusCode).toBe(202)
    expect(h.lookups.map((attempt) => attempt.at)).toEqual([0])
    expect(h.reports).toHaveLength(0)

    h.clock.advance(999)
    expect(h.lookups.map((attempt) => attempt.at)).toEqual([0])
    h.clock.advance(1)
    expect(h.lookups.map((attempt) => attempt.at)).toEqual([0, 1_000])
    h.clock.advance(3_000)
    expect(h.lookups.map((attempt) => attempt.at)).toEqual([0, 1_000, 4_000])
    expect(h.reports).toHaveLength(0)
    h.clock.advance(8_000)
    expect(h.lookups.map((attempt) => attempt.at)).toEqual([0, 1_000, 4_000, 12_000])
    expect(h.reports).toEqual([
      expect.objectContaining({ status: 'failed', reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE })
    ])
  })

  it('recovers on a later lookup without emitting an intermediate offline report', async () => {
    h.table.upsert(rule())
    h.offline = true
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'recover-1' } })

    h.clock.advance(1_000)
    expect(h.reports).toHaveLength(0)
    h.offline = false
    h.clock.advance(3_000)
    await flush()

    expect(h.lookups.map((attempt) => attempt.at)).toEqual([0, 1_000, 4_000])
    expect(h.sent).toHaveLength(1)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'accepted', deliveryKey: 'recover-1' })])
  })

  it('follows a fenced placement-only update, refreshes its snapshot, and preserves stable delivery metadata', async () => {
    const initial = rule({ target: { platform: 'slack', channel: 'C123' } })
    h.table.upsert(initial)
    h.offline = true
    const res = await post('wh_tok1', {
      body: { alert: 'db down' },
      headers: { 'x-ac-delivery-key': 'move-1' }
    })
    expect(res.statusCode).toBe(202)

    h.table.upsert(
      rule({
        daemonId: DAEMON_B,
        dispatchDaemonId: DAEMON_B,
        dispatchRevision: '6',
        target: { platform: 'slack', channel: 'C123' }
      })
    )
    h.onlineDaemons.add(DAEMON_B)
    h.offline = false
    h.clock.advance(1_000)
    await flush()

    expect(h.lookups).toEqual([
      { daemonId: DAEMON, at: 0 },
      { daemonId: DAEMON_B, at: 1_000 }
    ])
    expect(h.dispatches).toHaveLength(1)
    const dispatched = h.dispatches[0]!
    expect(dispatched.daemonId).toBe(DAEMON_B)
    expect(dispatched.msg).toMatchObject({
      hookId: HOOK,
      deliveryKey: 'move-1',
      msgId: `${HOOK}:move-1`,
      sessionKey: `${HOOK}:move-1`,
      firedAt: new Date(0).toISOString(),
      configRevision: '3',
      dispatchRevision: '6',
      dispatchDaemonId: DAEMON_B,
      target: { platform: 'slack', channel: 'C123' },
      context: { source: 'webhook', body: JSON.stringify({ alert: 'db down' }), truncated: false }
    })
    expect(h.reports).toEqual([
      expect.objectContaining({
        status: 'accepted',
        daemonId: DAEMON_B,
        configRevision: '3',
        dispatchRevision: '6',
        dispatchDaemonId: DAEMON_B
      })
    ])
  })

  it.each(['removed', 'config', 'agent', 'kind'] as const)(
    'cancels silently when retry authority is %s',
    async (change) => {
      h.table.upsert(rule())
      h.offline = true
      await post('wh_tok1', { headers: { 'x-ac-delivery-key': `cancel-${change}` } })

      if (change === 'removed') h.table.remove(HOOK)
      else if (change === 'config') h.table.upsert(rule({ configRevision: '4' }))
      else if (change === 'agent') h.table.upsert(rule({ agentId: AGENT_B }))
      else {
        h.table.upsert(
          rule({
            kind: 'github',
            webhook: undefined,
            github: {
              repoId: '1',
              repoFullName: 'acme/infra',
              events: ['issues:opened'],
              labelFilter: [],
              mentionOnly: false,
              installationIds: ['1']
            }
          })
        )
      }
      h.clock.advance(1_000)

      expect(h.lookups).toEqual([{ daemonId: DAEMON, at: 0 }])
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    }
  )

  it('lets an unchanged legacy rule recover on the same placement but never retargets it', async () => {
    const legacy = rule({
      configRevision: undefined,
      dispatchRevision: undefined,
      dispatchDaemonId: undefined
    })
    h.table.upsert(legacy)
    h.offline = true
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'legacy-same' } })
    h.offline = false
    h.clock.advance(1_000)
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'accepted' })])

    h.sent.length = 0
    h.reports.length = 0
    h.lookups.length = 0
    h.offline = true
    await post('wh_tok1', { headers: { 'x-ac-delivery-key': 'legacy-move' } })
    h.table.upsert({ ...legacy, daemonId: DAEMON_B })
    h.onlineDaemons.add(DAEMON_B)
    h.offline = false
    h.clock.advance(1_000)
    expect(h.lookups).toEqual([{ daemonId: DAEMON, at: 1_000 }])
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toHaveLength(0)
  })

  it('a rejected ack reports failed(rejected:<reason>)', async () => {
    h.table.upsert(rule())
    h.ack = { msgId: 'x', accepted: false, reason: 'paused' }
    await post('wh_tok1')
    await flush()
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:paused' })])
    h.clock.advance(12_000)
    expect(h.lookups).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
  })

  it('a synchronous send failure reports dispatch_timeout once without retrying', async () => {
    h.table.upsert(rule())
    h.throwSync = true
    await post('wh_tok1')
    await flush()
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'dispatch_timeout' })])
    h.clock.advance(12_000)
    expect(h.lookups).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(h.reports).toHaveLength(1)
  })

  it('an asynchronously rejected send reports dispatch_timeout once without retrying', async () => {
    h.table.upsert(rule())
    h.ack = () => Promise.reject(new Error('timeout'))
    await post('wh_tok1')
    await flush()
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'dispatch_timeout' })])
    h.clock.advance(12_000)
    expect(h.lookups).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(h.reports).toHaveLength(1)
  })
})
