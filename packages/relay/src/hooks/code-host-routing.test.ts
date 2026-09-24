import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import type { RcHookAssign, RcHookRouting, RdAck, RdMsg, RdMsgHook } from '@agentconnect.md/protocol'
import { HookTable } from './hook-table.js'
import { HookRateLimiter } from './rate-limit.js'
import {
  askCodeHostRoutingHost,
  codeHostHostCopy,
  codeHostRecordOnlyEligible,
  createCodeHostRouter,
  hostUnavailableSelection,
  sendCodeHostRecordOnlyCopy,
  HOOK_ROUTING_ACK_TIMEOUT_MS,
  type CodeHostRoutingProvider
} from './code-host-routing.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ROUTING = '66666666-6666-4666-8666-666666666666'
const DECISION = '44444444-4444-4444-8444-444444444444'
const REPO = '4455667'
const FEATURE_A = 'example-feature-a'
const FEATURE_B = 'example-feature-b'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const routing: RcHookRouting = {
  routingId: ROUTING,
  decisionId: DECISION,
  evaluationAgentId: AGENT,
  evaluationDaemonId: DAEMON
}

function rule(overrides: Partial<RcHookAssign> = {}): RcHookAssign {
  return {
    hookId: HOOK,
    kind: 'gitlab',
    agentId: AGENT,
    daemonId: DAEMON,
    configRevision: '3',
    dispatchRevision: '5',
    dispatchDaemonId: DAEMON,
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    sessionMode: 'perThread',
    routing,
    gitlab: {
      projectId: REPO,
      projectPath: 'example-group/example-project',
      sessionKeyPrefix: `gitlab:${REPO}`,
      events: ['issues:*'],
      mentionOnly: false,
      serviceAccountUserId: '9042',
      serviceAccountUsername: 'example-bot',
      signingToken: 'whsec_example'
    },
    ...overrides
  }
}

interface FakeEvent {
  family?: 'issues' | 'merge_request'
  recordable: boolean
}

const provider: CodeHostRoutingProvider<FakeEvent> = {
  provider: 'gitlab',
  hostFeatures: [FEATURE_A, FEATURE_B],
  eventFamily: (event) => event.family,
  ruleFamilies: () => new Set(['issues'] as const),
  hostRule: (scopeRules, scope) => scopeRules.find((r) => r.agentId === scope.evaluationAgentId),
  recordOnlyEligible: (_rule, event) => event.recordable
}

function message(r: RcHookAssign): RdMsgHook {
  return {
    source: 'hook',
    agentId: r.agentId,
    sessionKey: `gitlab:${REPO}:issue:42`,
    msgId: `${r.hookId}:delivery-1`,
    hookId: r.hookId,
    deliveryKey: 'delivery-1',
    firedAt: new Date(0).toISOString(),
    event: 'issues:opened'
  }
}

function daemons(opts: { features?: string[]; online?: boolean; ack?: (msg: RdMsgHook) => Promise<RdAck> } = {}) {
  const sent: Array<{ msg: RdMsg; opts: unknown }> = []
  const conn = {
    supports: (feature: string) => (opts.features ?? [FEATURE_A, FEATURE_B]).includes(feature),
    sendMsg: async (msg: RdMsg, sendOpts: unknown) => {
      sent.push({ msg, opts: sendOpts })
      if (opts.ack) return opts.ack(msg as RdMsgHook)
      const hook = msg as RdMsgHook
      return {
        msgId: msg.msgId,
        accepted: true,
        hookRoute: {
          targets: (hook.routing?.candidates ?? []).map((c) => ({
            hookId: c.hookId,
            selection: { routingId: ROUTING, decisionId: DECISION, reason: 'otherwise' as const }
          }))
        }
      }
    }
  }
  return { sent, get: () => () => ({ get: () => (opts.online === false ? undefined : conn) }) as never }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('code-host routing helpers', () => {
  it('builds the host copy under a distinct msgId, carrying the candidates in order', () => {
    const copy = codeHostHostCopy(message(rule()), routing, [
      { rule: rule() },
      { rule: rule({ hookId: HOOK_B, agentId: AGENT_B }) }
    ])
    expect(copy.msgId).toBe(`${HOOK}:delivery-1:route`)
    expect(copy.routing).toEqual({
      routingId: ROUTING,
      decisionId: DECISION,
      candidates: [
        { hookId: HOOK, agentId: AGENT },
        { hookId: HOOK_B, agentId: AGENT_B }
      ]
    })
    expect(hostUnavailableSelection(routing)).toEqual({
      routingId: ROUTING,
      decisionId: DECISION,
      reason: 'unavailable',
      unavailableReason: 'host_unavailable'
    })
  })

  it('asks the host once with the routing timeout, and fences on every provider feature', async () => {
    const copy = codeHostHostCopy(message(rule()), routing, [{ rule: rule() }])
    const ok = daemons()
    expect(await askCodeHostRoutingHost(ok.get(), routing, copy, [FEATURE_A, FEATURE_B])).toMatchObject({
      kind: 'targets'
    })
    expect(ok.sent[0]?.opts).toEqual({ ackTimeoutMs: HOOK_ROUTING_ACK_TIMEOUT_MS, maxTries: 1 })

    const old = daemons({ features: [FEATURE_A] })
    expect(await askCodeHostRoutingHost(old.get(), routing, copy, [FEATURE_A, FEATURE_B])).toEqual({
      kind: 'unavailable',
      reason: 'unsupported'
    })
    expect(old.sent).toHaveLength(0)
    expect(await askCodeHostRoutingHost(old.get(), routing, copy, [FEATURE_A])).toMatchObject({ kind: 'targets' })

    const offline = daemons({ online: false })
    expect(await askCodeHostRoutingHost(offline.get(), routing, copy, [])).toEqual({
      kind: 'unavailable',
      reason: 'offline'
    })
  })

  it('reads a refusal as held and a transport failure as unavailable', async () => {
    const copy = codeHostHostCopy(message(rule()), routing, [{ rule: rule() }])
    const held = daemons({ ack: async (msg) => ({ msgId: msg.msgId, accepted: false, reason: 'pending_sync' }) })
    expect(await askCodeHostRoutingHost(held.get(), routing, copy, [])).toEqual({
      kind: 'held',
      reason: 'pending_sync'
    })
    const noRoute = daemons({ ack: async (msg) => ({ msgId: msg.msgId, accepted: true }) })
    expect(await askCodeHostRoutingHost(noRoute.get(), routing, copy, [])).toEqual({ kind: 'held', reason: 'no_route' })
    const timeout = daemons({
      ack: async () => {
        throw new Error('no ack')
      }
    })
    expect(await askCodeHostRoutingHost(timeout.get(), routing, copy, [])).toMatchObject({ kind: 'unavailable' })
  })

  it('drops a record-only copy the host cannot read, and sends one it can', () => {
    const copy = codeHostHostCopy(message(rule()), routing, [])
    const old = daemons({ features: [FEATURE_A] })
    sendCodeHostRecordOnlyCopy(old.get(), routing, copy, [FEATURE_A, FEATURE_B], log, 'example ingress')
    expect(old.sent).toHaveLength(0)
    const ok = daemons()
    sendCodeHostRecordOnlyCopy(ok.get(), routing, copy, [FEATURE_A, FEATURE_B], log, 'example ingress')
    expect(ok.sent).toHaveLength(1)
  })

  it.each<[string, RcHookAssign, FakeEvent, boolean]>([
    ['routed rule, covered family, provider admits', rule(), { family: 'issues', recordable: true }, true],
    ['unrouted rule', rule({ routing: undefined }), { family: 'issues', recordable: true }, false],
    ['no family', rule(), { recordable: true }, false],
    ['family the rule does not cover', rule(), { family: 'merge_request', recordable: true }, false],
    ['provider fence refuses', rule(), { family: 'issues', recordable: false }, false]
  ])('record-only eligibility: %s', (_name, hostRule, event, expected) => {
    expect(codeHostRecordOnlyEligible(provider, hostRule, event)).toBe(expected)
  })
})

describe('createCodeHostRouter', () => {
  function build(event: FakeEvent, d = daemons(), capacity = 5) {
    const table = new HookTable()
    const limiter = new HookRateLimiter(new FakeClock(), { capacity, refillPerSec: 0 })
    const fired: Array<{ rule: RcHookAssign; msg: RdMsgHook; label: string }> = []
    const router = createCodeHostRouter({ table, daemons: d.get(), limiter, log }, provider, {
      event,
      repoId: REPO,
      deliveryKey: 'delivery-1',
      eventAction: 'issues:opened',
      messageFor: message,
      fire: (r, msg, label) => fired.push({ rule: r, msg, label })
    })
    return { table, limiter, fired, router, sent: d.sent }
  }

  it('routes nothing for an event outside every family', async () => {
    const { table, router, fired, sent } = build({ recordable: true })
    table.upsert(rule())
    expect(router.family).toBeUndefined()
    expect(router.routed(rule())).toBe(false)
    router.routeScopes()
    await settle()
    expect(sent).toHaveLength(0)
    expect(fired).toHaveLength(0)
  })

  it('waits for every tracked task before routing, so a late candidate joins the one host copy', async () => {
    const { table, router, fired, sent } = build({ family: 'issues', recordable: true })
    const peer = rule({ hookId: HOOK_B, agentId: AGENT_B })
    table.upsert(rule())
    table.upsert(peer)
    router.collect(rule())
    let release!: () => void
    router.track(
      new Promise<void>((resolve) => {
        release = resolve
      }).then(() => router.collect(peer))
    )
    router.routeScopes()
    await settle()
    expect(sent).toHaveLength(0)
    release()
    await settle()
    expect(sent).toHaveLength(1)
    expect((sent[0]?.msg as RdMsgHook).routing?.candidates).toHaveLength(2)
    expect(fired.map((f) => [f.rule.hookId, f.msg.routeSelection?.reason, f.label])).toEqual([
      [HOOK, 'otherwise', 'routed:otherwise'],
      [HOOK_B, 'otherwise', 'routed:otherwise']
    ])
  })

  it('spends a routed rule budget only when it fires, and a record-only copy on its own key', async () => {
    const { table, router, limiter, fired } = build({ family: 'issues', recordable: true }, daemons(), 1)
    table.upsert(rule())
    router.collect(rule())
    router.routeScopes()
    await settle()
    expect(fired).toHaveLength(1)
    expect(limiter.allow(HOOK)).toBe(false)
    expect(limiter.allow(`routing-record:${ROUTING}`)).toBe(true)
  })

  it('records an event with no candidate on the host, and nothing when the provider fence refuses', async () => {
    const recorded = build({ family: 'issues', recordable: true })
    recorded.table.upsert(rule())
    recorded.router.routeScopes()
    await settle()
    expect(recorded.sent.map((s) => (s.msg as RdMsgHook).routing?.candidates)).toEqual([[]])
    expect(recorded.fired).toHaveLength(0)

    const refused = build({ family: 'issues', recordable: false })
    refused.table.upsert(rule())
    refused.router.routeScopes()
    await settle()
    expect(refused.sent).toHaveLength(0)
  })

  it('falls back to every candidate when the host rule has no deliverable message', async () => {
    const d = daemons()
    const table = new HookTable()
    const fired: RdMsgHook[] = []
    const router = createCodeHostRouter(
      { table, daemons: d.get(), limiter: new HookRateLimiter(new FakeClock(), { capacity: 5, refillPerSec: 0 }), log },
      provider,
      {
        event: { family: 'issues', recordable: true },
        repoId: REPO,
        deliveryKey: 'delivery-1',
        eventAction: 'issues:opened',
        messageFor: (r) => (r.hookId === HOOK ? undefined : message(r)),
        fire: (_r, msg) => fired.push(msg)
      }
    )
    const peer = rule({ hookId: HOOK_B, agentId: AGENT_B })
    table.upsert(rule())
    table.upsert(peer)
    router.collect(peer)
    router.routeScopes()
    await settle()
    expect(d.sent).toHaveLength(0)
    expect(fired.map((m) => [m.hookId, m.routeSelection?.reason])).toEqual([[HOOK_B, 'unavailable']])
  })
})
