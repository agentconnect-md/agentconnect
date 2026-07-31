import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { executeTool, type MessageAgentReq } from '../src/mcp/ops.js'
import { sessionKey } from '../src/store/local-store.js'
import * as monotonic from '../src/store/monotonic-ts.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'

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
  const daemon = new Daemon({ root, hostFactory: () => fakeHost() as any })
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
  ;(daemon as any).cpCollab.replace({
    generation: 0,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: localAgents }]
  })
  const calls: { agentId: string; msg: any; integrationId?: string; callMeta?: any }[] = []
  ;(daemon as any).dispatch = vi.fn(
    async (agentId: string, msg: any, integrationId?: string, _wc?: any, callMeta?: any) => {
      calls.push({ agentId, msg, integrationId, callMeta })
      return 'acp-1'
    }
  )
  const call = (req: MessageAgentReq) => (daemon as any).messageAgent(req) as Promise<any>
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

  it('stamps the caller session’s acpSessionId as the woken child’s originSessionId', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    // Seed the caller's own session record (mid-turn its acpSessionId is already minted),
    // so messageAgent captures it as the child's origin — the SessionTarget for a reply.
    const callerKey = sessionKey('slack', 'C1', '100.1', 'bot-a')
    ;(daemon as any).store.upsertSession({
      key: callerKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    const res = await call(baseReq())
    expect(res.delivered).toBe(true)
    expect(calls[0]!.callMeta).toMatchObject({
      callFrom: 'bot-a',
      originSessionId: 'acp-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
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
    expect(msg.text).toBe('@bot-a: do the thing')
    expect(msg.msgId).toMatch(/^agentcall:C1:\d+$/)
    expect(callMeta).toMatchObject({ callFrom: 'bot-a' })
    expect(callMeta.deliveryId).toBe(msg.msgId.split(':').pop())
    // No shared-transcript row is recorded for the (now invisible) agent message.
    expect((daemon as any).store.transcriptSince('C1', '100.1', null)).toEqual([])

    await daemon.stop()
  })

  it('rejects a self-message before any lookup', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const res = await call(baseReq({ toAgentId: 'bot-a' }))
    expect(res).toMatchObject({ delivered: false, reason: 'self' })
    expect(calls.length).toBe(0)
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
      expect((daemon as any).store.transcriptSince('C1', '100.1', null)).toEqual([])
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
      { to: { toAgent: 'bot-b', channel: 'C1' }, message: 'handoff' },
      { ...(daemon as any).mcp.deps, canRun: () => true }
    )) as { wake?: { delivered: boolean; reason?: string }; post?: unknown }

    expect(result.wake).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(result.post).toBeUndefined()
    expect(postMessage).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect((daemon as any).store.transcriptSince('C1', '100.1', null)).toEqual([])
    await daemon.stop()
  })

  it('rejects a local target that is not a member of the addressed channel', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    const placement = (agentId: string) => ({
      agentId,
      daemonId: 'local-daemon',
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
    ;(daemon as any).cpCollab.replace({
      generation: 1,
      channels: [
        { orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: [placement('bot-a')] },
        { orgId: TEST_ORG, platform: 'slack', channelId: 'C2', agents: [placement('bot-b')] }
      ]
    })

    expect((daemon as any).wakeRejectionReason(baseReq())).toBe('not_allowed')
    const result = await call(baseReq())
    expect(result).toMatchObject({ delivered: false, reason: 'not_allowed' })
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

  it('hop cap is enforced across an inherited chain', async () => {
    const root = scaffold([{ id: 'main' }, { id: 'worker' }, { id: 'third' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    // inbound hop already at the cap (8) → next child would be 9 → rejected.
    seedActiveTurn(
      daemon,
      { platform: 'slack', channel: 'C1', thread: '100.1', agentId: 'worker' },
      { callFrom: 'main', hopCount: 8, deliveryId: 'd0' }
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
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    await call(baseReq({ toAgentId: 'bot-b', needsReply: true }))
    expect(sent[0]).toMatchObject({ originSessionId: 'acp-parent-1', needsReply: true })
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

  it('rejects a cross-daemon call at the hop cap before contacting the relay', async () => {
    const root = scaffold([{ id: 'worker' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).activeTurnCallMeta.set('slack:C1:100.1:worker', {
      callFrom: 'main',
      hopCount: 8,
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
      fwd({ originSessionId: 'acp-remote-parent', needsReply: true })
    )
    expect(ack.delivered).toBe(true)
    expect(calls[0]!.callMeta).toMatchObject({ originSessionId: 'acp-remote-parent', needsReply: true })
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

  it('fails closed when the local snapshot has no placement (defense in depth)', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // No snapshot installed → terminal-verify cannot confirm caller/target.
    const ack = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(calls).toHaveLength(0)
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

  it('target not a local agent → NAK not_found', async () => {
    const root = scaffold([{ id: 'bot-x' }]) // bot-b not local
    const { daemon } = await bootWithDispatchSpy(root)
    withSnapshot(daemon)
    const ack = await (daemon as any).handleRelayAgentMsg(fwd())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_found' })
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
    sessionId: 'acp-parent-1',
    text: 'result: done',
    ...over
  })

  it('refuses (not_authorized) a root/human turn with no active call metadata', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    const res = await (daemon as any).replyToSession(replyReq())
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
      originSessionId: 'acp-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })
    const res = await (daemon as any).replyToSession(replyReq({ sessionId: 'some-other-session' }))
    expect(res).toEqual({ delivered: false, reason: 'not_authorized' })
    expect(calls).toHaveLength(0)
    await daemon.stop()
  })

  it('delivers into the local origin session and inherits the origin turn’s correlationId', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // The origin session (owner bot-a) the replier bot-b was woken from.
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    armTurn(daemon, callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      correlationId: 'orch-1',
      originSessionId: 'acp-parent-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })

    const res = await (daemon as any).replyToSession(replyReq())
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
    await daemon.stop()
  })

  it('authorizes via the caller session’s PERSISTED origin on a human turn with no active CallMeta', async () => {
    // The regression that "replies once then stops": a spawned session's later, human-triggered
    // turns carry no per-turn CallMeta, so auth must fall back to the DURABLE origin on the row.
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // Origin (parent) session, owner bot-a.
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    // The replier's OWN session, spawned earlier with a durable parent link persisted on the row.
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C2', '200.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'acp-parent-1'
    })
    // NO armTurn: activeTurnCallMeta is empty for the caller (a human-triggered follow-up turn).
    const res = await (daemon as any).replyToSession(replyReq())
    expect(res.delivered).toBe(true)
    expect(res.targetSession).toBe('slack:C1:100.1:bot-a')
    expect(calls).toHaveLength(1)
    // No inbound depth on a human turn ⇒ the reply chain starts at hop 1; callFrom = the replier.
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-b', hopCount: 1 })
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
    ;(daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-origin-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    ;(daemon as any).spawnChannelRootSession({
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
      originSessionId: 'acp-origin-1',
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })
    await daemon.stop()
  })

  it('creates an idle session without prompting the model', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const host = fakeHost()
    const daemon = new Daemon({ root, hostFactory: () => host as any })
    await daemon.start()
    const targetKey = sessionKey('slack', 'C1', '1784297789.871789', 'bot-a')

    ;(daemon as any).spawnChannelRootSession({
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

    await vi.waitFor(() => {
      expect((daemon as any).store.getSession(targetKey)).toMatchObject({
        acpSessionId: 'acp-1',
        state: 'idle',
        lastDeliveredTs: null
      })
    })
    expect(host.newSession).toHaveBeenCalledOnce()
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('keys a Feishu spawn as feishu, not the narrowPlatform fallback', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, calls } = await bootWithDispatchSpy(root)
    // `narrowPlatform` predated Feishu and folded it onto `slack`, so this dispatched a `slack:`
    // message for a channel Feishu ingress records under `feishu:` — a session nothing could
    // continue. Every other caller of that helper had the same hole.
    // A Feishu DM root post, the shape where the key and the raw ts differ most: ops resolves the
    // thread key to the CHAT id (what Feishu ingress keys a p2p conversation under) while the
    // post's own message id stays the transcript ts.
    ;(daemon as any).spawnChannelRootSession({
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
    ;(daemon as any).store.upsertSession({
      key: originKey,
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100999',
      thread: 'tg:52',
      acpSessionId: 'acp-tg-origin',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    ;(daemon as any).spawnChannelRootSession({
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
      originSessionId: 'acp-tg-origin',
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
    ;(daemon as any).spawnChannelRootSession({
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
  const seed = (daemon: any, over: Record<string, unknown>) =>
    daemon.store.upsertSession({
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      ...over
    })
  const ask = (daemon: any, over: Record<string, unknown> = {}) =>
    daemon.rootPostRelation({
      callerAgentId: 'bot-b',
      platform: 'slack',
      callerChannel: 'C2',
      callerThread: '200.1',
      targetPlatform: 'telegram',
      targetChannel: '-100123',
      ...over
    })

  it('finds the parent through the persisted link when the turn has no CallMeta', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    // The parent conversation — a Telegram customer chat owned by ANOTHER agent, which is the
    // ordinary escalation shape: whoever asked is not whoever answers.
    seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:170', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:170',
      acpSessionId: 'acp-parent-1'
    })
    seed(daemon, {
      key: sessionKey('slack', 'C2', '200.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      originSessionId: 'acp-parent-1'
    })

    expect(ask(daemon)).toEqual({ kind: 'parent', sessionId: 'acp-parent-1' })
    // A post somewhere else is an ordinary new topic, not a fork.
    expect(ask(daemon, { targetChannel: '-100999' })).toBeUndefined()
    // The caller's OWN conversation, which its turn reply already reaches.
    expect(ask(daemon, { targetPlatform: 'slack', targetChannel: 'C2' })).toEqual({ kind: 'self' })
    await daemon.stop()
  })

  it('resolves a Feishu caller, whose platform string is not one narrowPlatform keeps', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    // narrowPlatform folds `feishu` onto `slack`; keying the lookup through it looked up a row
    // that never existed, so a Feishu session could never resolve its parent.
    seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:170', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:170',
      acpSessionId: 'acp-parent-1'
    })
    seed(daemon, {
      key: sessionKey('feishu', 'oc_42', 'om_1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'feishu',
      channel: 'oc_42',
      thread: 'om_1',
      acpSessionId: 'acp-child-feishu',
      originSessionId: 'acp-parent-1'
    })

    expect(ask(daemon, { platform: 'feishu', callerChannel: 'oc_42', callerThread: 'om_1' })).toEqual({
      kind: 'parent',
      sessionId: 'acp-parent-1'
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
    seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:170', 'bot-a', 'scope-bot-1'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:170',
      transportScope: 'scope-bot-1',
      acpSessionId: 'acp-parent-scoped'
    })
    seed(daemon, {
      key: sessionKey('slack', 'C2', '200.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1',
      originSessionId: 'acp-parent-scoped'
    })
    expect(ask(daemon)).toBeUndefined()

    // Control: an unscoped parent on the same coords IS the conversation the post landed on, so
    // the silence above is the scope doing the work and not a broken lookup.
    seed(daemon, {
      key: sessionKey('telegram', '-100123', 'tg:171', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100123',
      thread: 'tg:171',
      acpSessionId: 'acp-parent-unscoped'
    })
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C3', '300.1', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C3',
      thread: '300.1',
      acpSessionId: 'acp-child-2',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      originSessionId: 'acp-parent-unscoped'
    })
    expect(ask(daemon, { callerChannel: 'C3', callerThread: '300.1' })).toEqual({
      kind: 'parent',
      sessionId: 'acp-parent-unscoped'
    })
    await daemon.stop()
  })

  it('answers for a CROSS-DAEMON parent, which has no local row to read', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    seed(daemon, {
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1'
    })
    // Woken over the relay: the parent session lives on another daemon, so `getSessionByAcpId`
    // finds nothing and only the trusted wake carries its coords. Requiring a row here made the
    // notice silent for exactly the escalation shape the relay exists to serve.
    ;(daemon as any).activeTurnCallMeta.set(callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'acp-remote-parent',
      originCoords: { platform: 'telegram', channel: '-100123', thread: 'tg:9' }
    })
    expect(ask(daemon)).toEqual({ kind: 'parent', sessionId: 'acp-remote-parent' })
    // Still only for the conversation it actually names.
    expect(ask(daemon, { targetChannel: '-100999' })).toBeUndefined()
    // Matching is coordinates-only here BY DESIGN — the remote scope is credential-derived and
    // never crosses the wire — so a target integration's own scope does not suppress the match.
    // Over-matching costs a hint naming the caller's real parent; silence would cost the hint
    // entirely on the cross-daemon escalation path.
    expect(ask(daemon, { targetIntegrationId: 'int-tg-1' })).toEqual({
      kind: 'parent',
      sessionId: 'acp-remote-parent'
    })
    await daemon.stop()
  })

  it('prefers the live turn’s origin, and reports nothing for a session with no parent', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    const callerKey = sessionKey('slack', 'C2', '200.1', 'bot-b')
    seed(daemon, {
      key: callerKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C2',
      thread: '200.1',
      acpSessionId: 'acp-child-1'
    })
    // No parent link anywhere ⇒ a post into an unrelated channel relates to nothing.
    expect(ask(daemon)).toBeUndefined()

    // A live wake names its own origin, matching the precedence replyToSession authorizes on.
    seed(daemon, {
      key: sessionKey('telegram', '-100999', 'tg:9', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100999',
      thread: 'tg:9',
      acpSessionId: 'acp-parent-2'
    })
    ;(daemon as any).activeTurnCallMeta.set(callerKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'acp-parent-2',
      originCoords: { platform: 'telegram', channel: '-100999', thread: 'tg:9' }
    })
    expect(ask(daemon, { targetChannel: '-100999' })).toEqual({ kind: 'parent', sessionId: 'acp-parent-2' })
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

  const seedSession = (daemon: any, key: string, over: Record<string, unknown> = {}) => {
    const [platform, channel, thread, agentId] = key.split(':')
    daemon.store.upsertSession({
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
    daemon.viewSessionStatus({
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
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', state: 'prompting' })

    const res = await call(baseReq())
    expect(res.delivered).toBe(true)
    // Polled the instant the wake returns: dispatch is fire-and-forget, so the child's session row
    // does not exist yet — the admission-time link must still authorize the parent.
    expect(await ask(daemon, res.targetSession)).toEqual({
      sessionId: res.targetSession,
      agentId: 'bot-b',
      status: 'in-progress',
      state: 'starting'
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
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1' })
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', state, originSessionId: 'acp-parent-1' })
    if (outcome) (daemon as any).store.setSessionTurnOutcome(CHILD_KEY, outcome, 2_000)

    expect(await ask(daemon, CHILD_KEY)).toMatchObject({ agentId: 'bot-b', status, state })
    await daemon.stop()
  })

  // ACP ids are minted per runtime and are NOT unique across agents, so accepting one would make
  // the status read ambiguous. Only the logical key `sendMessage` returned is addressable.
  it('refuses the child’s ACP session id — only the returned logical key is addressable', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1' })
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', originSessionId: 'acp-parent-1' })
    ;(daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'done', 2_000)

    expect((await ask(daemon, CHILD_KEY))?.status).toBe('done')
    expect(await ask(daemon, 'acp-child-1')).toBeNull()
    await daemon.stop()
  })

  // Review finding 3: the row still reads `idle` + the PREVIOUS turn's outcome until
  // SessionManager flips it to `prompting`, so a re-delegating parent must not be handed `done`.
  it('reports in-progress for a re-wake of an already-finished child, not its old outcome', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1', state: 'prompting' })
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', originSessionId: 'acp-parent-1' })
    ;(daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'done', 2_000)
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
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1' })
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', originSessionId: 'acp-someone-else' })

    expect(await ask(daemon, CHILD_KEY)).toBeNull()
    await daemon.stop()
  })

  it('refuses a root session with no parent at all', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1' })
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1' })

    expect(await ask(daemon, CHILD_KEY)).toBeNull()
    await daemon.stop()
  })

  it('refuses the caller’s OWN session — a session is not its own child', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1' })

    expect(await ask(daemon, PARENT_KEY)).toBeNull()
    expect(await ask(daemon, 'acp-parent-1')).toBeNull()
    await daemon.stop()
  })

  it('refuses an unknown session id, and a known child asked for by a DIFFERENT session', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    seedSession(daemon, PARENT_KEY, { acpSessionId: 'acp-parent-1' })
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', originSessionId: 'acp-parent-1' })
    // bot-b's own session in another thread: a real session, but not this child's parent.
    const otherKey = sessionKey('slack', 'C1', '999.9', 'bot-b')
    seedSession(daemon, otherKey, { acpSessionId: 'acp-other-1' })

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
    ;(daemon as any).store.upsertSession({
      key: scopedParent,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      transportScope: 'bot-scope-1',
      acpSessionId: 'acp-parent-scoped',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1', originSessionId: 'acp-parent-scoped' })
    ;(daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'done', 2_000)

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
    seedSession(daemon, CHILD_KEY, { acpSessionId: 'acp-child-1' })

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

  const seedParent = (daemon: any) =>
    (daemon as any).store.upsertSession({
      key: PARENT_KEY,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
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
    (daemon as any).viewSessionStatus({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: '100.1',
      sessionId
    })

  it('asks the CP for a child admitted on another daemon, and maps the answer', async () => {
    const root = scaffold([{ id: 'bot-a' }]) // bot-b is remote
    const { daemon, call } = await bootWithDispatchSpy(root)
    seedParent(daemon)
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
      updatedAt: 9
    })
    // The CP needs the child AGENT to resolve placement — it must not parse the composite key.
    expect(asks[0]).toEqual({
      parentSessionId: 'acp-parent-1',
      childSessionId: res.targetSession,
      childAgentId: 'bot-b'
    })
    await daemon.stop()
  })

  it('does not track a remote child whose wake was REFUSED — nothing was opened', async () => {
    const root = scaffold([{ id: 'bot-a' }])
    const { daemon, call } = await bootWithDispatchSpy(root)
    seedParent(daemon)
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
    seedParent(daemon)
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
    seedParent(daemon)
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
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '777.7', 'bot-b'),
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '777.7',
      acpSessionId: 'acp-other',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const asOther = await (daemon as any).viewSessionStatus({
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
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
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
        await (daemon as any).viewSessionStatus({
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
      originSessionId: 'acp-remote-parent'
    })
    expect(ack.delivered).toBe(true)
    // dispatch is stubbed, so no row exists yet — the ACK handle plus the admission link are all
    // the owning daemon has, and a probe must still be answerable and authorized.
    expect(ack.childSessionId).toBe('slack:C1:100.1:bot-b')
    expect((daemon as any).store.getSession(ack.childSessionId)).toBeUndefined()
    expect(
      (daemon as any).childSessionStatusProbe({
        parentSessionId: 'acp-remote-parent',
        childSessionId: ack.childSessionId
      })
    ).toEqual({ found: true, agentId: 'bot-b', status: 'in-progress', state: 'starting' })
    // …and only to the parent that actually woke it.
    expect(
      (daemon as any).childSessionStatusProbe({
        parentSessionId: 'acp-someone-else',
        childSessionId: ack.childSessionId
      })
    ).toEqual({ found: false })
    await daemon.stop()
  })
})

/** The OWNING side of a §5.4 status read: the lineage rule is re-enforced where the session lives. */
describe('childSessionStatusProbe: owning-daemon authorization', () => {
  const CHILD_KEY = sessionKey('slack', 'C1', '100.1', 'bot-b')

  const seedChild = (daemon: any, over: Record<string, unknown> = {}) =>
    (daemon as any).store.upsertSession({
      key: CHILD_KEY,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-child-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000,
      ...over
    })

  it('answers with the collapsed status when the child’s origin matches the claimed parent', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    seedChild(daemon, { originSessionId: 'acp-remote-parent' })
    ;(daemon as any).store.setSessionTurnOutcome(CHILD_KEY, 'failed', 2_000)

    expect(
      (daemon as any).childSessionStatusProbe({
        parentSessionId: 'acp-remote-parent',
        childSessionId: CHILD_KEY
      })
    ).toMatchObject({ found: true, agentId: 'bot-b', status: 'failed', state: 'idle' })
    await daemon.stop()
  })

  it('refuses a mismatched parent, a parentless child, and an unknown session — all as found:false', async () => {
    const root = scaffold([{ id: 'bot-b' }])
    const { daemon } = await bootWithDispatchSpy(root)
    seedChild(daemon, { originSessionId: 'acp-remote-parent' })

    const probe = (parentSessionId: string, childSessionId = CHILD_KEY) =>
      (daemon as any).childSessionStatusProbe({ parentSessionId, childSessionId })
    // A CP that forwarded a wrong/forged parent still cannot read the child.
    expect(probe('acp-someone-else')).toEqual({ found: false })
    expect(probe('acp-remote-parent', 'slack:C1:999.9:nobody')).toEqual({ found: false })

    // A parentless (root) child: originSessionId is first-wins in the store, so this needs a key
    // that was never given an origin rather than a re-seed with null.
    const rootKey = sessionKey('slack', 'C1', '555.5', 'bot-b')
    ;(daemon as any).store.upsertSession({
      key: rootKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '555.5',
      acpSessionId: 'acp-root-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    expect(probe('acp-remote-parent', rootKey)).toEqual({ found: false })
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
    ;(daemon as any).store.upsertSession({
      key: CHILD,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-child-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000,
      originSessionId: 'acp-parent-a'
    })
    ;(daemon as any).store.setSessionTurnOutcome(CHILD, 'done', 2_000)
    // Parent C (a different session) now wakes it and receives the handle.
    const cKey = sessionKey('slack', 'C1', '300.3', 'bot-c')
    ;(daemon as any).store.upsertSession({
      key: cKey,
      agentId: 'bot-c',
      platform: 'slack',
      channel: 'C1',
      thread: '300.3',
      acpSessionId: 'acp-parent-c',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const res = await call(
      baseReq({ callerAgentId: 'bot-c', callerChannel: 'C1', callerThread: '300.3', toAgentId: 'bot-b' })
    )
    expect(res.targetSession).toBe(CHILD)

    const askAs = (agentId: string, thread: string) =>
      (daemon as any).viewSessionStatus({
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
      (daemon as any).childSessionStatusProbe({ parentSessionId: 'acp-parent-c', childSessionId: CHILD }).found
    ).toBe(true)
    // The durable first parent A keeps its access too.
    expect(
      (daemon as any).childSessionStatusProbe({ parentSessionId: 'acp-parent-a', childSessionId: CHILD }).found
    ).toBe(true)
    // An unrelated session still cannot read it.
    expect(
      (daemon as any).childSessionStatusProbe({ parentSessionId: 'acp-stranger', childSessionId: CHILD }).found
    ).toBe(false)
    await daemon.stop()
  })
})

/** `toAgent.needsReply` becomes trusted turn metadata, never delivered text. */
describe('messageAgent: needsReply report-back directive', () => {
  it('carries needsReply on the child’s CallMeta when the caller has an origin session', async () => {
    const root = scaffold([{ id: 'bot-a' }, { id: 'bot-b' }])
    const { daemon, calls, call } = await bootWithDispatchSpy(root)
    ;(daemon as any).store.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-parent-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    await call(baseReq({ needsReply: true }))
    expect(calls[0]!.callMeta).toMatchObject({ originSessionId: 'acp-parent-1', needsReply: true })
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
    ;(daemon as any).store.upsertSession({
      key: childKey,
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-child-1',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    // bot-b is mid-turn under a needsReply wake, and now wakes bot-c without asking for a report.
    ;(daemon as any).activeTurnCallMeta.set(childKey, {
      callFrom: 'bot-a',
      hopCount: 1,
      deliveryId: 'd1',
      originSessionId: 'acp-parent-1',
      needsReply: true,
      originCoords: { platform: 'slack', channel: 'C1', thread: '100.1' }
    })

    await call(baseReq({ callerAgentId: 'bot-b', toAgentId: 'bot-c' }))
    expect(calls[0]!.callMeta).toMatchObject({ callFrom: 'bot-b', hopCount: 2 })
    expect(calls[0]!.callMeta.needsReply).toBeUndefined()
    await daemon.stop()
  })
})
