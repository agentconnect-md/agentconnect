// A socket's explicit credential revocation reaches the CP as `integration/revoked` and stays queued until the CP commits a verdict.
import { describe, it, expect, vi } from 'vitest'
import { WireError } from '@agentconnect.md/connection'
import type { IntegrationRevoked, IntegrationRevokedOk } from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import { CredentialRevocationReporter } from '../src/platforms/credential-revocation.js'
import { FakeClock } from './cp/fake-clock.js'

const CP_INTEGRATION = '0f0e0d0c-0b0a-4908-8706-050403020100'
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

/** One socket serving a CP-owned and a hand-authored integration on the same Slack app. */
async function openSocket(cp: ReturnType<typeof fakeCp>['cp']) {
  const handlers = new Map<string, (a: { event: unknown; body?: unknown }) => unknown>()
  const clock = new FakeClock()
  const integrations = [
    { id: CP_INTEGRATION, origin: 'cp', platform: 'slack', core: { bindRules: [] }, config: SLACK },
    { id: LOCAL_INTEGRATION, platform: 'slack', core: { bindRules: [] }, config: SLACK }
  ]
  const agent = { id: 'agent', integrations } as unknown as LoadedAgent
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
      start: async () => {},
      stop: async () => {}
    }),
    transportAgents: (agents?: LoadedAgent[]) => agents ?? [agent],
    cpClient: () => cp,
    bindSlack: () => {},
    refreshChannels: async () => {},
    slackNameResolver: () => undefined,
    srcIntegrationIds: () => integrations.map((i) => i.id),
    integrationConfigById: (id: string) => integrations.find((i) => i.id === id)
  } as unknown as ConnectionReconcilerHost)
  await reconciler.openInitialSlackConnections([agent])
  const fire = (type: string, event: unknown) =>
    handlers.get(type)!({ event, body: { team_id: 'T1', event_time: EVENT_TIME } })
  return { reconciler, clock, fire }
}

const uninstalled = { integrationIds: [CP_INTEGRATION], reason: 'app_uninstalled', eventAtMs: EVENT_TIME * 1000 }

describe('socket credential revocation → integration/revoked', () => {
  it('reports an uninstall for the CP-owned integrations the socket serves', async () => {
    const { cp, sent } = fakeCp()
    const { fire } = await openSocket(cp)
    await fire('app_uninstalled', { type: 'app_uninstalled' })
    await vi.waitFor(() => expect(sent).toEqual([uninstalled]))
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
    r.report([CP_INTEGRATION], { reason: 'tokens_revoked', eventAtMs: 2_000 })
    r.report([CP_INTEGRATION], { reason: 'app_uninstalled', eventAtMs: 1_000 })
    cp.up = true
    await r.replay()
    expect(sent).toEqual([{ integrationIds: [CP_INTEGRATION], reason: 'tokens_revoked', eventAtMs: 2_000 }])
  })

  it('drops a report the CP refuses outright instead of retrying it forever', async () => {
    const { cp, sent } = fakeCp()
    cp.answers.push(() => Promise.reject(new WireError('SCOPE_DENIED', 'organization is required', false)))
    const r = reporter(cp)
    r.report([CP_INTEGRATION], { reason: 'app_uninstalled', eventAtMs: 1_000 })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await r.replay()
    expect(sent).toHaveLength(1)
  })
})
