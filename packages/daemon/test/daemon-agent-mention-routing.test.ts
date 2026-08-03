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
  // Mirrors real dispatch closely enough for the rendezvous: it settles the ADMISSION
  // barrier. §8.6 keys the activation record off that barrier rather than off the call,
  // so a stub that never fires it would leave every record `pending` and hide the
  // transition under test.
  ;(daemon as any).dispatch = vi.fn(
    async (agentId: string, msg: any, _i?: string, _w?: any, callMeta?: any, opts?: any) => {
      calls.push({ agentId, msg, callMeta })
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

const route = (daemon: Daemon, msg: unknown) => (daemon as any).onInboundOutcome(msg, ['int-bot-a'])

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
  return ['slack', scope ?? '', '1720000000.000200', targetAgentId].join('\u0000')
}

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
    // and the TARGET's own scope, which is exactly what the internal wake computes.
    expect((daemon as any).store.getActivation(pairingKey(daemon))).toMatchObject({
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
      const ack = (daemon as any).handleRelayIm(imFrame())
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
      expect((daemon as any).handleRelayIm(bare).accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })

    it('refuses a target the relay did not name, a self-mention, and an out-of-range depth', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      // The relay fans one frame per recipient; a target absent from its own minted list
      // means the frame and the claim disagree, which is never something to act on.
      expect((daemon as any).handleRelayIm(imFrame({ trustedRecipientAgentIds: ['someone-else'] })).accepted).toBe(true)
      expect((daemon as any).handleRelayIm(imFrame({ trustedFromAgentId: 'bot-b' })).accepted).toBe(true)
      // Already-incremented depth past the cap, and a depth below 1 (which would mean the
      // relay never applied its transition).
      expect((daemon as any).handleRelayIm(imFrame({ trustedDeliveryHopCount: 9 })).accepted).toBe(true)
      expect((daemon as any).handleRelayIm(imFrame({ trustedDeliveryHopCount: 0 })).accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })

    it('re-checks call policy against its OWN snapshot, not the relay’s', async () => {
      // Defense in depth: the relay's snapshot may be stale, and it is not the only thing
      // standing between a revoked policy and an activation.
      const { daemon, calls } = await boot([
        { id: 'bot-a' },
        { id: 'bot-b', callPolicy: 'selected', allowedCallerAgentIds: ['somebody-else'] }
      ])
      expect((daemon as any).handleRelayIm(imFrame()).accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })

    it('holds a paired relay delivery for its internal wake', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      const ack = (daemon as any).handleRelayIm(imFrame({ trustedAgentCallDeliveryId: 'd-1' }))
      expect(ack.accepted).toBe(true)
      expect(calls).toHaveLength(0)
      await daemon.stop()
    })
  })

  // §10 case 4 — the two halves of a paired `toAgent + channel` delivery may arrive in
  // either order, over different transports, separated by a restart. Both orders must
  // admit ONE child, built from the internal wake's complete envelope.
  describe('activation rendezvous, both arrival orders (§3.2)', () => {
    const wake = (daemon: Daemon, over: Record<string, unknown> = {}) =>
      (daemon as any).messageAgent({
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
      expect(route(daemon, agentMessage({}, { agentCallDeliveryId: 'd-1' })).kind).toBe('rejected')
      expect(calls).toHaveLength(1)
      expect((daemon as any).store.getActivation(pairingKey(daemon))).toMatchObject({
        state: 'admitted',
        childSessionId: res.targetSession
      })
      await daemon.stop()
    })

    it('platform event first: the later wake admits once, with full lineage intact', async () => {
      const { daemon, calls } = await boot([{ id: 'bot-a' }, { id: 'bot-b' }])
      // The echo beats the wake. Nothing dispatches: the observation carries none of the
      // trusted envelope, so admitting on it would fabricate the call it accompanies.
      expect(route(daemon, agentMessage({}, { agentCallDeliveryId: 'd-1' })).kind).toBe('rejected')
      expect(calls).toHaveLength(0)
      expect((daemon as any).store.getActivation(pairingKey(daemon))?.state).toBe('pending')

      // Seed the caller's origin so `needsReply` has a parent session to report into —
      // the lineage that would be LOST if the platform half had been allowed to dispatch.
      ;(daemon as any).store.upsertSession({
        key: 'slack:C1:1720000000.000100:bot-a',
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread: '1720000000.000100',
        acpSessionId: 'acp-parent-1',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      const res = await wake(daemon, { needsReply: true })
      expect(res.delivered).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.callMeta).toMatchObject({
        callFrom: 'bot-a',
        originSessionId: 'acp-parent-1',
        needsReply: true
      })
      expect((daemon as any).store.getActivation(pairingKey(daemon))).toMatchObject({
        state: 'admitted',
        // The visible observation survives the transition, so the two collapse onto one
        // transcript row instead of duplicating the hand-off.
        platformMessageId: '1720000000.000200'
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
