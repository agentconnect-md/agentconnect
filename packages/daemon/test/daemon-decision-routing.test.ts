import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionEvaluation, RdRoute, RdRouteSelection } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// Shared-bot By decision routing end to end on a real daemon and store (message-intake.md §6, decisions.md §10.3).

const BOT = '11111111-1111-4111-8111-111111111111'
const HOST_ID = '22222222-2222-4222-8222-222222222222'
const REMOTE_ID = '33333333-3333-4333-8333-333333333333'
const REMOTE_AGENT = '44444444-4444-4444-8444-444444444444'
const DECISION = 'd-1'
const definition = {
  id: DECISION,
  orgId: 'org-1',
  name: 'Topic',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  question: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'Money', technical: 'Bugs', sales: 'Quotes' }
  }
}
const routingConfig = {
  enabled: true,
  decisionId: DECISION,
  rules: [
    {
      id: 'billing',
      when: { type: 'choice', thresholds: { billing: 0.2 } },
      action: { type: 'agent', agentId: 'bot-a' }
    },
    {
      id: 'technical',
      when: { type: 'choice', thresholds: { technical: 0.2 } },
      action: { type: 'agent', agentId: REMOTE_AGENT }
    },
    { id: 'sales', when: { type: 'choice', thresholds: { sales: 0.2 } }, action: { type: 'agent', agentId: 'bot-c' } }
  ],
  otherwise: { type: 'skip' }
}
const all: DecisionEvaluation = {
  status: 'answered',
  answer: {
    type: 'choice',
    value: 'billing',
    probabilities: { billing: 0.4, technical: 0.35, sales: 0.25 },
    confidence: 0.4
  },
  model: 'jev-1.13.0',
  usage: { inputTokens: 20, outputTokens: 1 }
}

function scaffold(opts: { hosted?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-decision-routing-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of ['bot-a', 'bot-c']) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: `int-${id}`,
            platform: 'slack',
            core: {
              bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'decision' }, channel: 'C1' }],
              decisions: {
                bindings: [{ channel: 'C1', consumer: { type: 'shared_bot_routing' }, enabled: true }],
                definitions: [definition],
                ...(opts.hosted === false
                  ? {}
                  : { sharedBotRouting: { botId: BOT, config: routingConfig, channels: [{ channel: 'C1' }] } })
              }
            },
            config: { botToken: 'xoxb', appToken: 'xapp' }
          }
        ],
        output: { mode: 'low' }
      })
    )
  }
  return root
}

async function boot(opts: { hosted?: boolean } = {}) {
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async (_sessionId: string, _blocks: { type: string; text?: string }[]) => 'end_turn'),
    cancel: vi.fn(async () => {}),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(opts),
    hostFactory: () => host as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  ;(daemon as any).cfg.daemonId = HOST_ID
  for (const id of ['int-bot-a', 'int-bot-c'])
    (daemon as any).connByIntegration.set(id, {
      workspaceId: () => 'T_FAKE_TEAM',
      setStatus: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
      postMessage: vi.fn(async () => 'reply-1'),
      postBlocks: vi.fn(async () => 'status-bar'),
      updateBlocks: vi.fn(async () => {})
    })
  const relays = {
    sendRoute: vi.fn(async (route: RdRoute) => ({
      deliveryId: route.deliveryId,
      disposition: 'admitted' as const,
      daemonId: REMOTE_ID
    })),
    sendRouteReport: vi.fn(async () => ({ accepted: true })),
    stop: vi.fn(async () => {}),
    converge: vi.fn(),
    sendWebchatPost: vi.fn()
  }
  ;(daemon as any).relays = relays
  const store = (daemon as any).store
  const scope = (daemon as any).transportScopeForIntegrationIds(['int-bot-a']) as string | undefined
  const evaluate = vi.spyOn((daemon as any).decisionEvaluator, 'evaluate') as unknown as ReturnType<
    typeof vi.fn<(input: DecisionEvaluationInput, signal?: AbortSignal) => Promise<DecisionEvaluation>>
  >
  return {
    daemon,
    store,
    host,
    relays,
    evaluate,
    channel: transcriptChannelKey('C1', scope),
    router: (daemon as any).decisionRouter
  }
}

let ts = 100
const human = (over: Record<string, unknown> = {}) => {
  ts += 1
  const id = `1720000000.000${ts}`
  return {
    msgId: `slack:C1:${id}`,
    traceId: 't',
    source: 'user' as const,
    platform: 'slack' as const,
    channel: 'C1',
    sender: { id: 'U1', isBot: false },
    text: 'please help with my invoice',
    mentionedBots: [] as string[],
    isDm: false,
    ...over
  }
}
const frame = (payload: ReturnType<typeof human>, over: Record<string, unknown> = {}) => ({
  source: 'im' as const,
  agentId: 'bot-a',
  sessionKey: 'C1/C1',
  msgId: payload.msgId,
  botId: BOT,
  integrationId: 'int-bot-a',
  chatId: 'C1',
  payload,
  decisionId: DECISION,
  ...over
})
const routing = (over: Record<string, unknown> = {}) => ({
  trustedRouting: {
    evaluationDaemonId: HOST_ID,
    decisionId: DECISION,
    constraint: [],
    candidates: [
      { agentId: 'bot-a', daemonId: HOST_ID, integrationId: 'int-bot-a' },
      { agentId: REMOTE_AGENT, daemonId: REMOTE_ID, integrationId: 'int-remote' },
      { agentId: 'bot-c', daemonId: HOST_ID, integrationId: 'int-bot-c' }
    ],
    relayId: '55555555-5555-4555-8555-555555555555',
    ...over
  }
})
const admissions = async (store: any, channel: string): Promise<{ text: string; agentId: string }[]> =>
  (await store.db
    .prepare(
      `SELECT t.text AS text, tr.agentId AS agentId FROM transcript_recipient tr JOIN transcript t ON t.seq = tr.seq
        WHERE t.channel = ? AND t.kind = 'text' ORDER BY t.seq, tr.agentId`
    )
    .all(channel)) as { text: string; agentId: string }[]
const textsOf = (blocks: { type: string; text?: string }[]): string[] => blocks.map((b) => b.text ?? '')

const selection = (hostSeq: number): RdRouteSelection => ({
  selectionId: `${hostSeq}:router:${BOT}`,
  hostSeq,
  decisionId: DECISION,
  question: definition.question as RdRouteSelection['question'],
  requestedModel: 'jev-1.13.0',
  actualModel: 'jev-1.13.0',
  result: {
    status: 'answered',
    answer: all.status === 'answered' ? all.answer : (undefined as never),
    matchedRuleIds: ['sales'],
    matchedKeys: ['sales'],
    usedOtherwise: false
  },
  effect: 'selected',
  constrained: false,
  targetAgentIds: ['bot-c'],
  evaluatedMessageId: 'slack:C1:x',
  partial: { partial: false, reasons: [], omittedMessages: 0 },
  hostDaemonId: HOST_ID
})

describe('By decision routing (daemon)', () => {
  it('advertises decision-routing-v1 to the control plane and the relay', async () => {
    const { daemon } = await boot()
    expect((daemon as any).registrationFeatures()).toContain('decision-routing-v1')
    await daemon.stop()
  })

  it('(a) the host reserves, acks, admits its local targets and sends rd/route for the remote one', async () => {
    const { daemon, store, host, relays, evaluate, channel, router } = await boot()
    evaluate.mockResolvedValue(all)
    const payload = human()
    const ack = await (daemon as any).handleRelayIm(frame(payload, routing()))
    expect(ack).toEqual({ msgId: payload.msgId, accepted: true })
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
    await router.idle()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(await admissions(store, channel)).toEqual([
      { text: payload.text, agentId: 'bot-a' },
      { text: payload.text, agentId: 'bot-c' }
    ])
    expect(relays.sendRoute).toHaveBeenCalledTimes(1)
    const [route, prefer] = relays.sendRoute.mock.calls[0]! as unknown as [RdRoute, string]
    expect(route).toMatchObject({
      deliveryId: `${BOT}:${payload.msgId}#${REMOTE_AGENT}`,
      toAgentId: REMOTE_AGENT,
      frozenDaemonId: REMOTE_ID,
      selection: { effect: 'selected', targetAgentIds: ['bot-a', REMOTE_AGENT, 'bot-c'] }
    })
    expect(prefer).toBe('55555555-5555-4555-8555-555555555555')
    expect(relays.sendRouteReport).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: BOT,
        owner: { agentId: 'bot-a', daemonId: HOST_ID },
        participants: [
          { agentId: 'bot-a', daemonId: HOST_ID },
          { agentId: REMOTE_AGENT, daemonId: REMOTE_ID },
          { agentId: 'bot-c', daemonId: HOST_ID }
        ]
      }),
      '55555555-5555-4555-8555-555555555555'
    )
    const inbox = (await store.db.prepare(`SELECT id FROM inbox WHERE id LIKE 'decision-route:%'`).all()) as {
      id: string
    }[]
    expect(inbox.map((r) => r.id.split(':').at(-1)).sort()).toEqual(['bot-a', 'bot-c'])
    const evidence = textsOf(host.prompt.mock.calls[0]![1]).find((b) => b.startsWith('(Decision evidence'))
    expect(evidence).toContain('Routing: selected by rule; matched rules billing, technical, sales; new conversation')
    // A relay retransmit replays the ACK and evaluates nothing.
    expect(await (daemon as any).handleRelayIm(frame(payload, routing()))).toEqual({
      msgId: payload.msgId,
      accepted: true
    })
    await router.idle()
    expect(evaluate).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('(i) holds, never evaluating, when this daemon is not the projected host', async () => {
    for (const [hosted, over] of [
      [false, {}],
      [true, { evaluationDaemonId: REMOTE_ID }]
    ] as const) {
      const { daemon, store, host, evaluate, channel } = await boot({ hosted })
      const payload = human()
      expect(await (daemon as any).handleRelayIm(frame(payload, routing(over)))).toEqual({
        msgId: payload.msgId,
        accepted: false,
        reason: 'not_host'
      })
      expect(await admissions(store, channel)).toEqual([])
      const rows = (await store.db.prepare('SELECT text FROM transcript WHERE channel = ?').all(channel)) as unknown[]
      expect(rows).toHaveLength(1)
      expect(evaluate).not.toHaveBeenCalled()
      expect(host.prompt).not.toHaveBeenCalled()
      await daemon.stop()
    }
  })

  it('(i) a plain relay delivery in a routed conversation is held with no disposition', async () => {
    const { daemon, evaluate, host } = await boot()
    const payload = human()
    expect(await (daemon as any).handleRelayIm(frame(payload))).toMatchObject({ accepted: true })
    expect(evaluate).not.toHaveBeenCalled()
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('skips the duty rendezvous for a host copy', async () => {
    const { daemon, evaluate, router } = await boot()
    evaluate.mockResolvedValue(all)
    ;(daemon as any).dutyCoordinator.dutyEnforced = () => true
    ;(daemon as any).duties.holdsAgent = () => false
    const claim = vi.spyOn((daemon as any).dutyCoordinator, 'claimDutyForTrigger')
    const payload = human()
    expect(await (daemon as any).handleRelayMsg(frame(payload, routing()), () => {})).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1), WAIT)
    expect(claim).not.toHaveBeenCalled()
    await router.idle()
    await daemon.stop()
  })

  it('a routed forward admits its target without evaluating, once, with background and evidence', async () => {
    const { daemon, store, host, evaluate, channel, router } = await boot({ hosted: false })
    const payload = human({ text: 'quote please' })
    const forward = frame(payload, {
      agentId: 'bot-c',
      integrationId: 'int-bot-c',
      msgId: `${payload.msgId}#bot-c`,
      trustedRouteVia: 'implicit',
      trustedRouteSelection: selection(7),
      backfill: [{ ts: '1719999999.000001', thread: null, sender: 'U9', text: 'an earlier remark' }]
    })
    const ack = await (daemon as any).handleRelayIm(forward)
    expect(ack).toEqual({ msgId: forward.msgId, accepted: true, routeAdmission: 'admitted' })
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    expect(evaluate).not.toHaveBeenCalled()
    const blocks = textsOf(host.prompt.mock.calls[0]![1])
    expect(blocks.find((b) => b.startsWith('(Background conversation'))).toContain('an earlier remark')
    expect(blocks.find((b) => b.startsWith('(Decision evidence'))).toContain('Routing: selected by rule')
    // A retry of the same forward reads the durable receipt back as admitted and admits nothing more.
    ;(daemon as any).relayMsgAcks.clear()
    expect(await (daemon as any).handleRelayIm(forward)).toMatchObject({ routeAdmission: 'admitted' })
    await router.idle()
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(0), WAIT)
    expect(host.prompt).toHaveBeenCalledTimes(1)
    expect((await admissions(store, channel)).filter((a) => a.agentId === 'bot-c')).toHaveLength(1)
    await daemon.stop()
  })

  it('a routed forward to a muted target is rejected with reason muted', async () => {
    const { daemon, host } = await boot({ hosted: false })
    const payload = human({ thread: '1720000000.000050' })
    ;(daemon as any).commands.isSessionMuted = async () => true
    const ack = await (daemon as any).handleRelayIm(
      frame(payload, {
        agentId: 'bot-c',
        integrationId: 'int-bot-c',
        msgId: `${payload.msgId}#bot-c`,
        trustedRouteVia: 'implicit',
        trustedRouteSelection: selection(8)
      })
    )
    expect(ack).toEqual({
      msgId: `${payload.msgId}#bot-c`,
      accepted: false,
      routeAdmission: 'rejected',
      reason: 'muted',
      recoverable: false
    })
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('a routed forward is refused where routing is not enabled here', async () => {
    const { daemon } = await boot({ hosted: false })
    const int = (daemon as any).agents.get('bot-c').integrations[0]
    int.core = {
      ...int.core,
      decisions: {
        bindings: [
          { channel: 'C1', consumer: { type: 'shared_bot_routing' }, enabled: false, disabledReason: 'paused' }
        ],
        definitions: []
      }
    }
    const payload = human()
    expect(
      await (daemon as any).handleRelayIm(
        frame(payload, {
          agentId: 'bot-c',
          integrationId: 'int-bot-c',
          msgId: `${payload.msgId}#bot-c`,
          trustedRouteSelection: selection(9)
        })
      )
    ).toMatchObject({ accepted: false, routeAdmission: 'rejected', reason: 'routing_disabled' })
    await daemon.stop()
  })

  it('a recoverable routed refusal is not replayed from the ack cache: the retry of the same frame admits', async () => {
    const { daemon, host } = await boot({ hosted: false })
    const payload = human({ text: 'quote please' })
    const forward = frame(payload, {
      agentId: 'bot-c',
      integrationId: 'int-bot-c',
      msgId: `${payload.msgId}#bot-c`,
      trustedRouteVia: 'implicit',
      trustedRouteSelection: selection(10)
    })
    vi.spyOn(daemon as any, 'admitWithReceipt').mockResolvedValueOnce({
      kind: 'rejected',
      reason: 'queue_full',
      recoverable: false
    })
    expect(await (daemon as any).handleRelayMsg(forward, () => {})).toEqual({
      msgId: forward.msgId,
      accepted: false,
      routeAdmission: 'rejected',
      reason: 'capacity',
      recoverable: true
    })
    expect(await (daemon as any).handleRelayMsg(forward, () => {})).toEqual({
      msgId: forward.msgId,
      accepted: true,
      routeAdmission: 'admitted'
    })
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    // A terminal verdict is cached: a third copy replays it and admits nothing more.
    expect(await (daemon as any).handleRelayMsg(forward, () => {})).toMatchObject({ routeAdmission: 'admitted' })
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(0), WAIT)
    expect(host.prompt).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('a routed forward to a target with no routing binding yet is a recoverable not_ready, not routing_disabled', async () => {
    const { daemon, host } = await boot({ hosted: false })
    const int = (daemon as any).agents.get('bot-c').integrations[0]
    int.core = { ...int.core, decisions: { bindings: [], definitions: [] } }
    const payload = human()
    expect(
      await (daemon as any).handleRelayIm(
        frame(payload, {
          agentId: 'bot-c',
          integrationId: 'int-bot-c',
          msgId: `${payload.msgId}#bot-c`,
          trustedRouteSelection: selection(11)
        })
      )
    ).toEqual({
      msgId: `${payload.msgId}#bot-c`,
      accepted: false,
      routeAdmission: 'rejected',
      reason: 'not_ready',
      recoverable: true
    })
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('reports a duty-held-elsewhere local agent as not served rather than not a member', async () => {
    const { daemon } = await boot()
    expect((daemon as any).localRouterTarget(BOT, 'bot-c', 'C1')).toMatchObject({
      integrationId: 'int-bot-c',
      served: true
    })
    ;(daemon as any).dutyCoordinator.dutyEnforced = () => true
    ;(daemon as any).duties.holdsAgent = () => false
    expect((daemon as any).localRouterTarget(BOT, 'bot-c', 'C1')).toMatchObject({
      integrationId: 'int-bot-c',
      served: false
    })
    expect((daemon as any).localRouterTarget(BOT, REMOTE_AGENT, 'C1')).toBeUndefined()
    await daemon.stop()
  })
})
