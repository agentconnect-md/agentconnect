import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { sessionKey, type InboxRow } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

/**
 * send-message-routing-rework.md §4 / §4.1 / §6 — the DIRECT-daemon ladder for a
 * platform message authored by an AgentConnect agent.
 *
 * The behavior under test is a reversal: an agent-authored Slack message used to be
 * dropped outright, and now routes through the SAME conversation-participant machinery a
 * human message takes: mentions join peers, while affinity and automatic rules keep joined
 * participants receiving later replies without requiring a fresh mention on every line.
 *
 * What remains absolute, and is most of what these tests pin: the author is never the
 * target (self-activation is unconditional, not merely loop-prone), every edge still
 * spends from the shared hop budget and passes call policy and the conversation Off
 * fence, only FINAL events route, agent text can never issue control commands, and any
 * unverifiable claim fails closed.
 */

const TEST_ORG = 'org_test0000000000000000000'
const APP_ID = 'AAGENTCONNECT'

function scaffold(
  agents: { id: string; trigger?: 'auto' | 'mention'; callPolicy?: string; allowedCallerAgentIds?: string[] }[],
  // Give each agent its OWN Slack credential, i.e. genuinely separate apps. The transport
  // scope hashes the live credential, so the shared-token default collapses every agent
  // onto one scope — which hides any bug in which scope a lookup is keyed under.
  distinctTokens = false
): string {
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
        // An `auto` channel rule: every message in C1 routes here, agent-authored included
        // — that rung is exactly what carries an unaddressed agent reply to the next agent.
        integrations: [
          {
            id: `int-${a.id}`,
            platform: 'slack',
            core: { bindRules: [{ match: { kind: a.trigger ?? 'auto' }, channel: 'C1' }] },
            config: {
              botToken: distinctTokens ? `xoxb-${a.id}` : 'xoxb',
              // Socket-mode Slack keys its connection identity on the APP token, so this
              // is what actually separates two dedicated apps into two transport scopes.
              appToken: distinctTokens ? `xapp-${a.id}` : 'xapp'
            }
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
  agents: { id: string; trigger?: 'auto' | 'mention'; callPolicy?: string; allowedCallerAgentIds?: string[] }[],
  over: {
    botUserIds?: Record<string, string>
    botShared?: boolean
    realDispatch?: boolean
    distinctTokens?: boolean
  } = {}
) {
  const daemon = new Daemon({
    root: scaffold(agents, over.distinctTokens),
    hostFactory: () => fakeHost() as any,
    slackAppFactory: fakeSlackAppFactory()
  })
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
  // `realDispatch` keeps the genuine dispatch/persistence path, so a test can observe the
  // durable inbox — which is the only place a delivery-id collision is visible.
  if (over.realDispatch) return { daemon, calls }
  // Mirrors the part of real dispatch these tests depend on: settling the admission
  // barrier AND completing the activation rendezvous from `callMeta.activationKey`. §8.6
  // puts that reconciliation inside dispatch precisely so replay performs it too, which
  // means a stub that skips it would leave every record `pending` and hide the transition
  // under test.
  ;(daemon as any).dispatch = vi.fn(
    async (agentId: string, msg: any, _i?: string, _w?: any, callMeta?: any, opts?: any) => {
      calls.push({ agentId, msg, callMeta })
      if (callMeta?.activationKey) {
        await (daemon as any).store.admitActivation(
          callMeta.activationKey,
          sessionKey(msg.platform, msg.channel, msg.thread ?? msg.msgId, agentId, msg.transportScope)
        )
      }
      opts?.onAdmission?.({ accepted: true })
      return 'acp-1'
    }
  )
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

/**
 * Route as a PEER's connection observes the post, which is how a channel event actually
 * reaches a target: every dedicated Slack app receives it on its own socket, and the
 * rules in scope are that connection's. The author's own connection resolves to the
 * author, who is excluded — so observing there proves only that nobody self-wakes.
 */
const route = async (daemon: Daemon, msg: unknown, on: string[] = ['int-bot-b']) =>
  await (daemon as any).onInboundOutcome(msg, on)

/**
 * The rendezvous key for the paired delivery these tests exercise, derived the way BOTH
 * halves derive it: from the TARGET's own reply-integration scope, never from whichever
 * connection observed the post.
 *
 * That distinction is the point. Ingress sees the echo on some connection (here `bot-a`'s,
 * since both agents share this daemon) while the internal wake only ever knows the
 * target's scope — so keying on the observer would put the two halves on different keys
 * and quietly break the pairing, and would also mint a separate key per bot connection
 * that sees the same channel:ts.
 */
function pairingKey(daemon: Daemon, targetAgentId = 'bot-b'): string {
  const integrationId = (daemon as any).resolveCpAgent(targetAgentId, 'slack')?.integrationId
  const scope = integrationId ? (daemon as any).transportScopeForIntegrationIds([integrationId]) : undefined
  return ['slack', scope ?? '', '1720000000.000200', targetAgentId].join('\u001f')
}

describe('agent-authored platform mentions (send-message-routing-rework.md §6)', () => {
  it('wakes the peer whose connection observed it, with the trusted hop already advanced', async () => {
    // The one positive case. Delivery follows the ordinary ladder on the OBSERVING
    // connection, not a recipient set parsed out of the body — a peer is meant to see what
    // was said and judge for itself. It is still a genuine agent CALL, not anonymous
    // channel traffic: the hop advances and the edge is policy-checked.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }, { id: 'bot-c' }])
    const outcome = await route(daemon, agentMessage({}, { hopCount: 2 }))
    expect(outcome.kind).toBe('dispatched')
    expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
    // §4.1: the delivery depth is the author's turn depth + 1, installed as trusted
    // active-turn metadata so the target's own reply advances the chain by one again.
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 3 })
    // Not stamped as an explicit address: nothing here resolved a mention, and `trigger`
    // is a trusted routing cause downstream (the un-mute rule, the prompt reminder).
    expect(calls[0]!.msg.trigger).toBeUndefined()
    await daemon.stop()
  })

  it('continues implicitly on a PEER connection, and never on the author’s own', async () => {
    // §2.3 after the implicit-wake change. Each dedicated Slack app receives the same
    // channel event on its OWN connection, and rules are scoped to the receiving
    // connection — so the author's copy has only the author in scope (excluded ⇒ nothing)
    // while the peer's copy resolves to the peer. That asymmetry is the whole mechanism:
    // an agent never wakes itself, and every OTHER agent's connection wakes its agent.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    const unaddressed = agentMessage({}, { mentionedAgentIds: [] })

    // The author's own connection: the only candidate is the author, so nothing happens.
    expect((await (daemon as any).onInboundOutcome(unaddressed, ['int-bot-a'])).kind).toBe('rejected')
    expect(calls).toHaveLength(0)

    // bot-b's connection sees the same post and continues the conversation.
    const peerCopy = agentMessage({ msgId: 'slack:C1:1720000000.000201:final' }, { mentionedAgentIds: [] })
    expect((await (daemon as any).onInboundOutcome(peerCopy, ['int-bot-b'])).kind).toBe('dispatched')
    expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
    // Still a genuine agent CALL: the hop advances, so the chain stays budgeted.
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 1 })
    await daemon.stop()
  })

  it('binds the conversation audience, so it can wake an agent already talking in the thread', async () => {
    // The production failure this pins: every agent already in the thread holds a
    // Slack-BOUND session there, and an agent-authored activation carries CallMeta. The
    // session-source gate reads CallMeta as "postless A2A child", which has no
    // conversation audience by design — so the wake was cancelled as a cross-source turn
    // and the exchange died after one round with only a WARN in the log.
    //
    // A postless child must indeed not bind: its coordinates come from the caller's
    // session and the model picks the target. A platform-observed delivery is the
    // opposite — its channel and thread come from the provider event, exactly like a
    // human message in that thread.
    const { daemon } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    // A live connection supplies the workspace id the conversation audience keys on; the
    // realm is what makes the tuple complete enough to bind at all.
    ;(daemon as any).connByIntegration.set('int-bot-b', { workspaceId: () => 'T-TEST' })
    const msg: NormalizedMessage = agentMessage()
    msg.transportScope = (daemon as any).transportScopeForIntegrationIds(['int-bot-b'])

    // The audience this very message resolves to for the target…
    const audience = await (daemon as any).conversationExternalSource('bot-b', msg, false)
    expect(audience).toMatchObject({
      externalProvider: 'slack',
      externalResourceKind: 'conversation',
      externalRealmKey: 'T-TEST',
      externalIntegrationId: 'int-bot-b'
    })

    // …and a session already bound to it, which is what the human's mention created.
    const key = sessionKey('slack', 'C1', '1720000000.000100', 'bot-b', msg.transportScope)
    await (daemon as any).store.upsertSession({
      key,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '1720000000.000100',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await (daemon as any).store.setSessionClassification(key, { sourceBindingKind: 'external', ...audience })

    const platformWake = { callFrom: 'bot-a', platformOrigin: true, hopCount: 1, deliveryId: 'd-1' }
    expect(await (daemon as any).bindSessionSource('bot-b', key, msg, platformWake, undefined)).toBe('unchanged')

    // A postless call with no inherited lineage keeps failing closed against the same row.
    const postlessWake = { callFrom: 'bot-a', hopCount: 1, deliveryId: 'd-2' }
    expect(await (daemon as any).bindSessionSource('bot-b', key, msg, postlessWake, undefined)).toBe('mismatch')
    await daemon.stop()
  })

  it('classifies the NEW session a platform-observed delivery creates as externally bound', async () => {
    // The creation-side half of the same failure: when the target has never spoken in
    // the thread, the wake CREATES its session. Classified as a postless child, that row
    // is 'local' — and then every later externally-attributed wake in the thread, the
    // next HUMAN reply included, rejects as a cross-source mismatch. The agent goes
    // permanently silent in a conversation it visibly joined.
    const { daemon } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    ;(daemon as any).connByIntegration.set('int-bot-b', { workspaceId: () => 'T-TEST' })
    const msg: NormalizedMessage = agentMessage()
    msg.transportScope = (daemon as any).transportScopeForIntegrationIds(['int-bot-b'])
    const seedSession = async (key: string) =>
      await (daemon as any).store.upsertSession({
        key,
        agentId: 'bot-b',
        platform: 'slack',
        channel: 'C1',
        thread: '1720000000.000100',
        acpSessionId: 'acp-1',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })

    const key = sessionKey('slack', 'C1', '1720000000.000100', 'bot-b', msg.transportScope)
    await seedSession(key)
    const platformWake = { callFrom: 'bot-a', platformOrigin: true, hopCount: 1, deliveryId: 'd-1' }
    await (daemon as any).classifyNewSessionOrThrow('bot-b', key, 'acp-1', msg, platformWake, undefined, false)
    expect(await (daemon as any).store.getSession(key)).toMatchObject({
      sourceBindingKind: 'external',
      externalProvider: 'slack',
      externalRealmKey: 'T-TEST',
      externalResourceKind: 'conversation',
      externalResourceKey: 'C1',
      externalIntegrationId: 'int-bot-b'
    })
    // …so the next wake in the thread — this one human-shaped, no CallMeta — reuses the
    // row instead of mismatching.
    expect(await (daemon as any).bindSessionSource('bot-b', key, msg, undefined, undefined)).toBe('unchanged')

    // A postless child still classifies local: its coordinates are model-influenced, so
    // the row it creates must not claim the shared conversation.
    const postlessKey = sessionKey('slack', 'C1', '1720000000.000900', 'bot-b', msg.transportScope)
    await seedSession(postlessKey)
    const postlessWake = { callFrom: 'bot-a', hopCount: 1, deliveryId: 'd-2' }
    await (daemon as any).classifyNewSessionOrThrow('bot-b', postlessKey, 'acp-1', msg, postlessWake, undefined, false)
    expect(await (daemon as any).store.getSession(postlessKey)).toMatchObject({ sourceBindingKind: 'local' })
    await daemon.stop()
  })

  describe('thread fan-out: everyone in the room hears it', () => {
    /** Put `agentId` in the thread, which is what a mention would have done. */
    const join = async (daemon: Daemon, agentId: string) => {
      const scope = (daemon as any).transportScopeForIntegrationIds([`int-${agentId}`])
      await (daemon as any).store.upsertSession({
        key: sessionKey('slack', 'C1', '1720000000.000100', agentId, scope),
        agentId,
        platform: 'slack',
        channel: 'C1',
        thread: '1720000000.000100',
        transportScope: scope,
        acpSessionId: `acp-${agentId}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
    }

    it('delivers to every participant, and carries the hop depth to each', async () => {
      // Participation outlives the message that created it. bot-c joined earlier and is
      // not named here, so only the fan-out can reach it.
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }, { id: 'bot-c' }])
      await join(daemon, 'bot-b')
      await join(daemon, 'bot-c')

      const reply = agentMessage({}, { mentionedAgentIds: [], hopCount: 3 })
      expect((await route(daemon, reply, ['int-bot-b', 'int-bot-c'])).kind).toBe('dispatched')

      expect(new Set(calls.map((c) => c.agentId))).toEqual(new Set(['bot-b', 'bot-c']))
      // Every peer is an EDGE of the same agent call, so each carries the advanced depth.
      // A peer reached only by fan-out would otherwise report depth 0 on its own next
      // reply and the hop cap would never accumulate for it.
      expect(calls.every((c) => c.callMeta?.hopCount === 4)).toBe(true)
      expect(calls.every((c) => c.callMeta?.callFrom === 'bot-a')).toBe(true)
      // Namespaced per peer, so the durable inbox keeps one replayable row each.
      expect(new Set(calls.map((c) => c.callMeta?.deliveryId)).size).toBe(2)
      await daemon.stop()
    })

    it('delivers to joined mention-only participants even when no primary owner exists', async () => {
      // Two open sessions deliberately make `threadOwner` return null. Neither rule is
      // auto and this follow-up names nobody, so the legacy single-target ladder has no
      // result at all; conversation delivery must still reach both joined peers.
      const { daemon, calls } = await boot([
        { id: 'bot-a', trigger: 'mention' },
        { id: 'bot-b', trigger: 'mention' },
        { id: 'bot-c', trigger: 'mention' }
      ])
      await join(daemon, 'bot-b')
      await join(daemon, 'bot-c')

      expect(
        (await route(daemon, agentMessage({}, { mentionedAgentIds: [], hopCount: 2 }), ['int-bot-b', 'int-bot-c'])).kind
      ).toBe('dispatched')
      expect(new Set(calls.map((call) => call.agentId))).toEqual(new Set(['bot-b', 'bot-c']))
      expect(calls.every((call) => call.callMeta?.hopCount === 3 && call.callMeta?.activationKey)).toBe(true)
      await daemon.stop()
    })

    it('derives explicit join and implicit mute handling per human target', async () => {
      const { daemon, calls } = await boot(
        [
          { id: 'bot-b', trigger: 'mention' },
          { id: 'bot-c', trigger: 'mention' }
        ],
        { botUserIds: { 'bot-b': 'UB', 'bot-c': 'UC' }, distinctTokens: true }
      )
      const scope = (daemon as any).transportScopeForIntegrationIds(['int-bot-b', 'int-bot-c'])
      ;(daemon as any).botUserIds['int-bot-b'] = 'UB'
      ;(daemon as any).botUserIds['int-bot-c'] = 'UC'
      for (const agentId of ['bot-b', 'bot-c']) {
        await (daemon as any).store.upsertSession({
          key: sessionKey('slack', 'C1', '1720000000.000100', agentId, scope),
          agentId,
          platform: 'slack',
          channel: 'C1',
          thread: '1720000000.000100',
          transportScope: scope,
          acpSessionId: `acp-${agentId}`,
          state: 'idle',
          lastDeliveredTs: null,
          updatedAt: Date.now()
        })
      }
      const key = (agentId: string) => sessionKey('slack', 'C1', '1720000000.000100', agentId, scope)
      ;(daemon as any).commands.setSessionMuted(key('bot-b'), true)
      ;(daemon as any).commands.setSessionMuted(key('bot-c'), true)

      const human = agentMessage({
        msgId: 'slack:C1:1720000000.000250',
        sender: { id: 'U-HUMAN', isBot: false },
        text: '<@UB> join us',
        mentionedBots: ['UB']
      })
      expect((await route(daemon, human, ['int-bot-b', 'int-bot-c'])).kind).toBe('dispatched')
      expect(calls.map((call) => [call.agentId, call.msg.trigger])).toEqual([['bot-b', 'mention']])
      expect(await (daemon as any).commands.isSessionMuted(key('bot-b'))).toBe(false)
      expect(await (daemon as any).commands.isSessionMuted(key('bot-c'))).toBe(true)
      await daemon.stop()
    })

    it('uses a target-scoped durable inbox id for every human fan-out copy', async () => {
      const { daemon } = await boot(
        [
          { id: 'bot-b', trigger: 'mention' },
          { id: 'bot-c', trigger: 'auto' }
        ],
        { botUserIds: { 'bot-b': 'UB' }, realDispatch: true }
      )
      ;(daemon as any).botUserIds['int-bot-b'] = 'UB'
      const inboxStore = (daemon as any).store as { appendInbox: (row: InboxRow) => Promise<boolean> }
      const appendInbox = vi.spyOn(inboxStore, 'appendInbox')

      const human = agentMessage({
        msgId: 'slack:C1:1720000000.000260',
        sender: { id: 'U-HUMAN', isBot: false },
        text: '<@UB> please coordinate',
        mentionedBots: ['UB']
      })
      expect((await route(daemon, human, ['int-bot-b', 'int-bot-c'])).kind).toBe('dispatched')
      // The durable rows are written while each fan-out copy is admitted, which the async
      // store settles after the routing outcome resolves.
      await vi.waitFor(() => expect(appendInbox).toHaveBeenCalledTimes(2))

      const rows = appendInbox.mock.calls.map(([row]) => row)
      expect(new Set(rows.map((row) => row.agentId))).toEqual(new Set(['bot-b', 'bot-c']))
      expect(new Set(rows.map((row) => row.id)).size).toBe(2)
      expect(rows.find((row) => row.agentId === 'bot-b')?.id).toContain('#bot-b')
      expect(rows.find((row) => row.agentId === 'bot-c')?.id).toContain('#bot-c')
      await daemon.stop()
    })

    it('does not let being in the room bypass call policy', async () => {
      // Already having a session is not consent to be called: bot-c's inbound policy
      // excludes the author, so it hears nothing even though it is in the thread.
      const { daemon, calls } = await boot([
        { id: 'bot-a' },
        { id: 'bot-b' },
        { id: 'bot-c', callPolicy: 'selected', allowedCallerAgentIds: ['somebody-else'] }
      ])
      await join(daemon, 'bot-b')
      await join(daemon, 'bot-c')

      expect((await route(daemon, agentMessage({}, { mentionedAgentIds: [] }), ['int-bot-b', 'int-bot-c'])).kind).toBe(
        'dispatched'
      )
      expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
      await daemon.stop()
    })

    it('keeps a `!stop` participant silent while still recording for catch-up', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }, { id: 'bot-c' }])
      await join(daemon, 'bot-b')
      await join(daemon, 'bot-c')
      const scope = (daemon as any).transportScopeForIntegrationIds(['int-bot-c'])
      ;(daemon as any).commands.setSessionMuted(sessionKey('slack', 'C1', '1720000000.000100', 'bot-c', scope), true)

      await route(daemon, agentMessage({}, { mentionedAgentIds: [] }), ['int-bot-b', 'int-bot-c'])
      expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
      await daemon.stop()
    })
  })

  it('does not let an agent issue control commands', async () => {
    // §6: `!stop` from an agent must not act on a running turn. Command interception sits
    // BELOW the agent branch, so agent text can never reach it.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    const stopped = vi.fn()
    ;(daemon as any).commands.handleCommand = stopped
    // It still DELIVERS — an agent's words are words — but command interception sits
    // below the agent branch, so agent text can never act on a running turn.
    await route(daemon, agentMessage({ text: '!stop' }, { mentionedAgentIds: [] }))
    expect(stopped).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('never selects the author, on any connection', async () => {
    // The one absolute in §2.3, and the only thing the author's own recipient set is still
    // consulted for. Its own connection resolves to itself ⇒ excluded ⇒ nobody; a peer's
    // connection resolves to the peer. Neither can ever name the author.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(daemon, agentMessage(), ['int-bot-a'])).kind).toBe('rejected')
    expect(calls).toHaveLength(0)

    const peerCopy = agentMessage({ msgId: 'slack:C1:1720000000.000209:final' })
    expect((await route(daemon, peerCopy, ['int-bot-b'])).kind).toBe('dispatched')
    expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
    await daemon.stop()
  })

  it('obeys a `!stop` mute', async () => {
    // §2.3. An implicitly selected agent continuation IS implicit routing — the fact that
    // an agent rather than a human produced the message does not exempt it from the mute.
    // Without this `!stop` would silence a conversation's humans while its agents kept
    // waking each other, which is the one case the command now exists for.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    const scope = (daemon as any).transportScopeForIntegrationIds(['int-bot-b'])
    const muteKey = sessionKey('slack', 'C1', '1720000000.000100', 'bot-b', scope)
    ;(daemon as any).commands.setSessionMuted(muteKey, true)

    const unaddressed = agentMessage({}, { mentionedAgentIds: [] })
    expect((await (daemon as any).onInboundOutcome(unaddressed, ['int-bot-b'])).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    expect(await (daemon as any).commands.isSessionMuted(muteKey)).toBe(true)

    // A mention in the body is not an address this layer acts on, so it does not lift the
    // mute either: agent traffic can no longer reopen a conversation a human stopped.
    // Clearing it stays a HUMAN act (`@mention` on the ordinary ladder, or `!resume`).
    const mentioning = agentMessage({ msgId: 'slack:C1:1720000000.000202:final' }, { mentionedAgentIds: ['bot-b'] })
    expect((await (daemon as any).onInboundOutcome(mentioning, ['int-bot-b'])).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    expect(await (daemon as any).commands.isSessionMuted(muteKey)).toBe(true)
    await daemon.stop()
  })

  it('reads the `!stop` mute in the TARGET’s scope, not the observing connection’s', async () => {
    // Every dedicated app sees the same channel post, so the author's connection can be
    // the one that wins the target's activation rendezvous. If it looked the mute up under
    // its OWN scope it would find nothing, dispatch the target, and leave the real
    // tombstone standing — and the target's own copy then deduplicates before it can clear
    // it. The rendezvous key is already target-scoped for the same reason.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }], { distinctTokens: true })
    // An ingress that watches both installs: it can still resolve bot-b, but its own
    // transport scope is NOT bot-b's. That gap is the whole finding — an observer that
    // could not reach the target would prove nothing, since it routes to nobody anyway.
    const observed = ['int-bot-a', 'int-bot-b']
    const targetScope = (daemon as any).transportScopeForIntegrationIds(['int-bot-b'])
    const observerScope = (daemon as any).transportScopeForIntegrationIds(observed)
    expect(observerScope).not.toBe(targetScope)
    ;(daemon as any).commands.setSessionMuted(
      sessionKey('slack', 'C1', '1720000000.000100', 'bot-b', targetScope),
      true
    )

    const unaddressed = agentMessage({}, { mentionedAgentIds: [] })
    expect((await (daemon as any).onInboundOutcome(unaddressed, observed)).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('stamps `trigger` only for an explicit address, never for an implicit continuation', async () => {
    // `trigger === 'mention'` is a trusted routing cause downstream: it drives the prompt
    // reminder that an opaque `<@U…>` token is this agent, and the un-mute rule. Stamping
    // it on an implicitly selected target asserts an address the message does not contain.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    const unaddressed = agentMessage({}, { mentionedAgentIds: [] })
    expect((await (daemon as any).onInboundOutcome(unaddressed, ['int-bot-b'])).kind).toBe('dispatched')
    expect(calls[0]!.msg.trigger).toBeUndefined()
    await daemon.stop()
  })

  it('does not activate a target whose call policy excludes the author', async () => {
    // §10 case 9. The recipient set is the AUTHOR's claim; the target's daemon still
    // decides, against its own snapshot, whether that edge is allowed.
    const { daemon, calls } = await boot([
      { id: 'bot-a' },
      { id: 'bot-b', callPolicy: 'selected', allowedCallerAgentIds: ['somebody-else'] }
    ])
    expect((await route(daemon, agentMessage())).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('does not route a streaming post, only the finalized one', async () => {
    // §10 case 11 / §5.4: an intermediate post may hold a prefix of the answer, so
    // routing it would prompt the peer with a half-written message.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(daemon, agentMessage({}, { deliveryState: 'streaming' }))).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('fails closed on an author the sending app does not back in this conversation', async () => {
    // §4 condition 3. A shared app backs several agents; without the placement check one
    // of them could author messages as any co-tenant.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(daemon, agentMessage({}, { authorAgentId: 'not-an-agent-here' }))).kind).toBe('rejected')
    // A foreign app is not an AgentConnect author at all.
    expect(
      (
        await route(
          daemon,
          agentMessage({ msgId: 'slack:C1:3:final', sender: { id: 'UX', isBot: true, appId: 'AOTHER' } })
        )
      ).kind
    ).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('admits a delivery below the cap, rejects one at the cap, and rejects an unusable depth', async () => {
    // §10 case 15 — the direct-daemon half of the boundary the relay test covers for the
    // relayed half. Both must agree, or a mention chain gets a different budget depending
    // on which transport carried it. Expressed against MAX_AGENT_CALL_HOPS rather than a
    // literal so retuning the budget cannot leave one transport pinned to the old number.
    const admitted = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(admitted.daemon, agentMessage({}, { hopCount: MAX_AGENT_CALL_HOPS - 2 }))).kind).toBe(
      'dispatched'
    )
    expect(admitted.calls[0]!.callMeta).toMatchObject({ hopCount: MAX_AGENT_CALL_HOPS - 1 })
    await admitted.daemon.stop()

    const capped = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(capped.daemon, agentMessage({}, { hopCount: MAX_AGENT_CALL_HOPS - 1 }))).kind).toBe('rejected')
    expect(capped.calls).toHaveLength(0)
    await capped.daemon.stop()

    // §4.1 rule 1: unusable ⇒ transcript-only, NEVER reset to 0 — a reset would hand a
    // runaway chain a fresh budget on every hop.
    for (const hopCount of [-1, 1.5, undefined]) {
      const bad = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      expect((await route(bad.daemon, agentMessage({}, { hopCount }))).kind).toBe('rejected')
      expect(bad.calls).toHaveLength(0)
      await bad.daemon.stop()
    }
  })

  it('admits one logical delivery exactly once across a redelivered final event', async () => {
    // §8.6: the activation rendezvous is what makes exactly-once survive a redelivered
    // platform event, a second bot connection seeing the same channel, and a restart.
    // Distinct msgIds here so per-connection dedup cannot be what stops the second one.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(daemon, agentMessage())).kind).toBe('dispatched')
    expect((await route(daemon, agentMessage({ msgId: 'slack:C1:1720000000.000200:final-retry' }))).kind).toBe(
      'rejected'
    )
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })

  it('does not wake a recipient in a channel the operator switched Off', async () => {
    // product-conventions "Per-channel trigger": Off means no response there at all,
    // explicitly including an @-mention. This ladder bypasses `routeRules`, where the
    // human path gets that fence, so it has to apply it itself — otherwise an agent
    // mention becomes the one way into a silenced channel.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    // `mergedRules` recomputes per call, so the mute is injected at that source rather
    // than mutated onto a snapshot the daemon will discard.
    const original = (daemon as any).mergedRules.bind(daemon)
    ;(daemon as any).mergedRules = () =>
      original().map((rule: any) => (rule.agentId === 'bot-b' ? { ...rule, mutedChannels: ['C1'] } : rule))
    expect((await route(daemon, agentMessage())).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('completes the rendezvous from the turn itself, so a replayed turn is never re-delivered', async () => {
    // §8.6, the crash chain a sweep-based fix cannot close: crash after the inbox row
    // lands → restart replays the turn → the turn COMPLETES and its inbox row is removed →
    // the activation TTL expires → an inbox-existence check now says "never persisted" and
    // releases the claim → a retry delivers the same thing a second time.
    //
    // The key rides on the persisted CallMeta, so the REPLAYED dispatch completes the
    // record itself. By the time any sweep runs the record is already terminal, and the
    // inbox row's fate stops mattering.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(daemon, agentMessage())).kind).toBe('dispatched')
    const callMeta = calls[0]!.callMeta
    expect(callMeta.activationKey).toBeTruthy()

    const store = (daemon as any).store
    expect((await store.getActivation(callMeta.activationKey))?.state).toBe('admitted')

    // Simulate the rest of the chain: the turn finishes and its inbox row is gone, then
    // the TTL passes. A terminal record is not a sweep candidate, so nothing is released…
    await store.expireActivations(Date.now() + 60 * 60 * 1000)
    expect((await store.getActivation(callMeta.activationKey))?.state).toBe('admitted')

    // …and a redelivery of the same logical event still finds the key taken.
    calls.length = 0
    expect((await route(daemon, agentMessage({ msgId: 'slack:C1:1720000000.000200:final-again' }))).kind).toBe(
      'rejected'
    )
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('holds the visible half of a paired agent call for its internal wake', async () => {
    // §3.2: a post carrying an `agent_call_delivery_id` is one half of a paired delivery.
    // Its trusted envelope — lineage, correlation, needsReply, privacy — travels on the
    // internal wake, so dispatching from the platform observation alone would fabricate a
    // lineage-less child. It waits instead.
    const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
    expect((await route(daemon, agentMessage({}, { agentCallDeliveryId: 'd-1' }))).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
    // The observation IS recorded, pending its other half — keyed by the visible post's ts
    // and the TARGET's own scope, which is exactly what the internal wake computes.
    expect(await (daemon as any).store.getActivation(pairingKey(daemon))).toMatchObject({
      state: 'pending',
      agentCallDeliveryId: 'd-1',
      platformMessageId: '1720000000.000200'
    })
    await daemon.stop()
  })

  // §4 / §4.1 step 4 / §6 — the RELAY-forwarded half of the same ladder. This path never
  // reaches `onInboundOutcome`, so without its own branch the entire relayed mention flow
  // dead-ends: the relay verifies, caps, and forwards a trusted envelope, and the daemon
  // acks it and wakes nobody.
  describe('relay-forwarded agent mentions (rd/msg im)', () => {
    const imFrame = (over: Record<string, unknown> = {}) => ({
      source: 'im' as const,
      agentId: 'bot-b',
      sessionKey: 'C1/1720000000.000100',
      msgId: 'slack:C1:1720000000.000200:final#bot-b',
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-bot-b',
      chatId: 'C1',
      payload: agentMessage(),
      trustedFromAgentId: 'bot-a',
      trustedResponseId: 'r-1',
      trustedRecipientAgentIds: ['bot-b'],
      trustedDeliveryHopCount: 3,
      ...over
    })

    it('activates the pre-addressed target and INSTALLS the relay depth without re-incrementing', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      const ack = await (daemon as any).handleRelayIm(imFrame())
      expect(ack.accepted).toBe(true)
      expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
      // §4.1 step 4: the relay already spent the one `+1`. Adding another here would halve
      // the effective hop budget for every relayed chain.
      expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 3 })
      await daemon.stop()
    })

    it('fails closed without a minted claim, so an older relay keeps the old behavior', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      const bare = imFrame()
      delete (bare as Record<string, unknown>).trustedFromAgentId
      delete (bare as Record<string, unknown>).trustedDeliveryHopCount
      expect((await (daemon as any).handleRelayIm(bare)).accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })

    it('refuses a target the relay did not name, a self-mention, and an out-of-range depth', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      // The relay fans one frame per recipient; a target absent from its own minted list
      // means the frame and the claim disagree, which is never something to act on.
      expect(
        (await (daemon as any).handleRelayIm(imFrame({ trustedRecipientAgentIds: ['someone-else'] }))).accepted
      ).toBe(true)
      expect((await (daemon as any).handleRelayIm(imFrame({ trustedFromAgentId: 'bot-b' }))).accepted).toBe(true)
      // Already-incremented depth at the cap, and a depth below 1 (which would mean the
      // relay never applied its transition).
      expect(
        (await (daemon as any).handleRelayIm(imFrame({ trustedDeliveryHopCount: MAX_AGENT_CALL_HOPS }))).accepted
      ).toBe(true)
      expect((await (daemon as any).handleRelayIm(imFrame({ trustedDeliveryHopCount: 0 }))).accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })

    it('obeys a `!stop` mute for a relay-forwarded implicit continuation, not for a mention', async () => {
      // The relay is the only party that knows which rung it used — this frame is
      // pre-addressed to one agent either way — so it says so, and the target applies its
      // `!stop` gate accordingly. `handleRelayIm`'s own mute gate sits BELOW the branch
      // this path returns from, so without the check here a muted conversation would
      // silence its humans and none of its agents.
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      const scope = (daemon as any).transportScopeForIntegrationIds(['int-bot-b'])
      const muteKey = sessionKey('slack', 'C1', '1720000000.000100', 'bot-b', scope)
      ;(daemon as any).commands.setSessionMuted(muteKey, true)

      expect((await (daemon as any).handleRelayIm(imFrame({ trustedRouteVia: 'implicit' }))).accepted).toBe(true)
      expect(calls).toHaveLength(0)
      expect(await (daemon as any).commands.isSessionMuted(muteKey)).toBe(true)

      // An explicit mention wakes it and lifts the mute, as a human's would.
      expect((await (daemon as any).handleRelayIm(imFrame({ trustedRouteVia: 'mention' }))).accepted).toBe(true)
      expect(calls.map((c) => c.agentId)).toEqual(['bot-b'])
      expect(await (daemon as any).commands.isSessionMuted(muteKey)).toBe(false)
      await daemon.stop()
    })

    it('reads an absent `trustedRouteVia` as an explicit mention', async () => {
      // A relay old enough to omit the field only ever forwarded explicit mentions, so
      // that is the reading which preserves its behavior rather than silently demoting
      // every one of its deliveries to mute-able implicit traffic.
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      expect((await (daemon as any).handleRelayIm(imFrame())).accepted).toBe(true)
      expect(calls[0]!.msg.trigger).toBe('mention')
      await daemon.stop()
    })

    it('re-checks call policy against its OWN snapshot, not the relay’s', async () => {
      // Defense in depth: the relay's snapshot may be stale, and it is not the only thing
      // standing between a revoked policy and an activation.
      const { daemon, calls } = await boot([
        { id: 'bot-a' },
        { id: 'bot-b', callPolicy: 'selected', allowedCallerAgentIds: ['somebody-else'] }
      ])
      expect((await (daemon as any).handleRelayIm(imFrame())).accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })

    it('holds a paired relay delivery for its internal wake', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      const ack = await (daemon as any).handleRelayIm(imFrame({ trustedAgentCallDeliveryId: 'd-1' }))
      expect(ack.accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })

    it('relay platform event first: a paired self observation survives until its internal wake', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }])
      const ack = await (daemon as any).handleRelayIm(
        imFrame({
          agentId: 'bot-a',
          integrationId: 'int-bot-a',
          msgId: 'slack:C1:1720000000.000200:final#bot-a',
          trustedFromAgentId: 'bot-a',
          trustedRecipientAgentIds: ['bot-a'],
          trustedAgentCallDeliveryId: 'd-self-relay',
          payload: agentMessage({}, { mentionedAgentIds: ['bot-a'], agentCallDeliveryId: 'd-self-relay' })
        })
      )
      expect(ack.accepted).toBe(true)
      expect(calls).toHaveLength(0)
      expect(await (daemon as any).store.getActivation(pairingKey(daemon, 'bot-a'))).toMatchObject({
        state: 'pending',
        agentCallDeliveryId: 'd-self-relay'
      })

      const res = await (daemon as any).collab.messageAgent({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerChannel: 'C1',
        callerThread: '1720000000.000100',
        toAgentId: 'bot-a',
        text: 'continue here',
        channel: 'C1',
        thread: '1720000000.000200',
        transcriptTs: '1720000000.000200',
        agentCallDeliveryId: 'd-self-relay'
      })
      expect(res.delivered).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ agentId: 'bot-a', callMeta: { callFrom: 'bot-a' } })
      expect(await (daemon as any).store.getActivation(pairingKey(daemon, 'bot-a'))).toMatchObject({
        state: 'admitted',
        childSessionId: res.targetSession
      })
      await daemon.stop()
    })
  })

  // §10 case 4 — the two halves of a paired `toAgent + channel` delivery may arrive in
  // either order, over different transports, separated by a restart. Both orders must
  // admit ONE child, built from the internal wake's complete envelope.
  describe('activation rendezvous, both arrival orders (§3.2)', () => {
    const wake = (daemon: Daemon, over: Record<string, unknown> = {}) =>
      (daemon as any).collab.messageAgent({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerChannel: 'C1',
        callerThread: '1720000000.000100',
        toAgentId: 'bot-b',
        text: 'please verify',
        channel: 'C1',
        thread: '1720000000.000200',
        transcriptTs: '1720000000.000200',
        ...over
      }) as Promise<{ delivered: boolean; targetSession: string }>

    it('internal wake first: the later platform echo does not open a second child', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      const res = await wake(daemon)
      expect(res.delivered).toBe(true)
      expect(calls).toHaveLength(1)

      // The visible echo of the SAME post now arrives through platform ingress.
      expect((await route(daemon, agentMessage({}, { agentCallDeliveryId: 'd-1' }))).kind).toBe('rejected')
      expect(calls).toHaveLength(1)
      expect(await (daemon as any).store.getActivation(pairingKey(daemon))).toMatchObject({
        state: 'admitted',
        childSessionId: res.targetSession
      })
      await daemon.stop()
    })

    it('platform event first: the later wake admits once, with full lineage intact', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      // The echo beats the wake. Nothing dispatches: the observation carries none of the
      // trusted envelope, so admitting on it would fabricate the call it accompanies.
      expect((await route(daemon, agentMessage({}, { agentCallDeliveryId: 'd-1' }))).kind).toBe('rejected')
      expect(calls).toHaveLength(0)
      expect((await (daemon as any).store.getActivation(pairingKey(daemon)))?.state).toBe('pending')

      // Seed the caller's origin so `needsReply` has a parent session to report into —
      // the lineage that would be LOST if the platform half had been allowed to dispatch.
      await (daemon as any).store.upsertSession({
        key: 'slack:C1:1720000000.000100:bot-a',
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread: '1720000000.000100',
        acpSessionId: 'acp-parent-1',
        // Lineage travels by the OUTWARD id (session-concept.md §1.1), so seed one that differs.
        sessionId: 'sid-parent-1',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      const res = await wake(daemon, { needsReply: true })
      expect(res.delivered).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.callMeta).toMatchObject({
        callFrom: 'bot-a',
        originSessionId: 'sid-parent-1',
        needsReply: true
      })
      expect(await (daemon as any).store.getActivation(pairingKey(daemon))).toMatchObject({
        state: 'admitted',
        // The visible observation survives the transition, so the two collapse onto one
        // transcript row instead of duplicating the hand-off.
        platformMessageId: '1720000000.000200'
      })
      await daemon.stop()
    })

    it('direct platform event first: a paired self observation survives until its internal wake', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }])
      const visible = agentMessage(
        {},
        {
          authorAgentId: 'bot-a',
          mentionedAgentIds: ['bot-a'],
          agentCallDeliveryId: 'd-self-direct'
        }
      )

      expect((await route(daemon, visible, ['int-bot-a'])).kind).toBe('rejected')
      expect(calls).toHaveLength(0)
      expect(await (daemon as any).store.getActivation(pairingKey(daemon, 'bot-a'))).toMatchObject({
        state: 'pending',
        agentCallDeliveryId: 'd-self-direct'
      })

      const res = await wake(daemon, {
        toAgentId: 'bot-a',
        agentCallDeliveryId: 'd-self-direct'
      })
      expect(res.delivered).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ agentId: 'bot-a', callMeta: { callFrom: 'bot-a' } })
      expect(await (daemon as any).store.getActivation(pairingKey(daemon, 'bot-a'))).toMatchObject({
        state: 'admitted',
        childSessionId: res.targetSession
      })
      await daemon.stop()
    })

    it('a retried wake reuses the admitted child instead of opening another', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      const first = await wake(daemon)
      const retry = await wake(daemon, { text: 'please verify (retry)' })
      expect(retry.delivered).toBe(true)
      expect(retry.targetSession).toBe(first.targetSession)
      expect(calls).toHaveLength(1)
      await daemon.stop()
    })
  })
})
