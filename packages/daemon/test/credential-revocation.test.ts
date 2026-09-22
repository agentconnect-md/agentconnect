// A socket's explicit credential revocation reaches the CP as `integration/revoked` and stays queued until the CP commits a verdict.
import { describe, it, expect, vi } from 'vitest'
import { WireError } from '@agentconnect.md/connection'
import type { IntegrationRevoked, IntegrationRevokedOk } from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import { CredentialRevocationReporter } from '../src/platforms/credential-revocation.js'
import { FakeClock } from './cp/fake-clock.js'

const CP_INTEGRATION = '0f0e0d0c-0b0a-4908-8706-050403020100'
const LATE_CP_INTEGRATION = '1f1e1d1c-1b1a-4918-9716-151413121110'
const LOCAL_INTEGRATION = 'hand-authored-slack'
const EVENT_TIME = 1_780_000_000
const SLACK = { botToken: 'xoxb-fixture', appToken: 'xapp-1-A0FIXTURE-1-fixture' }
const quietLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

type Answer = () => Promise<IntegrationRevokedOk>

/** A CP link the test drives: whether it is up, whether it understands the frame, and the verdict of each report. */
function fakeCp() {
  const sent: IntegrationRevoked[] = []
  const cp = {
    up: true,
    supports: true,
    answers: [] as Answer[],
    connected: () => cp.up,
    reportIntegrationRevoked: vi.fn(async (payload: IntegrationRevoked) => {
      if (!cp.supports) return 'unsupported' as const
      sent.push(payload)
      return (cp.answers.shift() ?? (async () => ({ applied: true })))()
    })
  }
  return { cp, sent }
}

type Fire = (type: string, event: unknown) => unknown

/** One socket opening with a CP-owned and a hand-authored integration of one Slack app; as in the daemon, bindings land only after start() resolves. */
async function openSocket(
  cp: ReturnType<typeof fakeCp>['cp'],
  opts: { duringStart?: (fire: Fire, bound: ReadonlyMap<string, unknown>) => Promise<unknown> } = {}
) {
  const handlers = new Map<string, (a: { event: unknown; body?: unknown }) => unknown>()
  const clock = new FakeClock()
  const integrations = [
    { id: CP_INTEGRATION, origin: 'cp', platform: 'slack', core: { bindRules: [] }, config: SLACK },
    { id: LOCAL_INTEGRATION, platform: 'slack', core: { bindRules: [] }, config: SLACK }
  ]
  // A CP-owned integration outside the opening roster, bound onto the open socket later.
  const late = { id: LATE_CP_INTEGRATION, origin: 'cp', platform: 'slack', core: { bindRules: [] }, config: SLACK }
  const agent = { id: 'agent', integrations } as unknown as LoadedAgent
  const bound = new Map<string, unknown>()
  const fire: Fire = (type, event) => handlers.get(type)!({ event, body: { team_id: 'T1', event_time: EVENT_TIME } })
  const reconciler = new ConnectionReconciler({
    log: () => quietLog,
    clock: () => clock,
    draining: () => false,
    boltDebug: () => false,
    slackAppFactory: () => () => ({
      message() {},
      event(type: string, h: (a: { event: unknown; body?: unknown }) => unknown) {
        handlers.set(type, h)
      },
      action() {},
      shortcut() {},
      view() {},
      client: { auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1' }) } },
      // Bolt's start opens the socket, so Slack may deliver an event before it resolves.
      start: async () => void (await opts.duringStart?.(fire, bound)),
      stop: async () => {}
    }),
    transportAgents: (agents?: LoadedAgent[]) => agents ?? [agent],
    cpClient: () => cp,
    bindSlack: (id: string, conn: unknown) => void bound.set(id, conn),
    refreshChannels: async () => {},
    slackNameResolver: () => undefined,
    srcIntegrationIds: (conn: unknown) => [...bound].filter(([, c]) => c === conn).map(([id]) => id),
    integrationConfigById: (id: string) => [...integrations, late].find((i) => i.id === id)
  } as unknown as ConnectionReconcilerHost)
  await reconciler.openInitialSlackConnections([agent])
  const bindLate = () => bound.set(LATE_CP_INTEGRATION, reconciler.slackPool.all()[0])
  // The integration is re-keyed onto another socket, as when its credential moves to another app.
  const moveAway = () => bound.set(CP_INTEGRATION, { anotherSocket: true })
  return { reconciler, clock, fire, bound, bindLate, moveAway }
}

const self = { botUserId: 'UBOT', workspaceId: 'T1' }
const uninstalled = {
  integrationIds: [CP_INTEGRATION],
  reason: 'app_uninstalled',
  eventAtMs: EVENT_TIME * 1000,
  ...self
}

describe('socket credential revocation → integration/revoked', () => {
  it('reports an uninstall for the CP-owned integrations the socket serves, never a hand-authored one', async () => {
    const { cp, sent } = fakeCp()
    const { fire, bound } = await openSocket(cp)
    expect([...bound.keys()]).toEqual([CP_INTEGRATION, LOCAL_INTEGRATION])
    await fire('app_uninstalled', { type: 'app_uninstalled' })
    await vi.waitFor(() => expect(sent).toEqual([uninstalled]))
  })

  it('reports the opening roster for an event that lands before the socket is bound', async () => {
    const { cp, sent } = fakeCp()
    let boundAtEvent: string[] | undefined
    await openSocket(cp, {
      duringStart: async (fire, bound) => {
        boundAtEvent = [...bound.keys()]
        await fire('app_uninstalled', { type: 'app_uninstalled' })
      }
    })
    expect(boundAtEvent).toEqual([])
    await vi.waitFor(() => expect(sent).toEqual([uninstalled]))
  })

  it('reports only live bindings once the socket is bound, never its opening roster', async () => {
    const { cp, sent } = fakeCp()
    const { fire, bindLate, moveAway } = await openSocket(cp)
    bindLate()
    moveAway()
    await fire('app_uninstalled', { type: 'app_uninstalled' })
    await vi.waitFor(() => expect(sent).toEqual([{ ...uninstalled, integrationIds: [LATE_CP_INTEGRATION] }]))
  })

  it('does not report an integration re-keyed to another socket after the bind', async () => {
    const { cp } = fakeCp()
    const { fire, moveAway } = await openSocket(cp)
    moveAway()
    await fire('app_uninstalled', { type: 'app_uninstalled' })
    await new Promise((r) => setImmediate(r))
    expect(cp.reportIntegrationRevoked).not.toHaveBeenCalled()
  })

  it('ignores a user-token-only revocation and reports one that names the bot token', async () => {
    const { cp, sent } = fakeCp()
    const { fire } = await openSocket(cp)
    await fire('tokens_revoked', { type: 'tokens_revoked', tokens: { oauth: ['U2'] } })
    await new Promise((r) => setImmediate(r))
    expect(cp.reportIntegrationRevoked).not.toHaveBeenCalled()
    await fire('tokens_revoked', { type: 'tokens_revoked', tokens: { bot: ['UBOT'] } })
    await vi.waitFor(() => expect(sent).toEqual([{ ...uninstalled, reason: 'tokens_revoked' }]))
  })

  it('keeps the report for a CP that does not understand the frame, and sends it once one does', async () => {
    const { cp, sent } = fakeCp()
    cp.supports = false
    const { reconciler, fire } = await openSocket(cp)
    await fire('app_uninstalled', { type: 'app_uninstalled' })
    await vi.waitFor(() => expect(cp.reportIntegrationRevoked).toHaveBeenCalledOnce())
    expect(sent).toEqual([])
    cp.supports = true
    await reconciler.replayCredentialRevocations()
    expect(sent).toEqual([uninstalled])
  })

  it('re-sends after a reconnect until the CP acknowledges, then never again', async () => {
    const { cp, sent } = fakeCp()
    cp.answers.push(() => Promise.reject(new WireError('INTERNAL', 'no reply before the link dropped', true)))
    const { reconciler, clock, fire } = await openSocket(cp)
    await fire('app_uninstalled', { type: 'app_uninstalled' })
    await vi.waitFor(() => expect(clock.pending()).toEqual([5_000]))
    expect(sent).toHaveLength(1)
    // The link is down when the backoff fires: nothing can be sent, and nothing is dropped either.
    cp.up = false
    clock.advance(5_000)
    await new Promise((r) => setImmediate(r))
    expect(sent).toHaveLength(1)
    cp.up = true
    await reconciler.replayCredentialRevocations()
    expect(sent).toEqual([uninstalled, uninstalled])
    await reconciler.replayCredentialRevocations()
    expect(sent).toHaveLength(2)
  })
})

describe('CredentialRevocationReporter', () => {
  const reporter = (cp: ReturnType<typeof fakeCp>['cp']) =>
    new CredentialRevocationReporter({ cp: () => cp, clock: () => new FakeClock(), log: () => quietLog })

  it('keeps the newest event per integration while one is unacknowledged', async () => {
    const { cp, sent } = fakeCp()
    cp.up = false
    const r = reporter(cp)
    r.report([CP_INTEGRATION], { reason: 'tokens_revoked', eventAtMs: 2_000, ...self })
    r.report([CP_INTEGRATION], { reason: 'app_uninstalled', eventAtMs: 1_000, ...self })
    cp.up = true
    await r.replay()
    expect(sent).toEqual([{ integrationIds: [CP_INTEGRATION], reason: 'tokens_revoked', eventAtMs: 2_000, ...self }])
  })

  it('drops a report the CP refuses outright instead of retrying it forever', async () => {
    const { cp, sent } = fakeCp()
    cp.answers.push(() => Promise.reject(new WireError('SCOPE_DENIED', 'organization is required', false)))
    const r = reporter(cp)
    r.report([CP_INTEGRATION], { reason: 'app_uninstalled', eventAtMs: 1_000, ...self })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await r.replay()
    expect(sent).toHaveLength(1)
  })
})
