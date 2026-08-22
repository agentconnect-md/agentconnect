import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'
import { AGENTMSG_NOT_READY_RETRY } from '../src/cp/agentmsg-retry.js'
import { executeTool, type MessageAgentReq } from '../src/mcp/ops.js'
import { sessionKey } from '../src/store/local-store.js'
import * as monotonic from '../src/store/monotonic-ts.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
/** Peers this suite wakes that are NOT on the daemon under test — they must still be in
 *  the org directory, exactly as a real CP snapshot would list them. */
const REMOTE_PEERS = ['bot-a', 'bot-b', 'bot-c', 'main', 'worker', 'third', 'peer', 'joiner', 'elsewhere']

/**
 * Same-daemon `messageAgent` delivery (design P1). These drive the daemon's internal
 * method directly and stub `dispatch` so we assert the public thread event, targeted
 * wake, coords, and trusted workflow metadata without running a real ACP turn.
 */

/** Scaffold a daemon root with local agents carrying either direction of call policy. */
function scaffold(
  agents: {
    id: string
    callPolicy?: 'all' | 'selected'
    allowedCallerAgentIds?: string[]
    outboundPolicy?: 'all' | 'selected'
    allowedTargetAgentIds?: string[]
  }[]
): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-msgagent-'))
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
        integrations: [],
        output: { mode: 'low' },
        ...(a.callPolicy ? { callPolicy: a.callPolicy } : {}),
        ...(a.allowedCallerAgentIds ? { allowedCallerAgentIds: a.allowedCallerAgentIds } : {}),
        ...(a.outboundPolicy ? { outboundPolicy: a.outboundPolicy } : {}),
        ...(a.allowedTargetAgentIds ? { allowedTargetAgentIds: a.allowedTargetAgentIds } : {})
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

/** Boot a daemon and replace `dispatch` with a spy that records its args. */
async function bootWithDispatchSpy(root: string) {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost() as any })
  await daemon.start()
  // Same-daemon authorization consumes the same CP collaboration snapshot as
  // relay terminal verification. Seed the default test channel with every local
  // agent; individual membership tests replace this with narrower channels.
  const localAgents = [...(daemon as any).agents.values()].map((agent: any) => ({
    agentId: agent.id,
    daemonId: 'local-daemon',
    name: agent.name,
    displayName: agent.displayName,
    callPolicy: agent.callPolicy,
    allowedCallerAgentIds: agent.allowedCallerAgentIds,
    outboundPolicy: agent.outboundPolicy,
    allowedTargetAgentIds: agent.allowedTargetAgentIds
  }))
  // A2A authorization now reads the FLAT org directory (channel membership is only a
  // discovery filter), so every peer this suite addresses — including the ones that live on
  // ANOTHER daemon — must appear there or the wake fails closed before it can be routed.
  const orgAgents = [...localAgents, ...REMOTE_PEERS.map((agentId) => ({ agentId, daemonId: 'other-daemon' }))]
    .map((agent: any) => ({
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      ...agent,
      orgId: TEST_ORG
    }))
    // Local placements come first, so a local agent's real policy wins over its remote stub.
    .filter((agent: any, i: number, all: any[]) => all.findIndex((other) => other.agentId === agent.agentId) === i)
  ;(daemon as any).cpCollab.replace({
    generation: 0,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: localAgents }],
    agents: orgAgents
  })
  const calls: { agentId: string; msg: any; integrationId?: string; callMeta?: any; webchat?: any }[] = []
  ;(daemon as any).dispatch = vi.fn(
    async (agentId: string, msg: any, integrationId?: string, webchat?: any, callMeta?: any, opts?: any) => {
      calls.push({ agentId, msg, integrationId, callMeta, webchat })
      opts?.onAdmission?.({ accepted: true })
      return 'acp-1'
    }
  )
  const call = (req: MessageAgentReq) => (daemon as any).collab.messageAgent(req) as Promise<any>
  return { daemon, calls, call }
}

const baseReq = (over: Partial<MessageAgentReq> = {}): MessageAgentReq => ({
  callerAgentId: 'bot-a',
  platform: 'slack',
  callerChannel: 'C1',
  callerThread: '100.1',
  toAgentId: 'bot-b',
  text: 'do the thing',
  channel: 'C1',
  thread: '100.1',
  ...over
})

describe('messageAgent: same-daemon delivery', () => {
  it('delivers into the target session and reaches dispatch with agent-call coords + trusted from', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)

    const res = await call(baseReq())
    expect(res.delivered).toBe(true)
    expect(res.targetSession).toBe('slack:C1:100.1:bot-b')

    expect(calls.length).toBe(1)
    const { agentId, msg, callMeta } = calls[0]!
    expect(agentId).toBe('bot-b')
    // agent-call marker: source 'agent', sender = the trusted caller (isBot).
    expect(msg.source).toBe('agent')
    expect(msg.sender).toEqual({ id: 'bot-a', isBot: true })
    expect(msg.channel).toBe('C1')
    expect(msg.thread).toBe('100.1')
    // Stable, monotonic-ts-bearing msgId (NOT a random UUID) so transcript coords order.
    expect(msg.msgId).toMatch(/^agentcall:C1:\d+$/)
    // Trusted metadata rides the daemon-private turn context, not the prompt text.
    expect(callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 0 })
    expect(callMeta.deliveryId).toBe(msg.msgId.split(':').pop())
    // session-concept §5.3: the woken child inherits the caller's landing coords as its origin,
    // so it can reply into the caller via `sendMessage`'s SessionTarget. No caller session was
    // seeded here, so originSessionId is absent while originCoords are always present.
    expect(callMeta.originCoords).toEqual({ platform: 'slack', channel: 'C1', thread: '100.1' })
    expect(callMeta.originSessionId).toBeUndefined()
    // The display line is attribution only; the model text still carries the caller's ask.
    expect(msg.text).toContain('do the thing')

    await daemon.stop()
  })

  it('stamps the caller session’s OUTWARD id as the woken child’s originSessionId', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    // Seed the caller's own session record (mid-turn its acpSessionId is already minted),
    // so messageAgent captures it as the child's origin — the SessionTarget for a reply.
    const callerKey = sessionKey('slack', 'C1', '100.1', 'bot-a')
    await (daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    const res = await call(baseReq())
    expect(res.delivered).toBe(true)
    expect(calls[0]!.callMeta).toMatchObject({
      callFrom: 'bot-a',
      // NOT 'acp-parent-1': the control plane keys its session rows by the outward id, so a
      // lineage link written in the runtime's name would point at a parent no row matches —
      // which is also how a child inherits its parent's visibility (session-visibility.md §5.1).
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })
    await daemon.stop()
  })

  it('inherits the caller session’s immutable Slack source binding', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C1', '100.1', 'bot-a')
    await (daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await (daemon as any).store.setSessionClassification(callerKey, {
      sourceBindingKind: 'external',
      externalProvider: 'slack',
      externalRealmKey: 'T1',
      externalResourceKind: 'conversation',
      externalResourceKey: 'C1',
      externalIntegrationId: 'int-a'
    })

    await call(baseReq())

    expect(calls[0]!.callMeta.externalOrigin).toEqual({
      provider: 'slack',
      realmKey: 'T1',
      resourceKind: 'conversation',
      resourceKey: 'C1'
    })
    await daemon.stop()
  })

  it('delivers directly to the target with no visible post and no shared-transcript row', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }, { id: 'bot-c' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const postMessage = vi.fn(async () => '100.250000')
    ;(daemon as any).connByIntegration.set('int-a', { postMessage })

    const res = await call(baseReq({ callerIntegrationId: 'int-a' }))

    expect(res).toMatchObject({ delivered: true, targetSession: 'slack:C1:100.1:bot-b' })
    // Agent→agent messages are delivered directly to the target — nothing is posted
    // to the channel/thread, even when the caller has a live platform integration.
    expect(postMessage).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    const { agentId, msg, callMeta } = calls[0]!
    expect(agentId).toBe('bot-b')
    expect(msg.thread).toBe('100.1')
    expect(msg.sender).toEqual({ id: 'bot-a', isBot: true })
    // The delivered text names the caller (an isolated callee sees only this).
    expect(msg.text).toBe('From bot-a: do the thing')
    expect(msg.msgId).toMatch(/^agentcall:C1:\d+$/)
    expect(callMeta).toMatchObject({ callFrom: 'bot-a' })
    expect(callMeta.deliveryId).toBe(msg.msgId.split(':').pop())
    // No shared-transcript row is recorded for the (now invisible) agent message.
    expect(await (daemon as any).store.transcriptSince('C1', '100.1', null)).toEqual([])

    await daemon.stop()
  })

  it('rejects a postless self-message before any lookup', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq({ toAgentId: 'bot-a', postless: true }))
    expect(res).toMatchObject({ delivered: false, reason: 'self' })
    expect(calls.length).toBe(0)
    await daemon.stop()
  })

  it('admits a paired channel-root self wake into a new child session exactly once', async () => {
    const root = scaffold([
      {
        id: 'bot-a',
        callPolicy: 'selected',
        allowedCallerAgentIds: [],
        outboundPolicy: 'selected',
        allowedTargetAgentIds: []
      }
    ])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C1', '100.1', 'bot-a')
    await (daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    const req = baseReq({
      toAgentId: 'bot-a',
      thread: '200.2',
      transcriptTs: '200.2',
      agentCallDeliveryId: 'paired-self-1'
    })
    expect(
      (daemon as any).collab.wakeRejectionReason({ ...req, transcriptTs: undefined, agentCallDeliveryId: undefined })
    ).toBeNull()

    const res = await call(req)
    expect(res).toMatchObject({ delivered: true, targetSession: 'slack:C1:200.2:bot-a' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      agentId: 'bot-a',
      msg: {
        channel: 'C1',
        thread: '200.2',
        transcriptTs: '200.2',
        sender: { id: 'bot-a', isBot: true }
      },
      callMeta: {
        callFrom: 'bot-a',
        originSessionId: 'sid-parent-1',
        originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
      }
    })
    await daemon.stop()
  })

  it('rejects an unpaired self wake that only omits the postless marker', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq({ toAgentId: 'bot-a', thread: '200.2' }))
    expect(res).toMatchObject({ delivered: false, reason: 'self' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('rejects a self wake anchored only to a synthetic local timestamp', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(
      baseReq({
        toAgentId: 'bot-a',
        thread: 'local-0',
        transcriptTs: 'local-0',
        agentCallDeliveryId: 'synthetic-self-1'
      })
    )
    expect(res).toMatchObject({ delivered: false, reason: 'self' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it.each(['U1122334455', '<@U1122334455>', ' U1122334455 ', '\t<@U1122334455>\n'])(
    'rejects Slack target %s before publishing a misleading visible message',
    async (toAgentId) => {
      const root = scaffold([{ id: 'bot-a' }])
      const { daemon, calls, call } = await bootWithDispatchSpy(root)
      const postMessage = vi.fn(async () => '100.250000')
      ;(daemon as any).connByIntegration.set('int-a', { postMessage })

      const res = await call(baseReq({ callerIntegrationId: 'int-a', toAgentId }))

      expect(res).toMatchObject({ delivered: false, reason: 'invalid_target' })
      expect(postMessage).not.toHaveBeenCalled()
      expect(calls).toHaveLength(0)
      expect(await (daemon as any).store.transcriptSince('C1', '100.1', null)).toEqual([])
      await daemon.stop()
    }
  )

  it('returns not_local for a target not on this daemon (no relay in P1)', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq({ toAgentId: 'elsewhere' }))
    expect(res).toMatchObject({ delivered: false, reason: 'not_local' })
    expect(calls.length).toBe(0)
    await daemon.stop()
  })

  it('enforces the target call policy: rejects a non-allowed caller under selected', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b', callPolicy: 'selected', allowedCallerAgentIds: ['other'] }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq())
    expect(res).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls.length).toBe(0)
    await daemon.stop()
  })

  it('enforces the caller outbound policy even when the local target allows it', async () => {
    const root = scaffold([
      { id: 'bot-a', outboundPolicy: 'selected', allowedTargetAgentIds: ['bot-c'] },
      { id: 'bot-b' }
    ])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq())
    expect(res).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('preflights a caller outbound denial before sendMessage can create a visible channel post', async () => {
    const root = scaffold([
      { id: 'bot-a', outboundPolicy: 'selected', allowedTargetAgentIds: ['bot-c'] },
      { id: 'bot-b' }
    ])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const postMessage = vi.fn(async () => '100.250000')
    ;(daemon as any).connByIntegration.set('int-a', { postMessage })

    const result = (await executeTool(
      {
        agentId: 'bot-a',
        platform: 'slack',
        integrationId: 'int-a',
        isDm: false,
        channel: 'C1',
        thread: '100.1',
        tools: [],
        integrations: [{ id: 'int-a', platform: 'slack' }]
      },
      'sendMessage',
      { toAgent: 'bot-b', channel: 'C1', message: 'handoff' },
      { ...(daemon as any).mcp.deps, canRun: () => true }
    )) as { wake?: { delivered: boolean; reason?: string }; post?: unknown }

    expect(result.wake).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(result.post).toBeUndefined()
    expect(postMessage).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect(await (daemon as any).store.transcriptSince('C1', '100.1', null)).toEqual([])
    await daemon.stop()
  })

  // Channel membership is NO LONGER an authorization key — A2A delivery is postless, so
  // `channel` is only a session coordinate. Two agents that share no channel (and an agent
  // with no integration at all) collaborate as long as the call policy admits them.
  it('allows a local target that shares no channel with the caller (policy is the only gate)', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const placement = (agentId: string) => ({
      agentId,
      daemonId: 'local-daemon',
      callPolicy: 'all' as const,
      allowedCallerAgentIds: [],
      outboundPolicy: 'all' as const,
      allowedTargetAgentIds: []
    })
    ;(daemon as any).cpCollab.replace({
      generation: 1,
      channels: [
        { orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: [placement('bot-a')] },
        { orgId: TEST_ORG, platform: 'slack', channelId: 'C2', agents: [placement('bot-b')] }
      ],
      agents: [
        { ...placement('bot-a'), orgId: TEST_ORG },
        { ...placement('bot-b'), orgId: TEST_ORG }
      ]
    })

    expect((daemon as any).collab.wakeRejectionReason(baseReq())).toBeNull()
    const result = await call(baseReq())
    expect(result).toMatchObject({ delivered: true })
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })

  // COORDINATE INTEGRITY on the SAME-DAEMON path — the third wake path, and the one whose
  // coordinate is MODEL-supplied (`channel` / `thread` reach `req` verbatim). The
  // relay hop and `rd/agentmsg` terminal-verify both gate the asserted coordinate; without
  // the same gate here a model could name a channel its own agent cannot reach and RESUME a
  // co-located peer's session living there.
  it('rejects a model-chosen channel the CALLER cannot reach, and never posts for it', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const placement = (agentId: string) => ({
      agentId,
      daemonId: 'local-daemon',
      callPolicy: 'all' as const,
      allowedCallerAgentIds: [],
      outboundPolicy: 'all' as const,
      allowedTargetAgentIds: []
    })
    // bot-a is in C1 only; bot-b is in C1 AND C_EXECS (where it has a live session).
    ;(daemon as any).cpCollab.replace({
      generation: 5,
      channels: [
        { orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: [placement('bot-a'), placement('bot-b')] },
        { orgId: TEST_ORG, platform: 'slack', channelId: 'C_EXECS', agents: [placement('bot-b')] }
      ],
      agents: [
        { ...placement('bot-a'), orgId: TEST_ORG },
        { ...placement('bot-b'), orgId: TEST_ORG }
      ]
    })
    const attack = baseReq({ channel: 'C_EXECS', thread: '900.1' })
    // The preflight must agree, or `sendMessage` leaves a visible post for a doomed wake.
    expect((daemon as any).collab.wakeRejectionReason(attack)).toBe('not_allowed')
    expect(await call(attack)).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    // The shared channel still delivers — policy, not membership, is the authorization.
    expect(await call(baseReq())).toMatchObject({ delivered: true })
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })

  // The same-daemon half of the review finding. `localWakeDecision` is BOTH the sendMessage
  // preflight and the enforcement gate, so the identical three-branch rule must hold here.
  it('rejects an UNKNOWN IM coordinate on the same-daemon path too (fail closed)', async () => {
    // The snapshot knows only slack C1 (seeded by bootWithDispatchSpy), so `C_GHOST` is an
    // unrecorded IM coordinate: a DM, a departed row, or a guess. Admitting it is what let a
    // model land on a co-located peer's existing session at that channel:thread.
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    for (const platform of ['slack', 'telegram', 'discord', 'feishu']) {
      const attack = baseReq({ platform, channel: 'C_GHOST', thread: '900.1' })
      // The preflight must agree, or `sendMessage` leaves a visible post for a doomed wake.
      expect((daemon as any).collab.wakeRejectionReason(attack)).toBe('not_allowed')
      expect(await call(attack)).toMatchObject({ delivered: false, reason: 'not_allowed' })
    }
    expect(calls).toHaveLength(0)
    // The channel they genuinely share still delivers.
    expect(await call(baseReq())).toMatchObject({ delivered: true, targetSession: 'slack:C1:100.1:bot-b' })
    await daemon.stop()
  })

  // Channel-free collaboration is unaffected in the sense that matters — the wake is still
  // ADMITTED — but the asserted coordinate no longer becomes the session key.
  it('keys a channel-free wake off the trusted caller, and collapses two asserted channels into one session', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const req = baseReq({ platform: 'webchat', callerChannel: 'wc-1', channel: 'wc-1' })
    expect((daemon as any).collab.wakeRejectionReason(req)).toBeNull()
    const first = await call(req)
    // `a2a:bot-a`, NOT `webchat:wc-1:…` — the webchat conversation id is the caller's own
    // session coordinate and must not be able to name the woken peer's.
    expect(first).toMatchObject({ delivered: true, targetSession: 'webchat:a2a:bot-a:100.1:bot-b' })
    expect(calls[0]!.msg.channel).toBe('a2a:bot-a')
    expect(calls[0]!.msg.msgId).toMatch(/^agentcall:a2a:bot-a:\d+$/)

    // A2A is postless (#854), so the conversation is the PAIR: a second wake naming a
    // different channel-free coordinate resumes the same pairwise session.
    const second = await call(baseReq({ platform: 'webchat', callerChannel: 'wc-1', channel: 'wc-9' }))
    expect(second.targetSession).toBe(first.targetSession)
    expect(calls).toHaveLength(2)
    await daemon.stop()
  })

  // #753 regression: a fresh `toAgent`+`channel` wake from inside a webchat conversation
  // lands on the synthetic `a2a:<callerId>` session above, not the browser's real
  // conversation — no browser is watching that private pairwise session, so it must NOT
  // get a live post-only webchat context (only a REPLY back into the real origin session
  // should — see the replyToSession suite below).
  it('a fresh webchat-originated wake gets no live post context — its target is the synthetic a2a session', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const req = baseReq({
      platform: 'webchat',
      callerChannel: '11111111-1111-4111-8111-111111111111',
      channel: '11111111-1111-4111-8111-111111111111'
    })
    expect(await call(req)).toMatchObject({ delivered: true })
    expect(calls[0]!.msg.channel).toBe('a2a:bot-a') // confirms the synthetic substitution fired
    expect(calls[0]!.webchat).toBeUndefined()
    await daemon.stop()
  })

  // A `dream` turn is genuinely channel-free: the coordinate decision reads the RAW session
  // platform and admits it as branch 3, and — since the `narrowPlatform` fold was deleted
  // (S1a §6.3) — the woken session key now carries `dream` itself instead of a folded
  // `slack` prefix nothing could continue. (`hook` is the same shape: a target-less hook
  // session's channel is the hook id.)
  it('treats a raw session-identity platform as channel-free and keys the child with it', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, call, calls } = await bootWithDispatchSpy(root)
    const dream = baseReq({ platform: 'dream', callerChannel: 'memory', channel: 'memory', thread: 'dream-1' })
    expect((daemon as any).collab.wakeRejectionReason(dream)).toBeNull()
    // Raw platform prefix — and the CHANNEL is the caller-derived one, not 'memory'.
    expect(await call(dream)).toMatchObject({ delivered: true, targetSession: 'dream:a2a:bot-a:dream-1:bot-b' })
    // Post-fleet-gate: the origin coordinate carries the RAW platform too (no 'slack'
    // emission clamp), so a cross-daemon reply into this origin takes the channel-free
    // branch on the relay instead of the fail-closed IM branch.
    expect(calls.at(-1)!.callMeta.originCoords).toEqual({ platform: 'dream', channel: 'memory', thread: '100.1' })

    const hook = baseReq({ platform: 'hook', callerChannel: 'hook-1', channel: 'hook-1', thread: 'delivery-1' })
    expect((daemon as any).collab.wakeRejectionReason(hook)).toBeNull()
    expect(await call(hook)).toMatchObject({ delivered: true, targetSession: 'hook:a2a:bot-a:delivery-1:bot-b' })
    await daemon.stop()
  })

  // The org directory is the fail-closed authority: an id in NO directory entry is rejected
  // as not_allowed instead of falling through to a misleading 'offline'/relay attempt.
  it('rejects a target id that is in no directory entry at all', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async () => {
        throw new Error('an unknown target must never reach the relay')
      })
    }
    expect((daemon as any).collab.wakeRejectionReason(baseReq({ toAgentId: 'test2' }))).toBe('not_allowed')
    const result = await call(baseReq({ toAgentId: 'test2' }))
    expect(result).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  // An empty/stale snapshot must not grant access, even for two LOCAL agents.
  it('fails closed when the org directory is empty (no snapshot yet)', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).cpCollab.replace({ generation: 1, channels: [], agents: [] })
    expect((daemon as any).collab.wakeRejectionReason(baseReq())).toBe('not_allowed')
    expect(await call(baseReq())).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('allows a listed caller under selected policy', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b', callPolicy: 'selected', allowedCallerAgentIds: ['bot-a'] }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq())
    expect(res.delivered).toBe(true)
    expect(calls.length).toBe(1)
    await daemon.stop()
  })

  it('a repeated deliveryId is idempotent — the second delivery is a no-op returning the cached result', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    // Pin the deliveryId so two calls collide on the same stable id (a P2 retry reuses it).
    const spy = vi.spyOn(monotonic, 'monotonicTs').mockReturnValue('999000111')

    const first = await call(baseReq())
    expect(first).toMatchObject({ delivered: true, targetSession: 'slack:C1:100.1:bot-b' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.msg.msgId).toBe('agentcall:C1:999000111')

    // Second call with the SAME minted deliveryId: cached verdict, no second dispatch.
    const second = await call(baseReq())
    expect(second).toEqual(first)
    expect(calls.length).toBe(1)

    spy.mockRestore()
    await daemon.stop()
  })
})

describe('messageAgent: §6.7 daemon-managed auto-inheritance (hop/origin + reply correlation)', () => {
  // Seed the CURRENT in-flight turn's trusted callMeta for a caller's logical sessionKey,
  // simulating a worker whose turn was started by messageAgent (callFrom=main, correlationId=x).
  const seedActiveTurn = (
    daemon: any,
    caller: { platform: string; channel: string; thread: string; agentId: string },
    callMeta: { callFrom: string; correlationId?: string; hopCount: number; deliveryId: string }
  ) => {
    const key = `${caller.platform}:${caller.channel}:${caller.thread}:${caller.agentId}`
    ;(daemon as any).activeTurnCallMeta.set(key, callMeta)
  }

  it('REPLY: worker messaging back its caller auto-inherits the inbound correlationId (no arg passed)', async () => {
    const root = scaffold([{ id: 'main' }, { id: 'worker' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    // worker's active turn was started by main, carrying correlationId o1.0.
    seedActiveTurn(
      daemon,
      { platform: 'slack', channel: 'C1', thread: '100.1', agentId: 'worker' },
      { callFrom: 'main', correlationId: 'o1.0', hopCount: 0, deliveryId: 'd0' }
    )
    // worker replies to main WITHOUT passing correlationId.
    const res = await call(baseReq({ callerAgentId: 'worker', toAgentId: 'main', text: 'done' /* no correlationId */ }))
    expect(res.delivered).toBe(true)
    expect(calls).toHaveLength(1)
    // Auto-inherited: correlation bounced back to main, hop incremented.
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'worker', correlationId: 'o1.0', hopCount: 1 })
    await daemon.stop()
  })

  it('THIRD agent: messaging a non-caller does NOT inherit correlation, but DOES inherit hop+1', async () => {
    const root = scaffold([{ id: 'main' }, { id: 'worker' }, { id: 'third' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    seedActiveTurn(
      daemon,
      { platform: 'slack', channel: 'C1', thread: '100.1', agentId: 'worker' },
      { callFrom: 'main', correlationId: 'o1.0', hopCount: 2, deliveryId: 'd0' }
    )
    // worker forwards work to a THIRD agent (not its caller) → fresh correlation, hop inherited.
    const res = await call(baseReq({ callerAgentId: 'worker', toAgentId: 'third', text: 'sub-help' }))
    expect(res.delivered).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.callMeta.correlationId).toBeUndefined()
    expect(calls[0]!.callMeta.hopCount).toBe(3)
    await daemon.stop()
  })

  it('explicit arg correlationId overrides the auto-inherited reply correlation', async () => {
    const root = scaffold([{ id: 'main' }, { id: 'worker' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    seedActiveTurn(
      daemon,
      { platform: 'slack', channel: 'C1', thread: '100.1', agentId: 'worker' },
      { callFrom: 'main', correlationId: 'o1.0', hopCount: 0, deliveryId: 'd0' }
    )
    const res = await call(baseReq({ callerAgentId: 'worker', toAgentId: 'main', correlationId: 'manual-99' }))
    expect(res.delivered).toBe(true)
    expect(calls[0]!.callMeta.correlationId).toBe('manual-99')
    await daemon.stop()
  })

  it('no active turn (human-initiated call) → fresh call: hop 0, no inherited correlation', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq()) // nothing seeded
    expect(res.delivered).toBe(true)
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 0 })
    expect(calls[0]!.callMeta.correlationId).toBeUndefined()
    await daemon.stop()
  })

  it('#536: a deliverHeadless caller turn wakes the peer HEADLESS (silent record, no channel post)', async () => {
    const root = scaffold([{ id: 'joiner' }, { id: 'peer' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    // The intro fan-out marks the joiner's turn deliverHeadless; the woken peer must run headless.
    ;(daemon as any).activeTurnCallMeta.set('slack:C1:100.1:joiner', {
      callFrom: 'joiner',
      hopCount: 0,
      deliveryId: 'd0',
      deliverHeadless: true
    })
    const res = await call(baseReq({ callerAgentId: 'joiner', toAgentId: 'peer' }))
    expect(res.delivered).toBe(true)
    expect(calls[0]!.msg.headless).toBe(true)
    // The peer's OWN callMeta does NOT carry the marker → no further cascade.
    expect(calls[0]!.callMeta.deliverHeadless).toBeUndefined()
    await daemon.stop()
  })

  it('runs the POSTLESS toAgent form’s child headless, and a channel-root call visibly', async () => {
    // send-message-routing-rework.md §3.1 / §10 case 2. Without the headless stamp
    // "postless" would describe only the wake: nothing announces the call, yet the child's
    // own answer would still surface in the caller's channel — the exact interruption this
    // form exists to avoid.
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    expect((await call({ ...baseReq(), postless: true })).delivered).toBe(true)
    expect(calls[0]!.msg.headless).toBe(true)

    // A channel-root call deliberately made itself visible, so its child is not headless.
    calls.length = 0
    expect((await call({ ...baseReq(), transcriptTs: '1720000000.000100' })).delivered).toBe(true)
    expect(calls[0]!.msg.headless).toBeUndefined()
    await daemon.stop()
  })

  it('hop cap is enforced across an inherited chain', async () => {
    const root = scaffold([{ id: 'main' }, { id: 'worker' }, { id: 'third' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    // The next child would reach the cap, so it is rejected.
    seedActiveTurn(
      daemon,
      { platform: 'slack', channel: 'C1', thread: '100.1', agentId: 'worker' },
      { callFrom: 'main', hopCount: MAX_AGENT_CALL_HOPS - 1, deliveryId: 'd0' }
    )
    const res = await call(baseReq({ callerAgentId: 'worker', toAgentId: 'third' }))
    expect(res).toMatchObject({ delivered: false, reason: 'hop_limit' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })
})

describe('messageAgent: cross-daemon routing (P2, source side)', () => {
  it('routes a not-local target over the relay and returns delivered per the relay ACK', async () => {
    const root = scaffold([{ id: 'bot-a' }]) // bot-b is NOT on this daemon
    const { daemon, call } = await bootWithDispatchSpy(root)
    const sent: any[] = []
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (payload: any) => {
        sent.push(payload)
        return { deliveryId: payload.deliveryId, delivered: true }
      })
    }
    const res = await call(baseReq({ toAgentId: 'bot-b' }))
    expect(res.delivered).toBe(true)
    expect(sent).toHaveLength(1)
    // The claimed caller is our trusted session identity; hop starts at 0 (relay +1s).
    expect(sent[0]).toMatchObject({ claimedFromAgentId: 'bot-a', toAgentId: 'bot-b', hopCount: 0 })
    expect(sent[0].coords).toMatchObject({ platform: 'slack', channel: 'C1', thread: '100.1' })
    // A postless wake carries no post ts on the wire.
    expect(sent[0].transcriptTs).toBeUndefined()
    await daemon.stop()
  })

  it('forwards needsReply on the wire when the caller has an origin session', async () => {
    const root = scaffold([{ id: 'bot-a' }]) // bot-b is remote
    const { daemon, call } = await bootWithDispatchSpy(root)
    const sent: any[] = []
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (payload: any) => {
        sent.push(payload)
        return { deliveryId: payload.deliveryId, delivered: true }
      })
    }
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    await call(baseReq({ toAgentId: 'bot-b', needsReply: true }))
    expect(sent[0]).toMatchObject({ originSessionId: 'sid-parent-1', needsReply: true })
    await daemon.stop()
  })

  it('omits needsReply on the wire with no origin to report to, and for a plain wake', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    const sent: any[] = []
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (payload: any) => {
        sent.push(payload)
        return { deliveryId: payload.deliveryId, delivered: true }
      })
    }
    // No caller session row ⇒ no originSessionId ⇒ nothing to report into.
    await call(baseReq({ toAgentId: 'bot-b', needsReply: true }))
    expect(sent[0].needsReply).toBeUndefined()
    expect(sent[0].originSessionId).toBeUndefined()
    await daemon.stop()
  })

  it('forwards the visible-post transcriptTs on the wire (toAgent+channel wake)', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    const sent: any[] = []
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (payload: any) => {
        sent.push(payload)
        return { deliveryId: payload.deliveryId, delivered: true }
      })
    }
    const res = await call(baseReq({ toAgentId: 'bot-b', transcriptTs: '100.250000' }))
    expect(res.delivered).toBe(true)
    expect(sent[0].transcriptTs).toBe('100.250000')
    await daemon.stop()
  })

  it('forwards the trusted source depth and auto-inherited reply correlation to the relay', async () => {
    const root = scaffold([{ id: 'worker' }]) // main is on another daemon
    const { daemon, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).activeTurnCallMeta.set('slack:C1:100.1:worker', {
      callFrom: 'main',
      correlationId: 'o1.0',
      hopCount: 2,
      deliveryId: 'd0'
    })
    const sendAgentMsg = vi.fn(async (payload: any) => ({ deliveryId: payload.deliveryId, delivered: true }))
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendAgentMsg }

    const res = await call(baseReq({ callerAgentId: 'worker', toAgentId: 'main', text: 'done' }))

    expect(res.delivered).toBe(true)
    expect(sendAgentMsg).toHaveBeenCalledTimes(1)
    // Wire carries the SOURCE depth; the relay increments this to target depth 3.
    expect(sendAgentMsg.mock.calls[0]![0]).toMatchObject({
      claimedFromAgentId: 'worker',
      toAgentId: 'main',
      hopCount: 2,
      correlationId: 'o1.0'
    })
    await daemon.stop()
  })

  it('rejects a cross-daemon call whose next delivery reaches the hop cap', async () => {
    const root = scaffold([{ id: 'worker' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).activeTurnCallMeta.set('slack:C1:100.1:worker', {
      callFrom: 'main',
      hopCount: MAX_AGENT_CALL_HOPS - 1,
      deliveryId: 'd0'
    })
    const sendAgentMsg = vi.fn()
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendAgentMsg }

    const res = await call(baseReq({ callerAgentId: 'worker', toAgentId: 'remote-third' }))

    expect(res).toMatchObject({ delivered: false, reason: 'hop_limit' })
    expect(sendAgentMsg).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('maps a relay NAK reason (not_allowed) to delivered:false', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (p: any) => ({ deliveryId: p.deliveryId, delivered: false, reason: 'not_allowed' }))
    }
    const res = await call(baseReq({ toAgentId: 'bot-b' }))
    expect(res).toMatchObject({ delivered: false, reason: 'not_allowed' })
    await daemon.stop()
  })

  it('re-sends the SAME deliveryId while the relay answers not_ready, then returns the admission (#987)', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    const clock = new FakeClock(1_000_000)
    ;(daemon as any).clock = clock
    const sent: any[] = []
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (p: any) => {
        sent.push(p)
        return sent.length < 3
          ? { deliveryId: p.deliveryId, delivered: false, reason: 'not_ready' }
          : { deliveryId: p.deliveryId, delivered: true, childSessionId: 'remote-key' }
      })
    }
    const pending = call(baseReq({ toAgentId: 'bot-b' }))
    // Each miss parks the loop on a backoff timer; fire them one at a time.
    for (let i = 0; i < 2; i += 1) {
      await vi.waitFor(() => expect(clock.pending).toBe(1), WAIT)
      clock.advance(60_000)
    }
    const res = await pending
    expect(res).toMatchObject({ delivered: true, targetSession: 'remote-key' })
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map((p) => p.deliveryId)).size).toBe(1)
    await daemon.stop()
  })

  it('a not_ready that outlasts the retry window is recorded as the terminal verdict', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    const clock = new FakeClock(1_000_000)
    ;(daemon as any).clock = clock
    const sendAgentMsg = vi.fn(async (p: any) => ({ deliveryId: p.deliveryId, delivered: false, reason: 'not_ready' }))
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendAgentMsg }
    const pending = call(baseReq({ toAgentId: 'bot-b' }))
    // Jumping past the whole window makes the next backoff step cross the deadline: terminal.
    await vi.waitFor(() => expect(clock.pending).toBe(1), WAIT)
    clock.advance(AGENTMSG_NOT_READY_RETRY.windowMs)
    const res = await pending
    expect(res).toMatchObject({ delivered: false, reason: 'not_ready' })
    expect(sendAgentMsg).toHaveBeenCalledTimes(2)
    // Recorded like every other terminal verdict: the same deliveryId replays it, no re-send.
    const deliveryId = sendAgentMsg.mock.calls[0]![0].deliveryId
    expect((daemon as any).collab.agentCallDeliveries.get(deliveryId)).toMatchObject({ reason: 'not_ready' })
    await daemon.stop()
  })

  it('no READY relay (send throws) → delivered:false reason offline', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async () => {
        throw new Error('no READY relay')
      })
    }
    const res = await call(baseReq({ toAgentId: 'bot-b' }))
    expect(res).toMatchObject({ delivered: false, reason: 'offline' })
    await daemon.stop()
  })
})

describe('handleRelayAgentMsg: cross-daemon target side (P2)', () => {
  const ORG = '00000000-0000-0000-0000-0000000000a1'

  // Install a collaboration snapshot so terminal-verify can resolve caller + target.
  function withSnapshot(
    daemon: any,
    over: Partial<{
      callPolicy: 'all' | 'selected'
      allowed: string[]
      outboundPolicy: 'all' | 'selected'
      allowedTargets: string[]
    }> = {}
  ) {
    ;(daemon as any).cpCollab.replace({
      generation: 1,
      channels: [
        {
          orgId: ORG,
          platform: 'slack',
          channelId: 'C1',
          agents: [
            {
              agentId: 'bot-a',
              daemonId: 'd1',
              integrationId: undefined,
              callPolicy: 'all',
              allowedCallerAgentIds: [],
              outboundPolicy: over.outboundPolicy ?? 'all',
              allowedTargetAgentIds: over.allowedTargets ?? []
            },
            {
              agentId: 'bot-b',
              daemonId: 'd2',
              integrationId: undefined,
              callPolicy: over.callPolicy ?? 'all',
              allowedCallerAgentIds: over.allowed ?? [],
              outboundPolicy: 'all',
              allowedTargetAgentIds: []
            }
          ]
        }
      ]
    })
  }

  /** bot-a (remote, d1) is in `pub` only; bot-b (local, d2) is in `pub` AND `execs` — the
   *  F1 attack shape. `platform` keys the CHANNEL ROWS, which is what the coordinate the
   *  caller asserts must be checked against regardless of the platform it names. */
  function withExecsSnapshot(daemon: any, platform: string, execs = 'C_EXECS', pub = 'C_PUBLIC'): void {
    const placement = (agentId: string, daemonId: string) => ({
      agentId,
      daemonId,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
    daemon.cpCollab.replace({
      generation: 4,
      channels: [
        { orgId: ORG, platform, channelId: pub, agents: [placement('bot-a', 'd1'), placement('bot-b', 'd2')] },
        { orgId: ORG, platform, channelId: execs, agents: [placement('bot-b', 'd2')] }
      ],
      agents: [
        { ...placement('bot-a', 'd1'), orgId: ORG },
        { ...placement('bot-b', 'd2'), orgId: ORG }
      ]
    })
    // Policies are all 'all' and both agents are in the org directory, so `admits()` passes —
    // only the coordinate check can stop the wake.
    expect(daemon.cpCollab.admits('bot-a', 'bot-b')).toBe(true)
  }

  const fwd = (over: any = {}) => ({
    trustedFromAgentId: 'bot-a',
    orgId: ORG,
    toAgentId: 'bot-b',
    text: 'hi',
    coords: { platform: 'slack', channel: 'C1', thread: '100.1' },
    hopCount: 1,
    deliveryId: 'd-1',
    ...over
  })

  it('terminal-verifies + dispatches source:agent with the trusted callMeta; delivered:true', async () => {
    const root = scaffold([{ id: 'bot-b' }]) // bot-b is local here (the target daemon)
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const ack = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(ack).toMatchObject({ deliveryId: 'd-1', delivered: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentId).toBe('bot-b')
    expect(calls[0]!.msg.source).toBe('agent')
    // The forwarded text already names the caller — deliver it verbatim, no `asked:` re-wrap.
    expect(calls[0]!.msg.text).toBe('hi')
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 1, deliveryId: 'd-1' })
    // No visible post preceded this wake → no transcriptTs, ts derives from the delivery id.
    expect(calls[0]!.msg.transcriptTs).toBeUndefined()
    await daemon.stop()
  })

  // §5.3 lineage reply: a SessionTarget reply into a channel-free origin must land in the
  // EXACT origin session — coordinate keying would substitute a2a:<replier> and mint a
  // DIFFERENT synthetic session, stranding a needsReply result outside the originating turn.
  it('lineageReplyTo dispatches into the exact existing origin session (channel-free origin)', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const originKey = sessionKey('dream', 'memory', 'dream-1', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-b',
      platform: 'dream',
      channel: 'memory',
      thread: 'dream-1',
      acpSessionId: 'acp-dream-origin',
      sessionId: 'sid-dream-origin',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({
        coords: { platform: 'dream', channel: 'memory', thread: 'dream-1' },
        lineageReplyTo: 'sid-dream-origin',
        deliveryId: 'd-reply-1'
      })
    )
    // The ACK names the ORIGIN key — not a synthetic a2a:<caller> child.
    expect(ack).toMatchObject({ delivered: true, childSessionId: originKey })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentId).toBe('bot-b')
    // The reply message carries the origin session's OWN coordinates, raw platform included.
    expect(calls[0]!.msg).toMatchObject({ platform: 'dream', channel: 'memory', thread: 'dream-1', source: 'agent' })
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-a', deliveryId: 'd-reply-1' })
    await daemon.stop()
  })

  // #753: the cross-daemon analog of the replyToSession webchat test above — a lineage
  // reply routed back into an existing webchat origin session carries that session's own
  // real conversationId, so it gets a live post-only context; a FRESH cross-daemon wake
  // into a webchat-platform coordinate does not (coordsDecision substitutes a2a:<caller>
  // for it exactly as the same-daemon path does — see "a fresh webchat-originated wake…").
  it('#753: a cross-daemon lineage reply into a real webchat origin session gets a live post-only context', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const CONV = '66666666-6666-4666-8666-666666666666'
    const originKey = sessionKey('webchat', CONV, `webchat:${CONV}`, 'bot-b')
    await (daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-b',
      platform: 'webchat',
      channel: CONV,
      thread: `webchat:${CONV}`,
      acpSessionId: 'acp-webchat-origin',
      sessionId: 'sid-webchat-origin',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const sendWebchatPost = vi.fn()
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost }

    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({
        coords: { platform: 'webchat', channel: CONV },
        lineageReplyTo: 'sid-webchat-origin',
        deliveryId: 'd-reply-2'
      })
    )
    expect(ack).toMatchObject({ delivered: true, childSessionId: originKey })
    expect(calls).toHaveLength(1)
    const wc = calls[0]!.webchat
    expect(wc).toMatchObject({ conversationId: CONV, initiator: 'agent' })
    wc.postSink({
      conversationId: CONV,
      agentId: 'bot-b',
      post: { postId: 'p2', conversationId: CONV, author: { kind: 'agent', agentId: 'bot-b' }, text: 'hi', at: 1 }
    })
    expect(sendWebchatPost).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('a lineage reply marked session-reply resumes the origin as an ORDINARY turn', async () => {
    // send-message-routing-rework.md §7/§8.3/§8.4. `replyToSession`'s cross-daemon leg
    // sends BOTH `lineageReplyTo` and `deliveryKind: 'session-reply'`, and the lineage
    // branch builds its own message and returns before the wake path — so its stamp is set
    // independently and must match the local branch. NOT headless: the report itself is
    // transcript-only (nothing publishes an injected body), while muting the parent's own
    // answer would hide the delegated outcome from the humans in its thread. A remote
    // parent must not behave differently from a local one.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    await (daemon as any).store.upsertSession({
      key: sessionKey('dream', 'memory', 'dream-1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'dream',
      channel: 'memory',
      thread: 'dream-1',
      acpSessionId: 'acp-dream-origin',
      sessionId: 'sid-dream-origin',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({
        coords: { platform: 'dream', channel: 'memory', thread: 'dream-1' },
        lineageReplyTo: 'sid-dream-origin',
        deliveryKind: 'session-reply',
        deliveryId: 'd-reply-headless'
      })
    )
    expect(ack.delivered).toBe(true)
    expect(calls[0]!.msg.headless).toBeUndefined()
    await daemon.stop()
  })

  it('lineageReplyTo resolves agent-scoped: a colliding ACP id on another agent cannot shadow the origin', async () => {
    // ACP session ids are runtime/agent-local — two agents may legitimately share one. The
    // lookup must therefore be (toAgentId, acpSessionId); a global lookup could surface the
    // OTHER agent's row and wrongly NAK (or worse, dispatch into it).
    const root = scaffold([{ id: 'bot-b' }, { id: 'bot-x' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    // The colliding row is inserted FIRST so an insertion-ordered global lookup finds it.
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C9', '900.9', 'bot-x'),
      agentId: 'bot-x',
      platform: 'slack',
      channel: 'C9',
      thread: '900.9',
      acpSessionId: 'acp-shared',
      sessionId: 'sid-shared',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const originKey = sessionKey('dream', 'memory', 'dream-2', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-b',
      platform: 'dream',
      channel: 'memory',
      thread: 'dream-2',
      acpSessionId: 'acp-shared',
      sessionId: 'sid-shared',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'dream', channel: 'memory' }, lineageReplyTo: 'sid-shared', deliveryId: 'd-coll' })
    )
    expect(ack).toMatchObject({ delivered: true, childSessionId: originKey })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentId).toBe('bot-b')
    expect(calls[0]!.msg).toMatchObject({ platform: 'dream', channel: 'memory' })
    await daemon.stop()
  })

  it('lineage replies bypass the wake-coordinate membership gate (known channel, non-member replier)', async () => {
    // A (in C_EXECS via its origin session's channel) woke remote B, which has NO C_EXECS
    // placement. B's reply carries A's trusted origin coords; the membership gate would refuse
    // them as a wake, but a lineage reply never keys from coords — it must land in the exact
    // origin session. The control asserts the gate still refuses the same coords as a WAKE.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withExecsSnapshot(daemon, 'slack') // C_EXECS members: bot-b only; caller bot-a is not in it
    const originKey = sessionKey('slack', 'C_EXECS', '900.1', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C_EXECS',
      thread: '900.1',
      acpSessionId: 'acp-execs-origin',
      sessionId: 'sid-execs-origin',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    // Control: the same coordinate as an ordinary WAKE stays refused.
    const wake = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'slack', channel: 'C_EXECS', thread: '900.1' }, deliveryId: 'd-wake' })
    )
    expect(wake).toMatchObject({ delivered: false, reason: 'not_allowed' })

    const reply = await (daemon as any).handleRelayAgentMsg(
      fwd({
        coords: { platform: 'slack', channel: 'C_EXECS', thread: '900.1' },
        lineageReplyTo: 'sid-execs-origin',
        deliveryId: 'd-reply-2'
      })
    )
    expect(reply).toMatchObject({ delivered: true, childSessionId: originKey })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.msg).toMatchObject({ platform: 'slack', channel: 'C_EXECS', thread: '900.1' })
    await daemon.stop()
  })

  it('lineageReplyTo NAKs not_found for a missing or foreign session — it never creates one', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const missing = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'dream', channel: 'memory' }, lineageReplyTo: 'sid-nope', deliveryId: 'd-r1' })
    )
    expect(missing).toMatchObject({ delivered: false, reason: 'not_found' })
    // A session owned by ANOTHER agent is refused the same way (ownership half of the check).
    await (daemon as any).store.upsertSession({
      key: sessionKey('dream', 'memory', 'dream-9', 'bot-x'),
      agentId: 'bot-x',
      platform: 'dream',
      channel: 'memory',
      thread: 'dream-9',
      acpSessionId: 'acp-foreign',
      sessionId: 'sid-foreign',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const foreign = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'dream', channel: 'memory' }, lineageReplyTo: 'sid-foreign', deliveryId: 'd-r2' })
    )
    expect(foreign).toMatchObject({ delivered: false, reason: 'not_found' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('stamps the forwarded post ts as transcriptTs (toAgent+channel wake dedup across daemons)', async () => {
    // The source daemon made a visible post and forwarded its real ts. The target must stamp it
    // on the woken turn so its transcript row collapses onto the post it fetches from the shared
    // thread (conversations.replies) instead of duplicating at the delivery id.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const ack = await (daemon as any).handleRelayAgentMsg(fwd({ transcriptTs: '100.250000' }))
    expect(ack).toMatchObject({ deliveryId: 'd-1', delivered: true })
    expect(calls[0]!.msg.transcriptTs).toBe('100.250000')
    await daemon.stop()
  })

  it('stamps a forwarded needsReply onto the child’s CallMeta, gated on an origin', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({ originSessionId: 'sid-remote-parent', needsReply: true })
    )
    expect(ack.delivered).toBe(true)
    expect(calls[0]!.callMeta).toMatchObject({ originSessionId: 'sid-remote-parent', needsReply: true })
    // The obligation is metadata — it never enters the delivered text.
    expect(calls[0]!.msg.text).not.toMatch(/needsReply|report back/i)
    await daemon.stop()
  })

  it('ignores a forwarded needsReply that carries no origin to report into', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const ack = await (daemon as any).handleRelayAgentMsg(fwd({ needsReply: true }))
    expect(ack.delivered).toBe(true)
    expect(calls[0]!.callMeta.needsReply).toBeUndefined()
    await daemon.stop()
  })

  it('refuses retryably (not_ready) when the local snapshot does not know the target yet, and terminally on an org mismatch', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // Empty snapshot → terminal-verify cannot confirm the target's org: our copy of the
    // directory may simply be behind the grant, so this is the retryable miss, not a refusal.
    ;(daemon as any).cpCollab.replace({ generation: 0, channels: [], agents: [] })
    const ack = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_ready' })
    expect(calls).toHaveLength(0)
    // ...and it is NOT cached: once the snapshot lands, the SAME deliveryId dispatches.
    withSnapshot(daemon)
    expect(await (daemon as any).handleRelayAgentMsg(fwd())).toMatchObject({ delivered: true })
    expect(calls).toHaveLength(1)
    // A directory that names a DIFFERENT org for the target is the terminal, cached refusal.
    const mismatch = await (daemon as any).handleRelayAgentMsg(fwd({ deliveryId: 'd-2', orgId: 'org-other' }))
    expect(mismatch).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })

  it('rejects coords naming a KNOWN channel the trusted caller is not in (coordinate integrity)', async () => {
    // The attack channel dropping membership from the POLICY predicate opened: `coords` is
    // still the woken peer's SESSION key, so a source daemon that asserts a channel its
    // caller cannot reach would resume the target's session THERE — and with `needsReply`
    // read that private conversation back. bot-a is only in C_PUBLIC; bot-b is in both.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const placement = (agentId: string, daemonId: string) => ({
      agentId,
      daemonId,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
    ;(daemon as any).cpCollab.replace({
      generation: 3,
      channels: [
        {
          orgId: ORG,
          platform: 'slack',
          channelId: 'C_PUBLIC',
          agents: [placement('bot-a', 'd1'), placement('bot-b', 'd2')]
        },
        { orgId: ORG, platform: 'slack', channelId: 'C_EXECS', agents: [placement('bot-b', 'd2')] }
      ],
      agents: [
        { ...placement('bot-a', 'd1'), orgId: ORG },
        { ...placement('bot-b', 'd2'), orgId: ORG }
      ]
    })
    // Policies are all 'all' and both agents are in the org directory, so `admits()` passes —
    // only the coordinate check can stop this.
    expect((daemon as any).cpCollab.admits('bot-a', 'bot-b')).toBe(true)
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'slack', channel: 'C_EXECS', thread: '900.1' }, needsReply: true })
    )
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    // The same call into a channel they genuinely share is delivered.
    const shared = await (daemon as any).handleRelayAgentMsg(
      fwd({ deliveryId: 'd-2', coords: { platform: 'slack', channel: 'C_PUBLIC', thread: '900.1' } })
    )
    expect(shared.delivered).toBe(true)
    await daemon.stop()
  })

  // The bypass an earlier revision of the coordinate gate had: it looked the coordinate up
  // under the RAW wire platform, while session keys were computed through the since-deleted
  // `narrowPlatform` fold (`feishu` and anything unrecognised became 'slack'). The two key
  // spaces differed and "unknown coordinate passes" hid it, so the SAME attack went through
  // with a legal `coords.platform:'feishu'` and still produced a bit-identical
  // childSessionId. Session keys are raw now; the channel-only lookup stays the guard.
  it('rejects the attack when the coordinate PLATFORM is switched to dodge the lookup', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withExecsSnapshot(daemon, 'slack')
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'feishu', channel: 'C_EXECS', thread: '900.1' }, needsReply: true })
    )
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  // The mirror of the same root cause, and the one that made the gate a no-op for a whole
  // tenant class: in a FEISHU org the rows are keyed 'feishu' while `messageAgent` narrows
  // its own coords to 'slack', so every honest wake already carries 'slack'. The attack then
  // needs no exotic platform value at all.
  it('rejects the attack in a FEISHU org, where honest coords are already narrowed to slack', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withExecsSnapshot(daemon, 'feishu', 'oc_execs', 'oc_pub')
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'slack', channel: 'oc_execs', thread: '900.1' }, needsReply: true })
    )
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    // ...and the shared channel still routes, likewise with a narrowed platform.
    const shared = await (daemon as any).handleRelayAgentMsg(
      fwd({ deliveryId: 'd-2', coords: { platform: 'slack', channel: 'oc_pub', thread: '900.1' } })
    )
    expect(shared.delivered).toBe(true)
    await daemon.stop()
  })

  it('rejects an UNKNOWN IM coordinate — fail closed, not "unknown ⇒ pass"', async () => {
    // The review finding on the target side. "Unknown coordinate passes" also admitted Slack
    // DMs and channels whose row has gone, so a compromised source daemon could name any
    // conversation, land on the target's EXISTING session at that channel:thread and (with
    // `needsReply`) read it back. Nothing in the snapshot vouches for `C_GHOST`, so the wake
    // is refused rather than silently keyed to it. Policies are 'all' — only this can stop it.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon) // knows only slack C1
    for (const [i, platform] of ['slack', 'telegram', 'discord', 'feishu'].entries()) {
      const ack = await (daemon as any).handleRelayAgentMsg(
        fwd({ deliveryId: `d-im-${i}`, coords: { platform, channel: 'C_GHOST', thread: '900.1' }, needsReply: true })
      )
      expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    }
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('admits a channel-free coordinate but keys the child off the TRUSTED CALLER, not the asserted channel', async () => {
    // Channel-free collaboration must keep working — but not by trusting the coordinate.
    // The wake is admitted and the child session key is derived from `trustedFromAgentId`,
    // so it can no longer alias any session living at the asserted coordinate.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon) // knows only slack C1
    const ack = await (daemon as any).handleRelayAgentMsg(
      fwd({ coords: { platform: 'webchat', channel: 'wc-session-1', thread: 'wc-session-1' } })
    )
    expect(ack.delivered).toBe(true)
    // THE assertion: the exact key handed back to the caller. `a2a:bot-a` — never
    // `webchat:wc-session-1:…`, which is what a webchat session of bot-b would be keyed by.
    expect(ack.childSessionId).toBe('webchat:a2a:bot-a:wc-session-1:bot-b')
    expect(ack.childSessionId).not.toContain('wc-session-1:wc-session-1')
    expect(calls).toHaveLength(1)
    // The dispatched turn lands on the SAME coordinate the ACK reports, or the row the child
    // creates would not be the one the caller was told to follow.
    expect(calls[0]!.msg.channel).toBe('a2a:bot-a')
    expect(calls[0]!.msg.thread).toBe('wc-session-1')
    expect(calls[0]!.msg.msgId).toBe('agentcall:a2a:bot-a:d-1')
    await daemon.stop()
  })

  it('two channel-free wakes from one caller asserting DIFFERENT channels converge on ONE pairwise session', async () => {
    // A2A is postless (#854), so the "conversation" between two agents is the pair, not a
    // channel. Since the substituted channel is derived from the caller alone, a caller that
    // names two different channel-free coordinates in one thread resumes the same session
    // instead of forking a fresh one per asserted string.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const first = await (daemon as any).handleRelayAgentMsg(
      fwd({ deliveryId: 'd-1', coords: { platform: 'webchat', channel: 'wc-1', thread: 'T' } })
    )
    const second = await (daemon as any).handleRelayAgentMsg(
      fwd({ deliveryId: 'd-2', coords: { platform: 'webchat', channel: 'wc-2', thread: 'T' } })
    )
    expect(first.delivered).toBe(true)
    expect(second.delivered).toBe(true)
    expect(second.childSessionId).toBe(first.childSessionId)
    expect(first.childSessionId).toBe('webchat:a2a:bot-a:T:bot-b')
    expect(calls).toHaveLength(2)
    // A DIFFERENT caller is a different pair, so it must NOT collapse into that session.
    ;(daemon as any).cpCollab.replace({
      generation: 2,
      channels: [],
      agents: [
        { agentId: 'bot-a', daemonId: 'd1', orgId: ORG, callPolicy: 'all', allowedCallerAgentIds: [] },
        { agentId: 'bot-c', daemonId: 'd3', orgId: ORG, callPolicy: 'all', allowedCallerAgentIds: [] },
        { agentId: 'bot-b', daemonId: 'd2', orgId: ORG, callPolicy: 'all', allowedCallerAgentIds: [] }
      ]
    })
    const other = await (daemon as any).handleRelayAgentMsg(
      fwd({
        deliveryId: 'd-3',
        trustedFromAgentId: 'bot-c',
        coords: { platform: 'webchat', channel: 'wc-1', thread: 'T' }
      })
    )
    expect(other.childSessionId).toBe('webchat:a2a:bot-c:T:bot-b')
    await daemon.stop()
  })

  it('target callPolicy=selected, caller not allowed → NAK not_allowed (terminal check)', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon, { callPolicy: 'selected', allowed: ['someone-else'] })
    const ack = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('caller outboundPolicy=selected, target not allowed → NAK not_allowed (terminal check)', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon, { outboundPolicy: 'selected', allowedTargets: ['someone-else'] })
    const ack = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('target known to the directory but not local → NAK not_ready (a stale route, re-routed by the retry)', async () => {
    const root = scaffold([{ id: 'bot-x' }]) // bot-b not local
    const { daemon } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const ack = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_ready' })
    // Not cached: the same deliveryId is re-evaluated (still not local here, so still not_ready).
    expect((daemon as any).relayAgentMsgAcks.has(`bot-a:${fwd().deliveryId}`)).toBe(false)
    await daemon.stop()
  })

  it('target unknown to the directory AND not local → NAK not_found (terminal, cached)', async () => {
    const root = scaffold([{ id: 'bot-x' }])
    const { daemon } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const ack = await (daemon as any).handleRelayAgentMsg(fwd({ toAgentId: 'bot-nowhere' }))
    expect(ack).toMatchObject({ delivered: false, reason: 'not_found' })
    expect((daemon as any).relayAgentMsgAcks.has(`bot-a:${fwd().deliveryId}`)).toBe(true)
    await daemon.stop()
  })

  it('per-hop dedup: same deliveryId twice → single dispatch', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const a1 = await (daemon as any).handleRelayAgentMsg(fwd())
    const a2 = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(a2).toEqual(a1)
    expect(calls).toHaveLength(1)
    await daemon.stop()
  })

  it('dedup namespaced by trustedFromAgentId: same deliveryId from DIFFERENT callers → BOTH dispatched (no cross-daemon collision)', async () => {
    // deliveryId is only unique within one SOURCE daemon (`String(Date.now())`); two
    // different source daemons/callers can mint the same value. A bare-deliveryId key
    // would drop the second forward. Key by the globally-unique caller agentId instead.
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // Snapshot with a second caller bot-c (a different source daemon d3) who may call bot-b.
    ;(daemon as any).cpCollab.replace({
      generation: 1,
      channels: [
        {
          orgId: ORG,
          platform: 'slack',
          channelId: 'C1',
          agents: [
            {
              agentId: 'bot-a',
              daemonId: 'd1',
              integrationId: undefined,
              callPolicy: 'all',
              allowedCallerAgentIds: []
            },
            {
              agentId: 'bot-c',
              daemonId: 'd3',
              integrationId: undefined,
              callPolicy: 'all',
              allowedCallerAgentIds: []
            },
            { agentId: 'bot-b', daemonId: 'd2', integrationId: undefined, callPolicy: 'all', allowedCallerAgentIds: [] }
          ]
        }
      ]
    })

    // Same deliveryId 'dup' but different trusted callers → distinct, both delivered.
    const fromA = await (daemon as any).handleRelayAgentMsg(fwd({ deliveryId: 'dup', trustedFromAgentId: 'bot-a' }))
    const fromC = await (daemon as any).handleRelayAgentMsg(fwd({ deliveryId: 'dup', trustedFromAgentId: 'bot-c' }))
    expect(fromA.delivered).toBe(true)
    expect(fromC.delivered).toBe(true)
    expect(calls).toHaveLength(2) // NOT collapsed into one — the collision is fixed

    // A genuine retransmit (same caller + same deliveryId) IS still deduped.
    const retransmit = await (daemon as any).handleRelayAgentMsg(
      fwd({ deliveryId: 'dup', trustedFromAgentId: 'bot-a' })
    )
    expect(retransmit).toEqual(fromA)
    expect(calls).toHaveLength(2) // no third dispatch
    await daemon.stop()
  })
})

/**
 * SessionTarget reply (session-concept §5.2/§5.3): `sendMessage({sessionId})` → the daemon's
 * `replyToSession`. Authorization is ORIGIN-ONLY and fail-closed: a caller may only reply into
 * the exact origin its CURRENT turn was woken from (its active-turn `CallMeta.originSessionId`).
 * These drive the internal method directly (dispatch stubbed) like the messageAgent tests.
 */
describe('replyToSession: SessionTarget delivery + origin-only authorization', () => {
  /** Seed the replier's active-turn trusted CallMeta so replyToSession has an origin to check. */
  const armTurn = (daemon: any, callerKey: string, callMeta: Record<string, unknown>) =>
    daemon.activeTurnCallMeta.set(callerKey, callMeta)

  const replyReq = (over: Record<string, unknown> = {}) => ({
    callerAgentId: 'bot-b',
    platform: 'slack',
    callerChannel: 'C2',
    callerThread: '200.1',
    sessionId: 'sid-parent-1',
    text: 'result: done',
    ...over
  })

  it('refuses (not_authorized) a root/human turn with no active call metadata', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const res = await (daemon as any).collab.replyToSession(replyReq())
    expect(res).toEqual({ delivered: false, reason: 'not_authorized' })
    expect(calls).toHaveLength(0) // nothing dispatched into any session
    await daemon.stop()
  })

  it('refuses (not_authorized) a sessionId that is not the caller turn’s origin', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })
    const res = await (daemon as any).collab.replyToSession(replyReq({ sessionId: 'some-other-session' }))
    expect(res).toEqual({ delivered: false, reason: 'not_authorized' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('delivers into the local origin session and inherits the origin turn’s correlationId', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // The origin session (owner bot-a) the replier bot-b was woken from.
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'sid-parent-1',
      needsParentReply: 1
    })
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      correlationId: 'orch-1',
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })

    const res = await (daemon as any).collab.replyToSession(replyReq())
    expect(res.delivered).toBe(true)
    expect(res.targetSession).toBe('slack:C1:100.1:bot-a')
    expect(calls).toHaveLength(1)
    const { agentId, msg, callMeta } = calls[0]!
    // The reply lands as a {type:system, from:<replier>} input into the ORIGIN owner's session.
    expect(agentId).toBe('bot-a')
    expect(msg.source).toBe('agent')
    expect(msg.sender).toEqual({ id: 'bot-b', isBot: true })
    expect(msg.channel).toBe('C1')
    expect(msg.text).toBe('result: done')
    // §5.3 step 3: replying into the origin inherits the origin turn's correlationId (so a
    // main-agent's N-of-N orchestration closes) and bumps the hop count.
    expect(callMeta).toMatchObject({ callFrom: 'bot-b', correlationId: 'orch-1', hopCount: 2 })
    // send-message-routing-rework.md §7: the REPORT is what stays invisible — an injected
    // body is never published to a platform — while the resumed parent turn is ORDINARY and
    // keeps its reply connection, so a delegated result can reach the humans waiting in the
    // parent's own thread. Muting it made every report-back silent there.
    expect(msg.headless).toBeUndefined()
    const status = await (daemon as any).collab.viewSessionStatus({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: '100.1',
      sessionId: callerKey
    })
    expect(status).toMatchObject({
      reply: { requested: true, state: 'queued-for-parent' },
      nextAction: 'finish-turn-and-wait'
    })
    expect(status.message).toMatch(/next turn.*do not retry/i)
    await daemon.stop()
  })

  // #753: a reply routed back into an EXISTING webchat origin session carries that
  // session's own real conversationId (read off the session row, not re-derived through
  // coordsDecision) — unlike a fresh wake, this DOES have a live browser to post to.
  it('#753: a reply into a real webchat origin session gets a live post-only context', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const CONV = '22222222-2222-4222-8222-222222222222'
    await (daemon as any).store.upsertSession({
      key: sessionKey('webchat', CONV, `webchat:${CONV}`, 'bot-a'),
      agentId: 'bot-a',
      platform: 'webchat',
      channel: CONV,
      thread: `webchat:${CONV}`,
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'sid-parent-1',
      needsParentReply: 1
    })
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'webchat', channel: CONV }
    })
    const sendWebchatPost = vi.fn()
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost }

    const res = await (daemon as any).collab.replyToSession(replyReq())
    expect(res.delivered).toBe(true)
    expect(calls).toHaveLength(1)
    const wc = calls[0]!.webchat
    expect(wc).toMatchObject({ conversationId: CONV, initiator: 'agent' })
    expect(typeof wc.postSink).toBe('function')
    wc.postSink({
      conversationId: CONV,
      agentId: 'bot-a',
      post: { postId: 'p1', conversationId: CONV, author: { kind: 'agent', agentId: 'bot-a' }, text: 'hi', at: 1 }
    })
    expect(sendWebchatPost).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  // #753: the origin session's channel can itself be a synthetic `a2a:<agentId>` pairwise
  // session (a reply chain nested inside an earlier postless A2A call) — no browser was
  // ever watching that channel, so the reply back into it must stay post-less too.
  it('#753: a reply into a synthetic a2a origin session gets no live post context', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const SYNTHETIC = 'a2a:bot-a'
    await (daemon as any).store.upsertSession({
      key: sessionKey('webchat', SYNTHETIC, `webchat:${SYNTHETIC}`, 'bot-a'),
      agentId: 'bot-a',
      platform: 'webchat',
      channel: SYNTHETIC,
      thread: `webchat:${SYNTHETIC}`,
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'sid-parent-1',
      needsParentReply: 1
    })
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'webchat', channel: SYNTHETIC }
    })

    const res = await (daemon as any).collab.replyToSession(replyReq())
    expect(res.delivered).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.webchat).toBeUndefined()
    await daemon.stop()
  })

  it('reports a failed reply instead of queued-for-parent when local dispatch rejects admission', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'sid-parent-1',
      needsParentReply: 1
    })
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })
    ;(daemon as any).dispatch = vi.fn(
      (_agentId: string, _msg: any, _integrationId?: string, _wc?: any, _callMeta?: any, opts?: any) => {
        opts?.onAdmission?.({ accepted: false, reason: 'queue_full' })
        return Promise.reject(new Error('queue full'))
      }
    )

    const res = await (daemon as any).collab.replyToSession(replyReq())
    expect(res).toEqual({ delivered: false, targetSession: 'slack:C1:100.1:bot-a', reason: 'queue_full' })
    const status = await (daemon as any).collab.viewSessionStatus({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: '100.1',
      sessionId: callerKey
    })
    expect(status).toMatchObject({
      reply: { requested: true, state: 'failed' },
      nextAction: 'report-failure'
    })
    expect(status.message).toMatch(/delivery failed.*do not retry/i)
    await daemon.stop()
  })

  // The regression the raw-platform migration exposed: a channel-free (dream/hook) child's
  // transportScope is derived from whichever integration the spawn side picked (there is no
  // 'dream' integration to resolve, so resolution falls through to a real platform's), while
  // the child row itself is keyed with the RAW platform. The reply-transport lookup must
  // match the persisted scope across ALL integrations — a raw-platform integration filter
  // finds nothing and refuses the reply as not_found.
  it('resolves a scoped dream child’s reply transport by its persisted scope', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // The origin owner holds a real scoped Slack integration — the shape a dream wake's
    // child inherits its transportScope from. Injected post-start so no socket connects.
    const slackInteg = {
      id: 'int-slack-1',
      platform: 'slack',
      core: { mode: 'direct' },
      config: { shareable: false, botToken: 'xoxb-scope-test' }
    }
    ;(daemon as any).agents.get('bot-a').integrations.push(slackInteg)
    const scope = (daemon as any).transportScopeForIntegration(slackInteg)
    const dreamKey = sessionKey('dream', 'a2a:bot-x', 'dream-1', 'bot-a', scope)
    await (daemon as any).store.upsertSession({
      key: dreamKey,
      agentId: 'bot-a',
      platform: 'dream',
      channel: 'a2a:bot-x',
      thread: 'dream-1',
      transportScope: scope,
      acpSessionId: 'acp-parent-dream',
      sessionId: 'sid-parent-dream',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-dream',
      originCoords: { platform: 'dream', channel: 'a2a:bot-x', thread: 'dream-1' }
    })
    const res = await (daemon as any).collab.replyToSession(replyReq({ sessionId: 'sid-parent-dream' }))
    expect(res.delivered).toBe(true)
    expect(res.targetSession).toBe(dreamKey)
    expect(calls).toHaveLength(1)
    const { msg } = calls[0]!
    // The synthesized message keeps the RAW session platform; only transport resolution
    // went through the persisted-scope match.
    expect(msg.platform).toBe('dream')
    expect(msg.transportScope).toBe(scope)
    await daemon.stop()
  })

  // The fallback half of the same contract: when the target has NO Slack integration, the
  // spawn side falls back to the agent's FIRST integration (resolveAgentIntegration), so a
  // dream child of a Telegram-only target carries a `telegram:…` scope. A lookup filtered
  // under the legacy 'slack' coordinate would still find nothing — the session-transport
  // resolution must match the persisted scope across ALL of the agent's integrations.
  it('resolves a dream child’s reply transport for a Telegram-only target (first-integration fallback)', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const tgInteg = {
      id: 'int-tg-1',
      platform: 'telegram',
      config: { botToken: '12345:AAA-test-token' }
    }
    ;(daemon as any).agents.get('bot-a').integrations.push(tgInteg)
    const scope = (daemon as any).transportScopeForIntegration(tgInteg)
    expect(scope.startsWith('telegram:')).toBe(true)
    const dreamKey = sessionKey('dream', 'a2a:bot-x', 'dream-2', 'bot-a', scope)
    await (daemon as any).store.upsertSession({
      key: dreamKey,
      agentId: 'bot-a',
      platform: 'dream',
      channel: 'a2a:bot-x',
      thread: 'dream-2',
      transportScope: scope,
      acpSessionId: 'acp-parent-dream-tg',
      sessionId: 'sid-parent-dream-tg',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd2',
      originSessionId: 'sid-parent-dream-tg',
      originCoords: { platform: 'dream', channel: 'a2a:bot-x', thread: 'dream-2' }
    })
    const res = await (daemon as any).collab.replyToSession(replyReq({ sessionId: 'sid-parent-dream-tg' }))
    expect(res.delivered).toBe(true)
    expect(res.targetSession).toBe(dreamKey)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.msg.platform).toBe('dream')
    expect(calls[0]!.msg.transportScope).toBe(scope)
    await daemon.stop()
  })

  // The cross-daemon half of the same contract (§5.3): the reply rides the relay as a
  // FIRST-CLASS lineage reply — raw origin coords for admission, plus the origin's
  // acpSessionId so the target daemon dispatches into that exact session instead of
  // substituting a synthetic a2a coordinate for the channel-free platform.
  it('routes a remote reply into a channel-free origin as a lineage reply (raw coords + session id)', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    const sent: any[] = []
    ;(daemon as any).relays = {
      stop: async () => {},
      sendAgentMsg: vi.fn(async (payload: any) => {
        sent.push(payload)
        return { deliveryId: payload.deliveryId, delivered: true, childSessionId: 'dream:memory:dream-1:bot-a' }
      })
    }
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-remote-dream',
      originCoords: { platform: 'dream', channel: 'memory', thread: 'dream-1' }
    })
    const res = await (daemon as any).collab.replyToSession(replyReq({ sessionId: 'sid-remote-dream' }))
    expect(res.delivered).toBe(true)
    expect(res.targetSession).toBe('dream:memory:dream-1:bot-a')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      toAgentId: 'bot-a',
      coords: { platform: 'dream', channel: 'memory', thread: 'dream-1' },
      lineageReplyTo: 'sid-remote-dream'
    })
    await daemon.stop()
  })

  it('authorizes via the caller session’s PERSISTED origin on a human turn with no active CallMeta', async () => {
    // The regression that "replies once then stops": a spawned session's later, human-triggered
    // turns carry no per-turn CallMeta, so auth must fall back to the DURABLE origin on the row.
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // Origin (parent) session, owner bot-a.
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    // The replier's OWN session, spawned earlier with a durable parent link persisted on the row.
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C2', '200.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'sid-parent-1'
    })
    // NO armTurn: activeTurnCallMeta is empty for the caller (a human-triggered follow-up turn).
    const res = await (daemon as any).collab.replyToSession(replyReq())
    expect(res.delivered).toBe(true)
    expect(res.targetSession).toBe('slack:C1:100.1:bot-a')
    expect(calls).toHaveLength(1)
    // No inbound depth on a human turn ⇒ the reply chain starts at hop 1; callFrom = the replier.
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-b', hopCount: 1 })
    await daemon.stop()
  })

  it('marks a cross-daemon reply session-reply, and surfaces a refusal instead of misrouting it', async () => {
    // send-message-routing-rework.md §8.3/§8.4. A parent on another daemon must be resumed
    // through the same path as a local one, so the delivery carries its KIND; a relay that
    // finds the target too old answers `unsupported`, which the caller sees as a failed
    // reply rather than as one quietly dispatched into some other session.
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    ;(daemon as any).activeTurnCallMeta.set(callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })
    // No local row for `acp-parent-1` ⇒ the origin lives on another daemon.
    const sendAgentMsg = vi.fn(async (payload: any) => ({
      deliveryId: payload.deliveryId,
      delivered: false,
      reason: 'unsupported' as const
    }))
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendAgentMsg }

    const res = await (daemon as any).collab.replyToSession(replyReq())
    expect(sendAgentMsg).toHaveBeenCalledTimes(1)
    expect(sendAgentMsg.mock.calls[0]![0]).toMatchObject({ deliveryKind: 'session-reply' })
    expect(res).toMatchObject({ delivered: false, reason: 'unsupported' })
    await daemon.stop()
  })
})

/**
 * Case 2a spawn (session-concept §7.2): an agent's channel-ROOT post seeds a NEW session owned
 * by the same agent, keyed by the post's ts, initialized without a model turn and with origin
 * lineage. The post's real ts is retained as `transcriptTs` so the transcript row is canonical;
 * the session cursor deliberately remains null until the first real reply consumes the root.
 */
describe('spawnChannelRootSession — case 2a new-session seed', () => {
  it('dispatches an initialization-only, origin-tagged seed keyed by the post ts', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // Seed the origin (current) session so its acpSessionId becomes the child's originSessionId.
    const originKey = sessionKey('slack', 'C1', '100.1', 'bot-a')
    await (daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-origin-1',
      sessionId: 'sid-origin-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    await (daemon as any).collab.spawnChannelRootSession({
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-a',
      channel: 'C1',
      thread: '1784297789.871789', // the root post's ts → the new session's thread
      postTs: '1784297789.871789',
      text: 'root spawn 🌿',
      originChannel: 'C1',
      originThread: '100.1'
    })

    expect(calls).toHaveLength(1)
    const { agentId, msg, callMeta } = calls[0]!
    expect(agentId).toBe('bot-a')
    expect(msg.thread).toBe('1784297789.871789')
    // THE dedup fix: transcript ts is the post's real Slack ts, not the random deliveryId.
    expect(msg.transcriptTs).toBe('1784297789.871789')
    expect(msg.headless).toBe(true)
    expect(msg.source).toBe('agent')
    expect(msg.text).toBe('root spawn 🌿')
    expect(callMeta).toMatchObject({
      callFrom: 'bot-a',
      hopCount: 1,
      initializeOnly: true,
      originSessionId: 'sid-origin-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })
    await daemon.stop()
  })

  it('creates an idle session without prompting the model', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const host = fakeHost()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => host as any })
    await daemon.start()
    const targetKey = sessionKey('slack', 'C1', '1784297789.871789', 'bot-a')

    await (daemon as any).collab.spawnChannelRootSession({
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-a',
      channel: 'C1',
      thread: '1784297789.871789',
      postTs: '1784297789.871789',
      text: 'root spawn 🌿',
      originChannel: 'C1',
      originThread: '100.1'
    })

    await vi.waitFor(async () => {
      const created = await (daemon as any).store.getSession(targetKey)
      expect(created).toMatchObject({ acpSessionId: 'acp-1', state: 'idle', lastDeliveredTs: null })
      // The daemon mints the outward id itself, and it is never the runtime's (§1.1).
      expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    }, WAIT)
    expect(host.newSession).toHaveBeenCalledOnce()
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('keys a Feishu spawn as feishu, not a folded fallback', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // The since-deleted `narrowPlatform` helper predated Feishu and folded it onto `slack`, so
    // this dispatched a `slack:` message for a channel Feishu ingress records under `feishu:` —
    // a session nothing could continue. Every caller of that helper had the same hole.
    // A Feishu DM root post, the shape where the key and the raw ts differ most: ops resolves the
    // thread key to the CHAT id (what Feishu ingress keys a p2p conversation under) while the
    // post's own message id stays the transcript ts.
    await (daemon as any).collab.spawnChannelRootSession({
      agentId: 'bot-a',
      platform: 'feishu',
      channel: 'oc_42',
      thread: 'oc_42',
      postTs: 'om_900',
      text: 'posted into a Feishu chat',
      originPlatform: 'feishu',
      originChannel: 'oc_42',
      originThread: 'om_1'
    })

    expect(calls).toHaveLength(1)
    const { msg } = calls[0]!
    // End-to-end through the real handler, not a stubbed callback: the dispatched message is what
    // the session is keyed on, so `slack` here would key `slack:oc_42:oc_42` for a conversation
    // Feishu ingress records under `feishu:oc_42:oc_42` — the same post, two logical sessions.
    expect(msg.platform).toBe('feishu')
    expect(msg.thread).toBe('oc_42')
    expect(msg.transcriptTs).toBe('om_900')
    expect(sessionKey(msg.platform, msg.channel, msg.thread!, 'bot-a')).toBe('feishu:oc_42:oc_42:bot-a')
    await daemon.stop()
  })

  it('resolves the origin session across platforms (Telegram turn → Slack post keeps the parent)', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // The current turn runs in a TELEGRAM session; the agent posts to a SLACK channel. The
    // origin lookup must key by the origin's platform (telegram), not the post's (slack).
    const originKey = sessionKey('telegram', '-100999', 'tg:52', 'bot-a')
    await (daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100999',
      thread: 'tg:52',
      acpSessionId: 'acp-tg-origin',
      sessionId: 'sid-tg-origin',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    await (daemon as any).collab.spawnChannelRootSession({
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-a',
      channel: 'C-AI-PLAYGROUND',
      thread: '1784381296.193959',
      postTs: '1784381296.193959',
      text: 'hello from telegram',
      originPlatform: 'telegram',
      originChannel: '-100999',
      originThread: 'tg:52'
    })

    expect(calls).toHaveLength(1)
    const { callMeta } = calls[0]!
    // Regression: pre-fix the origin key used the target platform (slack), missed the telegram
    // session, and the new Slack session was seeded with no parent (originSessionId undefined).
    expect(callMeta).toMatchObject({
      callFrom: 'bot-a',
      hopCount: 1,
      originSessionId: 'sid-tg-origin',
      originCoords: { platform: 'telegram', channel: '-100999', thread: 'tg:52' }
    })
    await daemon.stop()
  })

  it('seeds the caller-supplied thread key while the transcript keeps the raw platform ts', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)

    // A Slack turn posting into a Telegram group: postMessage returned the bare message id
    // '172', which ops.ts converts to the canonical `tg:172` (threadKeyForPost) before calling
    // here — the two are separate fields precisely because they differ on Telegram.
    await (daemon as any).collab.spawnChannelRootSession({
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:172',
      postTs: '172',
      text: 'answer relayed to the customer',
      originPlatform: 'slack',
      originChannel: 'C1',
      originThread: '100.1'
    })

    expect(calls).toHaveLength(1)
    const { msg } = calls[0]!
    expect(msg.thread).toBe('tg:172')
    // The transcript seed keeps the RAW platform ts — it must stay comparable with
    // later real reply ts values (see the dedup note in spawnChannelRootSession).
    expect(msg.transcriptTs).toBe('172')
    await daemon.stop()
  })
})

/**
 * `rootPostRelation` — whether a channel-ROOT post landed on a conversation the posting session
 * is already part of, which is what lets `sendMessage` say it forked one instead of answering it.
 * The durable parent link is the load-bearing half: an agent relays an answer on a human-triggered
 * turn, which carries no CallMeta at all.
 */
describe('rootPostRelation: did this post fork a conversation we are already in', () => {
  const seed = async (daemon: any, over: Record<string, unknown>) =>
    await daemon.store.upsertSession({
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      ...over
    })
  const ask = (daemon: any, over: Record<string, unknown> = {}) =>
    daemon.collab.rootPostRelation({
      callerAgentId: 'bot-b',
      platform: 'slack',
      callerChannel: 'C2',
      callerThread: '200.1',
      targetPlatform: 'telegram',
      targetChannel: '-100123',
      // The post's own thread key. A root post in a Telegram GROUP opens one of its own, which is
      // what makes it a fork; the continuous-conversation platforms are covered below.
      targetThread: 'tg:900',
      ...over
    })

  it('finds the parent through the persisted link when the turn has no CallMeta', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    // The parent conversation — a Telegram customer chat owned by ANOTHER agent, which is the
    // ordinary escalation shape: whoever asked is not whoever answers.
    await seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:170', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:170',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1'
    })
    await seed(daemon, {
      key: sessionKey('slack', 'C2', '200.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-parent-1'
    })

    expect(await ask(daemon)).toEqual({ kind: 'parent', sessionId: 'sid-parent-1' })
    // A post somewhere else is an ordinary new topic, not a fork.
    expect(await ask(daemon, { targetChannel: '-100999' })).toBeUndefined()
    // The caller's OWN conversation, which its turn reply already reaches.
    expect(await ask(daemon, { targetPlatform: 'slack', targetChannel: 'C2' })).toEqual({ kind: 'self' })
    await daemon.stop()
  })

  it('resolves a Feishu caller by its raw platform string', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    // The since-deleted `narrowPlatform` fold turned `feishu` into `slack`; keying the lookup
    // through it looked up a row that never existed, so a Feishu session could never resolve
    // its parent.
    await seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:170', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:170',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1'
    })
    await seed(daemon, {
      key: sessionKey('feishu', 'oc_42', 'om_1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'feishu',
      channel: 'oc_42',
      thread: 'om_1',
      acpSessionId: 'acp-child-feishu',
      sessionId: 'sid-child-feishu',
      originSessionId: 'sid-parent-1'
    })

    expect(await ask(daemon, { platform: 'feishu', callerChannel: 'oc_42', callerThread: 'om_1' })).toEqual({
      kind: 'parent',
      sessionId: 'sid-parent-1'
    })
    await daemon.stop()
  })

  it('treats the same channel id under a different bot as a different conversation', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    // Channel ids are only unique within one physical bot (Telegram DMs reuse the user's id
    // across bots), so identity has to include the transport scope on both sides. The parent
    // here lives under one bot's scope; the post goes out on a channel id that merely LOOKS the
    // same, so comparing raw platform+channel would mislabel it as the parent's conversation.
    await seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:170', 'bot-a', 'scope-bot-1'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:170',
      transportScope: 'scope-bot-1',
      acpSessionId: 'acp-parent-scoped',
      sessionId: 'sid-parent-scoped'
    })
    await seed(daemon, {
      key: sessionKey('slack', 'C2', '200.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-parent-scoped'
    })
    expect(await ask(daemon)).toBeUndefined()

    // Control: an unscoped parent on the same coords IS the conversation the post landed on, so
    // the silence above is the scope doing the work and not a broken lookup.
    await seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:171', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:171',
      acpSessionId: 'acp-parent-unscoped',
      sessionId: 'sid-parent-unscoped'
    })
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C3', '300.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C3',
      thread: '300.1',
      acpSessionId: 'acp-child-2',
      sessionId: 'sid-child-2',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'sid-parent-unscoped'
    })
    expect(await ask(daemon, { callerChannel: 'C3', callerThread: '300.1' })).toEqual({
      kind: 'parent',
      sessionId: 'sid-parent-unscoped'
    })
    await daemon.stop()
  })

  it('answers for a CROSS-DAEMON parent, which has no local row to read', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    await seed(daemon, {
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1'
    })
    // Woken over the relay: the parent session lives on another daemon, so `getSessionByAcpId`
    // finds nothing and only the trusted wake carries its coords. Requiring a row here made the
    // notice silent for exactly the escalation shape the relay exists to serve.
    ;(daemon as any).activeTurnCallMeta.set(callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-remote-parent',
      originCoords: { platform: 'telegram', channel: '-100123', thread: 'tg:9' }
    })
    expect(await ask(daemon)).toEqual({ kind: 'parent', sessionId: 'sid-remote-parent' })
    // Still only for the conversation it actually names.
    expect(await ask(daemon, { targetChannel: '-100999' })).toBeUndefined()
    // Matching is coordinates-only here BY DESIGN — the remote scope is credential-derived and
    // never crosses the wire — so a target integration's own scope does not suppress the match.
    // Over-matching costs a hint naming the caller's real parent; silence would cost the hint
    // entirely on the cross-daemon escalation path.
    expect(await ask(daemon, { targetIntegrationId: 'int-tg-1' })).toEqual({
      kind: 'parent',
      sessionId: 'sid-remote-parent'
    })
    await daemon.stop()
  })

  it('says nothing where a root post cannot fork: Telegram / Feishu DMs', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    // These platforms have no separate thread for a root post to open: threadKeyForPost maps it
    // back onto the continuous conversation, so the message LANDS in it. A fork notice there
    // would tell an agent its answer went nowhere when the reader already has it — and talk it
    // into sending a second copy.
    const continuous = [
      { platform: 'telegram', channel: '777', thread: 'dm' },
      { platform: 'feishu', channel: 'oc_42', thread: 'oc_42' }
    ]

    for (const [i, conv] of continuous.entries()) {
      const parentId = `acp-parent-continuous-${i}`
      await seed(daemon, {
        key: sessionKey(conv.platform, conv.channel, conv.thread, 'bot-a'),
        agentId: 'bot-a',
        platform: conv.platform,
        channel: conv.channel,
        thread: conv.thread,
        acpSessionId: parentId
      })
      const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
      await seed(daemon, {
        key: callerKey,
        agentId: 'bot-b',
        platform: 'slack',
        channel: 'C2',
        thread: '200.1',
        acpSessionId: 'acp-child-1',
        sessionId: 'sid-child-1',
        originSessionId: parentId
      })

      const target = { targetPlatform: conv.platform, targetChannel: conv.channel, targetThread: conv.thread }
      // Parent: the answer reached the waiting conversation, so there is nothing to say.
      expect(await ask(daemon, target)).toBeUndefined()
      // Self: the same, from inside that conversation's own session.
      expect(
        await ask(daemon, {
          ...target,
          callerAgentId: 'bot-a',
          platform: conv.platform,
          callerChannel: conv.channel,
          callerThread: conv.thread
        })
      ).toBeUndefined()
    }
    await daemon.stop()
  })

  it('prefers the live turn’s origin, and reports nothing for a session with no parent', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    await seed(daemon, {
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1'
    })
    // No parent link anywhere ⇒ a post into an unrelated channel relates to nothing.
    expect(await ask(daemon)).toBeUndefined()

    // A live wake names its own origin, matching the precedence replyToSession authorizes on.
    await seed(daemon, {
      key: sessionKey('telegram', '-100999', 'tg:9', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100999',
      thread: 'tg:9',
      acpSessionId: 'acp-parent-2',
      sessionId: 'sid-parent-2'
    })
    ;(daemon as any).activeTurnCallMeta.set(callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-2',
      originCoords: { platform: 'telegram', channel: '-100999', thread: 'tg:9' }
    })
    expect(await ask(daemon, { targetChannel: '-100999' })).toEqual({ kind: 'parent', sessionId: 'sid-parent-2' })
    await daemon.stop()
  })
})

/**
 * `viewSessionStatus` (the read counterpart of a SessionTarget reply): a parent may read DOWN its
 * own lineage, a child may reply UP it, and neither can reach sideways. Authorization comes from
 * the child's durable `originSessionId`, with an in-memory link covering the window before the
 * child's session row exists. These drive the internal method directly, like the tests above.
 */
describe('viewSessionStatus: child-only authorization + status collapse', () => {
  const PARENT_KEY = sessionKey('slack', 'C1', '100.1', 'bot-a')
  const CHILD_KEY = sessionKey('slack', 'C1', '100.1', 'bot-b')

  const seedSession = async (daemon: any, key: string, over: Record<string, unknown> = {}) => {
    const [platform, channel, thread, agentId] = key.split(':')
    await daemon.store.upsertSession({
      key,
      agentId,
      platform,
      channel,
      thread,
      acpSessionId: `acp-${agentId}`,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000,
      ...over
    })
  }

  const ask = (
    daemon: any,
    sessionId: string,
    caller: { agentId: string; channel: string; thread: string; transportScope?: string } = {
      agentId: 'bot-a',
      channel: 'C1',
      thread: '100.1'
    }
  ) =>
    daemon.collab.viewSessionStatus({
      callerAgentId: caller.agentId,
      platform: 'slack',
      callerChannel: caller.channel,
      callerThread: caller.thread,
      ...(caller.transportScope !== undefined ? { callerTransportScope: caller.transportScope } : {}),
      sessionId
    })

  it('reports a child woken by this session, keyed by the childSessionId sendMessage returned', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, {
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting'
    })

    const res = await call(baseReq({ needsReply: true }))
    expect(res.delivered).toBe(true)
    // Polled the instant the wake returns: dispatch is fire-and-forget, so the child's session row
    // does not exist yet — the admission-time link must still authorize the parent.
    expect(await ask(daemon, res.targetSession)).toEqual({
      sessionId: res.targetSession,
      agentId: 'bot-b',
      status: 'in-progress',
      state: 'starting',
      reply: { requested: true, state: 'awaiting' },
      nextAction: 'finish-turn-and-wait',
      message:
        'Message delivered; the agent is still working. End this turn and wait for its reply; do not retry or poll tightly.'
    })
    await daemon.stop()
  })

  it.each([
    { state: 'prompting', outcome: null, status: 'in-progress' },
    { state: 'resuming', outcome: null, status: 'in-progress' },
    { state: 'cancelling', outcome: 'done', status: 'in-progress' },
    { state: 'idle', outcome: 'done', status: 'done' },
    { state: 'closed', outcome: 'done', status: 'done' },
    { state: 'idle', outcome: 'failed', status: 'failed' },
    // Open but no turn has finished yet: never report `done` off an unrecorded outcome.
    { state: 'idle', outcome: null, status: 'in-progress' }
  ])('collapses state=$state + outcome=$outcome to $status', async ({ state, outcome, status }) => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', sessionId: 'sid-parent-1' })
    await seedSession(daemon, CHILD_KEY, {
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state,
      originSessionId: 'sid-parent-1'
    })
    if (outcome) await (daemon as any).store.setSessionTurnOutcome(CHILD_KEY, outcome, 2_000)

    expect(await ask(daemon, CHILD_KEY)).toMatchObject({ agentId: 'bot-b', status, state })
    await daemon.stop()
  })

  // ACP ids are minted per runtime and are NOT unique across agents, so accepting one would make
  // the status read ambiguous. Only the logical key `sendMessage` returned is addressable.
  it('refuses the child’s ACP session id — only the returned logical key is addressable', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', sessionId: 'sid-parent-1' })
    await seedSession(daemon, CHILD_KEY, {
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-parent-1'
    })
    await (daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'done', 2_000)

    expect((await ask(daemon, CHILD_KEY))?.status).toBe('done')
    expect(await ask(daemon, 'acp-child-1')).toBeNull()
    await daemon.stop()
  })

  // Review finding 3: the row still reads `idle` + the PREVIOUS turn's outcome until
  // SessionManager flips it to `prompting`, so a re-delegating parent must not be handed `done`.
  it('reports in-progress for a re-wake of an already-finished child, not its old outcome', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, {
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting'
    })
    await seedSession(daemon, CHILD_KEY, {
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-parent-1'
    })
    await (daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'done', 2_000)
    // Before the re-wake the parent legitimately sees the finished first delegation.
    expect((await ask(daemon, CHILD_KEY))?.status).toBe('done')

    const res = await call(baseReq())
    expect(res.targetSession).toBe(CHILD_KEY)
    // dispatch is stubbed here, so the row is still exactly as it was — precisely the window the
    // admission snapshot has to cover.
    expect((await ask(daemon, CHILD_KEY))?.status).toBe('in-progress')
    await daemon.stop()
  })

  it('refuses a session this caller did not start (a sibling with a different parent)', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', sessionId: 'sid-parent-1' })
    await seedSession(daemon, CHILD_KEY, {
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-someone-else'
    })

    expect(await ask(daemon, CHILD_KEY)).toBeNull()
    await daemon.stop()
  })

  it('refuses a root session with no parent at all', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', sessionId: 'sid-parent-1' })
    await seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', sessionId: 'sid-child-1' })

    expect(await ask(daemon, CHILD_KEY)).toBeNull()
    await daemon.stop()
  })

  it('refuses the caller’s OWN session — a session is not its own child', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', sessionId: 'sid-parent-1' })

    expect(await ask(daemon, PARENT_KEY)).toBeNull()
    expect(await ask(daemon, 'acp-parent-1')).toBeNull()
    await daemon.stop()
  })

  it('refuses an unknown session id, and a known child asked for by a DIFFERENT session', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', sessionId: 'sid-parent-1' })
    await seedSession(daemon, CHILD_KEY, {
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-parent-1'
    })
    // bot-b's own session in another thread: a real session, but not this child's parent.
    const otherKey = sessionKey('slack', 'C1', '999.9', 'bot-b')
    await seedSession(daemon, otherKey, { acpSessionId: 'acp-other-1', sessionId: 'sid-other-1' })

    expect(await ask(daemon, 'no-such-session')).toBeNull()
    expect(await ask(daemon, CHILD_KEY, { agentId: 'bot-b', channel: 'C1', thread: '999.9' })).toBeNull()
    await daemon.stop()
  })

  // A caller whose session is scoped to a physical bot keys its row with the 5th `sessionKey`
  // segment. The lineage lookup must carry that scope, or the parent's own session is never found
  // and every read is (fail-closed but wrongly) refused.
  it('finds the caller’s own session when it is transportScope-keyed', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    const scopedParent = sessionKey('slack', 'C1', '100.1', 'bot-a', 'bot-scope-1')
    await (daemon as any).store.upsertSession({
      key: scopedParent,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      transportScope: 'bot-scope-1',
      acpSessionId: 'acp-parent-scoped',
      sessionId: 'sid-parent-scoped',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    await seedSession(daemon, CHILD_KEY, {
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-parent-scoped'
    })
    await (daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'done', 2_000)

    const caller = { agentId: 'bot-a', channel: 'C1', thread: '100.1', transportScope: 'bot-scope-1' }
    expect((await ask(daemon, CHILD_KEY, caller))?.status).toBe('done')
    // …and the unscoped caller coords are a DIFFERENT session, which is not this child's parent.
    expect(await ask(daemon, CHILD_KEY)).toBeNull()
    await daemon.stop()
  })

  it('refuses every read from a caller that has no session of its own', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    // A child whose parent link is absent must not match an absent caller session id.
    await seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', sessionId: 'sid-child-1' })

    expect(await ask(daemon, CHILD_KEY)).toBeNull()
    await daemon.stop()
  })
})

/**
 * §5.4 cross-daemon status: a remote wake is still a followable child. The parent daemon has no way
 * to address the owning daemon, so it asks the CP (the placement authority), which forwards the
 * lineage pair. These drive both legs directly.
 */
describe('viewSessionStatus: cross-daemon children', () => {
  const PARENT_KEY = sessionKey('slack', 'C1', '100.1', 'bot-a')

  const seedParent = async (daemon: any) =>
    await (daemon as any).store.upsertSession({
      key: PARENT_KEY,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })

  const withRelay = (daemon: any, delivered = true) =>
    ((daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (p: any) => ({ deliveryId: p.deliveryId, delivered }))
    })

  const ask = (daemon: any, sessionId: string) =>
    (daemon as any).collab.viewSessionStatus({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: '100.1',
      sessionId
    })

  it('asks the CP for a child admitted on another daemon, and maps the answer', async () => {
    const root = scaffold([{ id: 'bot-a' }]) // bot-b is remote
    const { daemon, call } = await bootWithDispatchSpy(root)
    await seedParent(daemon)
    withRelay(daemon)
    const asks: any[] = []
    ;(daemon as any).cpClient = {
      stop: vi.fn(async () => {}),
      childSessionStatus: async (req: any) => {
        asks.push(req)
        return { found: true, agentId: 'bot-b', status: 'done', state: 'idle', updatedAt: 9 }
      }
    }

    const res = await call(baseReq({ toAgentId: 'bot-b' }))
    expect(res.delivered).toBe(true)
    expect(await ask(daemon, res.targetSession)).toEqual({
      sessionId: res.targetSession,
      agentId: 'bot-b',
      status: 'done',
      state: 'idle',
      updatedAt: 9,
      reply: { requested: false, state: 'not-requested' },
      nextAction: 'none',
      message: 'The child turn finished cleanly. No reply was requested.'
    })
    // The CP needs the child AGENT to resolve placement — it must not parse the composite key.
    expect(asks[0]).toEqual({
      parentSessionId: 'sid-parent-1',
      childSessionId: res.targetSession,
      childAgentId: 'bot-b'
    })
    await daemon.stop()
  })

  it('does not track a remote child whose wake was REFUSED — nothing was opened', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    await seedParent(daemon)
    withRelay(daemon, false)
    ;(daemon as any).cpClient = {
      stop: vi.fn(async () => {}),
      childSessionStatus: async () => {
        throw new Error('must not ask the CP about a child that was never admitted')
      }
    }

    const res = await call(baseReq({ toAgentId: 'bot-b' }))
    expect(res.delivered).toBe(false)
    expect(await ask(daemon, res.targetSession)).toBeNull()
    await daemon.stop()
  })

  it('surfaces an unreachable owning daemon and a disconnected CP as retryable errors, not denials', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    await seedParent(daemon)
    withRelay(daemon)
    ;(daemon as any).cpClient = {
      stop: vi.fn(async () => {}),
      childSessionStatus: async () => ({ found: false, reason: 'offline' })
    }
    const res = await call(baseReq({ toAgentId: 'bot-b' }))

    await expect(ask(daemon, res.targetSession)).rejects.toThrow(/not currently reachable/)
    // A `found:false` WITHOUT a transport reason is the lineage verdict — that one is a plain null.
    ;(daemon as any).cpClient = { stop: vi.fn(async () => {}), childSessionStatus: async () => ({ found: false }) }
    expect(await ask(daemon, res.targetSession)).toBeNull()
    // No CP at all: degraded mode cannot answer a cross-daemon question.
    ;(daemon as any).cpClient = undefined
    await expect(ask(daemon, res.targetSession)).rejects.toThrow(/control plane is disconnected/)
    await daemon.stop()
  })

  it('refuses a remote child to a session that did not wake it', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    await seedParent(daemon)
    withRelay(daemon)
    ;(daemon as any).cpClient = {
      stop: vi.fn(async () => {}),
      childSessionStatus: async () => {
        throw new Error('must not reach the CP for an unauthorized caller')
      }
    }
    const res = await call(baseReq({ toAgentId: 'bot-c' })) // remote (not scaffolded locally)
    expect(res.delivered).toBe(true)

    // bot-b has its own session in the same channel but never woke this child.
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '777.7', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '777.7',
      acpSessionId: 'acp-other',
      sessionId: 'sid-other',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const asOther = await (daemon as any).collab.viewSessionStatus({
      callerAgentId: 'bot-b',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: '777.7',
      sessionId: res.targetSession
    })
    expect(asOther).toBeNull()
    await daemon.stop()
  })
})

/**
 * The child handle a remote wake returns must identify the target's ACTUAL row. The owning daemon's
 * key includes a transport scope derived from the reply integration the RELAY picked, which the
 * source never sees — so the canonical key rides back on the admission ACK.
 */
describe('viewSessionStatus: remote child handle identity', () => {
  it('returns the canonical key from the ACK, not the source’s unscoped guess', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const CANON = 'slack:C1:100.1:bot-b:slack:scopehash'
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (p: any) => ({ deliveryId: p.deliveryId, delivered: true, childSessionId: CANON }))
    }
    const asks: any[] = []
    ;(daemon as any).cpClient = {
      stop: vi.fn(async () => {}),
      childSessionStatus: async (req: any) => {
        asks.push(req)
        return { found: true, agentId: 'bot-b', status: 'in-progress', state: 'prompting', updatedAt: 3 }
      }
    }

    const res = await call(baseReq({ toAgentId: 'bot-b' }))
    // The transport-scoped key the TARGET computed is what the agent gets and what it can follow.
    expect(res.targetSession).toBe(CANON)
    expect(
      (
        await (daemon as any).collab.viewSessionStatus({
          callerAgentId: 'bot-a',
          platform: 'slack',
          callerChannel: 'C1',
          callerThread: '100.1',
          sessionId: CANON
        })
      )?.status
    ).toBe('in-progress')
    expect(asks[0].childSessionId).toBe(CANON)
    await daemon.stop()
  })

  it('falls back to the locally-derived key when an older target returns none', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (p: any) => ({ deliveryId: p.deliveryId, delivered: true }))
    }
    const res = await call(baseReq({ toAgentId: 'bot-b' }))
    expect(res.targetSession).toBe('slack:C1:100.1:bot-b')
    await daemon.stop()
  })
})

/** The TARGET side of a remote wake: it must compute the canonical key, record the admission link
 *  before ACKing, and answer a probe that lands before SessionManager creates the row. */
describe('handleRelayAgentMsg: admission handle + pre-row probe window', () => {
  const ORG = '00000000-0000-0000-0000-0000000000a1'

  it('returns a canonical childSessionId on the ACK and answers a probe before the row exists', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    ;(daemon as any).cpCollab.replace({
      generation: 1,
      channels: [
        {
          orgId: ORG,
          platform: 'slack',
          channelId: 'C1',
          agents: [
            {
              agentId: 'bot-a',
              daemonId: 'd1',
              callPolicy: 'all',
              allowedCallerAgentIds: [],
              outboundPolicy: 'all',
              allowedTargetAgentIds: []
            },
            {
              agentId: 'bot-b',
              daemonId: 'd2',
              callPolicy: 'all',
              allowedCallerAgentIds: [],
              outboundPolicy: 'all',
              allowedTargetAgentIds: []
            }
          ]
        }
      ]
    })

    const ack = await (daemon as any).handleRelayAgentMsg({
      trustedFromAgentId: 'bot-a',
      orgId: ORG,
      toAgentId: 'bot-b',
      text: '@caller: do it',
      coords: { platform: 'slack', channel: 'C1', thread: '100.1' },
      hopCount: 1,
      deliveryId: 'd-canon-1',
      originSessionId: 'sid-remote-parent'
    })
    expect(ack.delivered).toBe(true)
    // dispatch is stubbed, so no row exists yet — the ACK handle plus the admission link are all
    // the owning daemon has, and a probe must still be answerable and authorized.
    expect(ack.childSessionId).toBe('slack:C1:100.1:bot-b')
    expect(await (daemon as any).store.getSession(ack.childSessionId)).toBeUndefined()
    expect(
      await (daemon as any).collab.childSessionStatusProbe({
        parentSessionId: 'sid-remote-parent',
        childSessionId: ack.childSessionId
      })
    ).toEqual({
      found: true,
      agentId: 'bot-b',
      status: 'in-progress',
      state: 'starting',
      reply: { requested: false, state: 'not-requested' },
      nextAction: 'wait',
      message: 'Message delivered; the agent is still working. No reply was requested.'
    })
    // …and only to the parent that actually woke it.
    expect(
      await (daemon as any).collab.childSessionStatusProbe({
        parentSessionId: 'sid-someone-else',
        childSessionId: ack.childSessionId
      })
    ).toEqual({ found: false })
    await daemon.stop()
  })
})

/** The OWNING side of a §5.4 status read: the lineage rule is re-enforced where the session lives. */
describe('childSessionStatusProbe: owning-daemon authorization', () => {
  const CHILD_KEY = sessionKey('slack', 'C1', '100.1', 'bot-b')

  const seedChild = async (daemon: any, over: Record<string, unknown> = {}) =>
    await (daemon as any).store.upsertSession({
      key: CHILD_KEY,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000,
      ...over
    })

  it('answers with the collapsed status when the child’s origin matches the claimed parent', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedChild(daemon, { originSessionId: 'sid-remote-parent' })
    await (daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'failed', 2_000)

    expect(
      await (daemon as any).collab.childSessionStatusProbe({
        parentSessionId: 'sid-remote-parent',
        childSessionId: CHILD_KEY
      })
    ).toMatchObject({ found: true, agentId: 'bot-b', status: 'failed', state: 'idle' })
    await daemon.stop()
  })

  it('refuses a mismatched parent, a parentless child, and an unknown session — all as found:false', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    await seedChild(daemon, { originSessionId: 'sid-remote-parent' })

    const probe = async (parentSessionId: string, childSessionId = CHILD_KEY) =>
      await (daemon as any).collab.childSessionStatusProbe({ parentSessionId, childSessionId })
    // A CP that forwarded a wrong/forged parent still cannot read the child.
    expect(await probe('acp-someone-else')).toEqual({ found: false })
    expect(await probe('acp-remote-parent', 'slack:C1:999.9:nobody')).toEqual({ found: false })

    // A parentless (root) child: originSessionId is first-wins in the store, so this needs a key
    // that was never given an origin rather than a re-seed with null.
    const rootKey = sessionKey('slack', 'C1', '555.5', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: rootKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '555.5',
      acpSessionId: 'acp-root-1',
      sessionId: 'sid-root-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    expect(await probe('acp-remote-parent', rootKey)).toEqual({ found: false })
    await daemon.stop()
  })
})

/** A logical child can be woken by more than one parent; BOTH may follow it (§5.4). */
describe('viewSessionStatus: a reused child is readable by the current waking parent', () => {
  it('authorizes the most recent waker as well as the durable first parent', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }, { id: 'bot-c' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    const CHILD = sessionKey('slack', 'C1', '100.1', 'bot-b')
    // The child already exists with parent A as its DURABLE origin.
    await (daemon as any).store.upsertSession({
      key: CHILD,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000,
      originSessionId: 'sid-parent-a'
    })
    await (daemon as any).store.setSessionTurnOutcome(CHILD, 'done', 2_000)
    // Parent C (a different session) now wakes it and receives the handle.
    const cKey = sessionKey('slack', 'C1', '300.3', 'bot-c')
    await (daemon as any).store.upsertSession({
      key: cKey,
      agentId: 'bot-c',
      platform: 'slack',
      channel: 'C1',
      thread: '300.3',
      acpSessionId: 'acp-parent-c',
      sessionId: 'sid-parent-c',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const res = await call(
      baseReq({ callerAgentId: 'bot-c', callerChannel: 'C1', callerThread: '300.3', toAgentId: 'bot-b' })
    )
    expect(res.targetSession).toBe(CHILD)

    const askAs = (agentId: string, thread: string) =>
      (daemon as any).collab.viewSessionStatus({
        callerAgentId: agentId,
        platform: 'slack',
        callerChannel: 'C1',
        callerThread: thread,
        sessionId: CHILD
      })
    // C just started this work — it must be able to follow it.
    expect((await askAs('bot-c', '300.3'))?.status).toBe('in-progress')
    // …and the owning-side probe agrees, so a cross-daemon C sees the same.
    expect(
      (await (daemon as any).collab.childSessionStatusProbe({ parentSessionId: 'sid-parent-c', childSessionId: CHILD }))
        .found
    ).toBe(true)
    // The durable first parent A keeps its access too.
    expect(
      (await (daemon as any).collab.childSessionStatusProbe({ parentSessionId: 'sid-parent-a', childSessionId: CHILD }))
        .found
    ).toBe(true)
    // An unrelated session still cannot read it.
    expect(
      (await (daemon as any).collab.childSessionStatusProbe({ parentSessionId: 'sid-stranger', childSessionId: CHILD }))
        .found
    ).toBe(false)
    await daemon.stop()
  })
})

/** `toAgent.needsReply` becomes trusted turn metadata, never delivered text. */
describe('messageAgent: needsReply report-back directive', () => {
  it('carries needsReply on the child’s CallMeta when the caller has an origin session', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    await (daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      sessionId: 'sid-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    await call(baseReq({ needsReply: true }))
    expect(calls[0]!.callMeta).toMatchObject({ originSessionId: 'sid-parent-1', needsReply: true })
    // The obligation is metadata; the delivered text is untouched.
    expect(calls[0]!.msg.text).not.toMatch(/needsReply|report back/i)
    await daemon.stop()
  })

  it('drops needsReply when there is no origin session to report into', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    await call(baseReq({ needsReply: true }))
    expect(calls[0]!.callMeta.originSessionId).toBeUndefined()
    expect(calls[0]!.callMeta.needsReply).toBeUndefined()
    await daemon.stop()
  })

  it('does not cascade: a grandchild is only obliged if its own parent asks', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }, { id: 'bot-c' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const childKey = sessionKey('slack', 'C1', '100.1', 'bot-b')
    await (daemon as any).store.upsertSession({
      key: childKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-child-1',
      sessionId: 'sid-child-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    // bot-b is mid-turn under a needsReply wake, and now wakes bot-c without asking for a report.
    ;(daemon as any).activeTurnCallMeta.set(childKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'sid-parent-1',
      needsReply: true,
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })

    await call(baseReq({ callerAgentId: 'bot-b', toAgentId: 'bot-c' }))
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-b', hopCount: 2 })
    expect(calls[0]!.callMeta.needsReply).toBeUndefined()
    await daemon.stop()
  })
})
