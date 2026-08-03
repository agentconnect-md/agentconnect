import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'

/**
 * send-message-routing-rework.md §4 / §4.1 / §6 — the DIRECT-daemon ladder for a
 * platform message authored by an AgentConnect agent.
 *
 * The behavior under test is a reversal: an agent-authored Slack message used to be
 * dropped outright, and is now routable — but only through its own ladder. These tests
 * are mostly about what still must NOT happen. Activation may come only from an explicit,
 * verified recipient; every implicit rung a human message could take (thread affinity,
 * DM, keyword, channel `auto`, default-agent fallback) must stay unreachable, and every
 * unverifiable claim must fail closed.
 */

const TEST_ORG = 'org_test0000000000000000000'
const APP_ID = 'AAGENTCONNECT'

function scaffold(agents: { id: string; callPolicy?: string; allowedCallerAgentIds?: string[] }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-agent-mention-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const a of agents) {
    const adir = join(root, 'agents', a.id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: a.id,
        name: a.id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        // An `auto` channel rule: every HUMAN message in C1 routes here. Agent-authored
        // traffic must never reach it — that is the sharpest form of "no implicit rung".
        integrations: [
          {
            id: `int-${a.id}`,
            platform: 'slack',
            slack: { botToken: 'xoxb', appToken: 'xapp', bindRules: [{ match: { kind: 'auto' }, channel: 'C1' }] }
          }
        ],
        output: { mode: 'low' },
        ...(a.callPolicy ? { callPolicy: a.callPolicy } : {}),
        ...(a.allowedCallerAgentIds ? { allowedCallerAgentIds: a.allowedCallerAgentIds } : {})
      })
    )
  }
  return root
}

const fakeHost = () => ({
  __started: true,
  start: vi.fn(async () => {}),
  newSession: vi.fn(async () => 'acp-1'),
  prompt: vi.fn(async () => 'end_turn'),
  cancel: vi.fn(),
  stop: vi.fn()
})

/** Boot with a dispatch spy and a collaboration snapshot placing every agent in C1
 *  behind ONE AgentConnect Slack app, each with its own bot user id. */
async function boot(
  agents: { id: string; callPolicy?: string; allowedCallerAgentIds?: string[] }[],
  over: { botUserIds?: Record<string, string>; botShared?: boolean } = {}
) {
  const daemon = new Daemon({ root: scaffold(agents), hostFactory: () => fakeHost() as any })
  await daemon.start()
  const placements = agents.map((a) => ({
    agentId: a.id,
    daemonId: 'local-daemon',
    integrationId: `int-${a.id}`,
    name: a.id,
    botAppId: APP_ID,
    ...(over.botUserIds?.[a.id] ? { botUserId: over.botUserIds[a.id] } : {}),
    ...(over.botShared ? { botShared: true } : {}),
    callPolicy: (a.callPolicy ?? 'all') as 'all' | 'selected',
    allowedCallerAgentIds: a.allowedCallerAgentIds ?? [],
    outboundPolicy: 'all' as const,
    allowedTargetAgentIds: []
  }))
  ;(daemon as any).cpCollab.replace({
    generation: 1,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: placements }],
    agents: placements.map((p) => ({ ...p, orgId: TEST_ORG }))
  })
  const calls: { agentId: string; msg: any; callMeta?: any }[] = []
  ;(daemon as any).dispatch = vi.fn(async (agentId: string, msg: any, _i?: string, _w?: any, callMeta?: any) => {
    calls.push({ agentId, msg, callMeta })
    return 'acp-1'
  })
  return { daemon, calls }
}

/** One finalized agent-authored Slack message, as ingress sees it after normalization. */
const agentMessage = (over: Record<string, unknown> = {}, claim: Record<string, unknown> = {}) => ({
  msgId: 'slack:C1:1720000000.000200:final',
  traceId: 't',
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: '1720000000.000100',
  sender: { id: 'UBOT', isBot: true, appId: APP_ID },
  text: 'please verify the rollout',
  mentionedBots: [] as string[],
  isDm: false,
  agentAuthorship: {
    authorAgentId: 'bot-a',
    responseId: 'r-1',
    deliveryState: 'final' as const,
    hopCount: 0,
    mentionedAgentIds: ['bot-b'],
    ...claim
  },
  ...over
})

const route = (daemon: Daemon, msg: unknown) => (daemon as any).onInboundOutcome(msg, ['int-bot-a'])

describe('agent-authored platform mentions (send-message-routing-rework.md §6)', () => {
  it('activates exactly the mentioned agent, with the trusted hop already advanced', async () => {
    // §10 case 7. The one positive case: a finalized agent reply naming a peer wakes that
    // peer — and only it — as a genuine agent CALL, not as anonymous channel traffic.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }, { id: 'bot-c' }])
    const outcome = route(daemon, agentMessage({}, { hopCount: 2 }))
    expect(outcome.kind).toBe('dispatched')
    expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
    // §4.1: the delivery depth is the author's turn depth + 1, installed as trusted
    // active-turn metadata so the target's own reply advances the chain by one again.
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 3 })
    // Explicit address ⇒ the same trigger a human @mention produces, so it clears a
    // `!stop` mute exactly as one would.
    expect(calls[0]!.msg.trigger).toBe('mention')
    await daemon.stop()
  })

  it('never activates implicitly, even in an `auto` channel', async () => {
    // §10 case 8 / §2.3. C1 has an `auto` rule: EVERY human message routes there. An
    // agent message with no verified recipient must still activate nobody — this is the
    // test that would catch the ladder being wired as a rung of the human one.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(daemon, agentMessage({}, { mentionedAgentIds: [] })).kind).toBe('rejected')
    // …and a DM from an agent is no different: a DM rung is still an implicit rung.
    expect(route(daemon, agentMessage({ msgId: 'slack:C1:2:final', isDm: true }, { mentionedAgentIds: [] })).kind).toBe(
      'rejected'
    )
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('does not let an agent issue control commands', async () => {
    // §6: `!stop` from an agent must not act on a running turn. Command interception sits
    // BELOW the agent branch, so agent text can never reach it.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    const stopped = vi.fn()
    ;(daemon as any).handleCommand = stopped
    route(daemon, agentMessage({ text: '!stop' }, { mentionedAgentIds: [] }))
    expect(stopped).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('does not let an author activate itself', async () => {
    // §10 case 9 / §2.3.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(daemon, agentMessage({}, { mentionedAgentIds: ['bot-a'] })).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('does not activate a target whose call policy excludes the author', async () => {
    // §10 case 9. The recipient set is the AUTHOR's claim; the target's daemon still
    // decides, against its own snapshot, whether that edge is allowed.
    const { daemon, calls } = await boot([
      { id: 'bot-a' },
      { id: 'bot-b', callPolicy: 'selected', allowedCallerAgentIds: ['somebody-else'] }
    ])
    expect(route(daemon, agentMessage()).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('does not route a streaming post, only the finalized one', async () => {
    // §10 case 11 / §5.4: an intermediate post may hold a prefix of the answer, so
    // routing it would prompt the peer with a half-written message.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(daemon, agentMessage({}, { deliveryState: 'streaming' })).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('fails closed on an author the sending app does not back in this conversation', async () => {
    // §4 condition 3. A shared app backs several agents; without the placement check one
    // of them could author messages as any co-tenant.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(daemon, agentMessage({}, { authorAgentId: 'not-an-agent-here' })).kind).toBe('rejected')
    // A foreign app is not an AgentConnect author at all.
    expect(
      route(daemon, agentMessage({ msgId: 'slack:C1:3:final', sender: { id: 'UX', isBot: true, appId: 'AOTHER' } }))
        .kind
    ).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('admits source depth 7 as 8, rejects 8, and rejects an unusable depth', async () => {
    // §10 case 15 — the direct-daemon half of the boundary the relay test covers for the
    // relayed half. Both must agree, or a mention chain gets a different budget depending
    // on which transport carried it.
    const admitted = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(admitted.daemon, agentMessage({}, { hopCount: 7 })).kind).toBe('dispatched')
    expect(admitted.calls[0]!.callMeta).toMatchObject({ hopCount: 8 })
    await admitted.daemon.stop()

    const capped = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(capped.daemon, agentMessage({}, { hopCount: 8 })).kind).toBe('rejected')
    expect(capped.calls).toHaveLength(0)
    await capped.daemon.stop()

    // §4.1 rule 1: unusable ⇒ transcript-only, NEVER reset to 0 — a reset would hand a
    // runaway chain a fresh budget on every hop.
    for (const hopCount of [-1, 1.5, undefined]) {
      const bad = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      expect(route(bad.daemon, agentMessage({}, { hopCount })).kind).toBe('rejected')
      expect(bad.calls).toHaveLength(0)
      await bad.daemon.stop()
    }
  })

  it('admits one logical delivery exactly once across a redelivered final event', async () => {
    // §8.6: the activation rendezvous is what makes exactly-once survive a redelivered
    // platform event, a second bot connection seeing the same channel, and a restart.
    // Distinct msgIds here so per-connection dedup cannot be what stops the second one.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(daemon, agentMessage()).kind).toBe('dispatched')
    expect(route(daemon, agentMessage({ msgId: 'slack:C1:1720000000.000200:final-retry' })).kind).toBe('rejected')
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })

  it('holds the visible half of a paired agent call for its internal wake', async () => {
    // §3.2: a post carrying an `agent_call_delivery_id` is one half of a paired delivery.
    // Its trusted envelope — lineage, correlation, needsReply, privacy — travels on the
    // internal wake, so dispatching from the platform observation alone would fabricate a
    // lineage-less child. It waits instead.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect(route(daemon, agentMessage({}, { agentCallDeliveryId: 'd-1' })).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    // The observation IS recorded, pending its other half — keyed by the visible post's ts
    // and the target, which is exactly what the internal wake will independently compute.
    const scope = (daemon as any).transportScopeForIntegrationIds(['int-bot-a']) ?? ''
    const key = ['slack', scope, '1720000000.000200', 'bot-b'].join('\u0000')
    expect((daemon as any).store.getActivation(key)).toMatchObject({
      state: 'pending',
      agentCallDeliveryId: 'd-1',
      platformMessageId: '1720000000.000200'
    })
    await daemon.stop()
  })
})
