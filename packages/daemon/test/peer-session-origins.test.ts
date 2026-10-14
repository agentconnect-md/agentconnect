// send-message-guide.md §9.5: callAgent into an existing peer session, and replies to each of its admitted origins.
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { PEER_SESSION_NOT_FOUND } from '../src/collab/coordinator.js'
import type { MessageAgentReq } from '../src/mcp/ops.js'
import { executeTool } from '../src/mcp/ops.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'
import type { TurnAskers } from '../src/assistant/place-access.js'
import { judgeSessionParticipation } from '../src/mcp/ops/place-gate.js'
import { fakeCpClient, scaffold, seedCallPolicy, settle } from './webchat-continuation-fixture.js'
import { callDaemonTool, daemonMcpBinding } from '../../../evals/games/mcp-client.js'
import { WAIT } from './wait-support.js'

const A = 'agent-a'
const B = 'agent-b'
const C = 'agent-c'
const D = 'agent-d'
/** A peer the directory lists on another daemon. */
const REMOTE = 'agent-remote'
const OWNER: TurnAskers = { people: [{ kind: 'console', userId: 'owner-1' }], nobody: false }

const callerKeyOf = (agent: string) => sessionKey('webchat', `wc-${agent}`, '100.1', agent)

type Reply = (agentId: string, text: string, sid: string) => Promise<string> | string

/** A daemon whose four agents answer per `reply`, each with a seeded caller session, and a read rule the test steers. */
async function boot(root = scaffold([A, B, C, D]), reply: Reply = () => 'ok.') {
  const prompts = new Map<string, string[]>([A, B, C, D].map((id) => [id, []]))
  const bindings = new Map<string, { endpoint: string; token: string }>()
  let sessions = 0
  const factory = (agent: { id: string }, onUpdate: (sid: string, u: unknown) => void) => ({
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (_cwd: string, mcpServers?: unknown) => {
      const sid = `acp-${agent.id}-${++sessions}`
      const binding = daemonMcpBinding(mcpServers)
      if (binding) bindings.set(sid, binding)
      return sid
    }),
    loadSession: vi.fn(async (sid: string, _cwd: string, mcpServers?: unknown) => {
      const binding = daemonMcpBinding(mcpServers)
      if (binding) bindings.set(sid, binding)
      return { sessionId: sid }
    }),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
      const text = blocks.map((b) => b.text ?? '').join('\n')
      prompts.get(agent.id)!.push(text)
      onUpdate(sid, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: await reply(agent.id, text, sid) }
      })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  })
  const daemon = new Daemon({ root, hostFactory: factory as never })
  await daemon.start()
  const d = daemon as any
  d.cpClient = fakeCpClient()
  seedCallPolicy(daemon, [A, B, C, D, REMOTE])
  // Who is asking on the caller's turn, and which sessions the console shows them: both steered per test.
  const steer = { askers: OWNER, visible: (_id: string) => true }
  d.askersOfKey = () => steer.askers
  d.placeMembers.lookupsFor = () => ({
    member: async () => false,
    fullMember: async () => false,
    linked: async () => null,
    console: async (_asker: unknown, ids: readonly string[]) => ({
      asker: 'linked',
      visible: new Set(ids.filter((id) => steer.visible(id)))
    })
  })
  for (const agent of [A, C, D]) {
    const existing = await d.store.getSession(callerKeyOf(agent))
    if (existing) continue
    await d.store.upsertSession({
      key: callerKeyOf(agent),
      agentId: agent,
      platform: 'webchat',
      channel: `wc-${agent}`,
      thread: '100.1',
      sessionId: `sid-${agent}`,
      acpSessionId: `acp-seed-${agent}`,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
  }
  const req = (caller: string, over: Partial<MessageAgentReq> = {}): MessageAgentReq => ({
    callerAgentId: caller,
    platform: 'webchat',
    callerChannel: `wc-${caller}`,
    callerThread: '100.1',
    toAgentId: B,
    text: `request from ${caller}`,
    channel: `wc-${caller}`,
    thread: '100.1',
    postless: true,
    ...over
  })
  const call = (caller: string, over: Partial<MessageAgentReq> = {}) =>
    d.collab.messageAgent(req(caller, over)) as Promise<{
      delivered: boolean
      targetSession: string
      reason?: string
      message?: string
    }>
  const session = async (key: string) => (await d.store.getSession(key)) as SessionRecord
  /** A reply from `rec`'s session, outside any turn, as `replyToSession` would send it. */
  const replyFrom = (rec: SessionRecord, sessionId: string, text = 'answer') =>
    d.collab.replyToSession({
      callerAgentId: rec.agentId,
      platform: rec.platform,
      ...(rec.transportScope ? { callerTransportScope: rec.transportScope } : {}),
      callerChannel: rec.channel,
      callerThread: rec.thread,
      sessionId,
      text
    }) as Promise<{ delivered: boolean; targetSession?: string; reason?: string }>
  const sessionsOf = async (agent: string) =>
    ((await d.store.listSessions(agent)) as SessionRecord[]).map((rec) => rec.key).sort()
  return { daemon, d, prompts, bindings, steer, call, session, replyFrom, sessionsOf }
}

type Run = Awaited<ReturnType<typeof boot>>

/** A calls B, which opens B1; returns B1's row once its first turn ran. */
async function openB1(run: Run, over: Partial<MessageAgentReq> = {}): Promise<SessionRecord> {
  const first = await run.call(A, over)
  expect(first.delivered).toBe(true)
  await vi.waitFor(() => expect(run.prompts.get(B)!.length).toBeGreaterThanOrEqual(1), WAIT)
  await settle()
  return await run.session(first.targetSession)
}

describe('callAgent into an existing peer session (send-message-guide.md §9)', () => {
  it('A → B1 ← C: B1 replies to A and to C separately, in C’s turn, later, and after a restart', async () => {
    const root = scaffold([A, B, C, D])
    const fromC = 'please check the Windows behavior'
    const replies: string[] = []
    const reply: Reply = async (agent, text, sid) => {
      if (agent !== B || !text.includes(fromC)) return 'ok.'
      // In C's own turn, B1 answers A and C each by its own id through the real tool.
      const binding = run.bindings.get(sid)!
      for (const target of [`sid-${A}`, `sid-${C}`]) {
        const result = await callDaemonTool(binding, 'sendMessage', {
          action: 'replyToSession',
          sessionId: target,
          message: `answer for ${target}`
        })
        replies.push(`${target}:${result.ok ? 'sent' : result.error}`)
      }
      return 'done.'
    }
    let run = await boot(root, reply)
    try {
      const b1 = await openB1(run)
      const owner = b1.agentId
      const joined = await run.call(C, { targetSessionId: b1.key, text: fromC })
      expect(joined).toEqual({ delivered: true, targetSession: b1.key })
      await vi.waitFor(() => expect(replies).toHaveLength(2), WAIT)
      expect(replies).toEqual([`sid-${A}:sent`, `sid-${C}:sent`])
      await vi.waitFor(() => expect(run.prompts.get(A)!.join('\n')).toContain(`answer for sid-${A}`), WAIT)
      await vi.waitFor(() => expect(run.prompts.get(C)!.join('\n')).toContain(`answer for sid-${C}`), WAIT)
      // Each reply reached only its own destination.
      expect(run.prompts.get(A)!.join('\n')).not.toContain(`answer for sid-${C}`)
      expect(run.prompts.get(C)!.join('\n')).not.toContain(`answer for sid-${A}`)
      // C asked for no reply, so its turn carries no report-back directive, for C or anyone else.
      const cTurn = run.prompts.get(B)!.find((text) => text.includes(fromC))!
      expect(cTurn).not.toContain('# Reporting back to your parent session')
      expect(cTurn).toContain(`This message comes from session sid-${C} (agent ${C}).`)
      // B1 is the same session: same owner, same conversation, and B gained no other session.
      const after = await run.session(b1.key)
      expect(after.agentId).toBe(owner)
      expect([after.channel, after.thread]).toEqual([b1.channel, b1.thread])
      expect(await run.sessionsOf(B)).toEqual([b1.key])
      // A later turn, with no call metadata, still answers either one.
      await settle()
      expect((await run.replyFrom(after, `sid-${A}`)).delivered).toBe(true)
      expect((await run.replyFrom(after, `sid-${C}`)).delivered).toBe(true)
      await run.daemon.stop()
      run = await boot(root, reply)
      const restarted = await run.session(b1.key)
      expect(await run.replyFrom(restarted, `sid-${A}`)).toMatchObject({ delivered: true })
      expect(await run.replyFrom(restarted, `sid-${C}`)).toMatchObject({ delivered: true })
    } finally {
      await run.daemon.stop()
    }
  })

  it('a later caller never removes an earlier origin, and no other session is reachable by id', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      expect((await run.call(C, { targetSessionId: b1.key })).delivered).toBe(true)
      await vi.waitFor(() => expect(run.prompts.get(B)!.length).toBe(2), WAIT)
      await settle()
      const rec = await run.session(b1.key)
      expect((await run.replyFrom(rec, `sid-${A}`)).delivered).toBe(true)
      // D never called B1, and B1 cannot reply to itself because its id is known.
      expect(await run.replyFrom(rec, `sid-${D}`)).toEqual({ delivered: false, reason: 'not_authorized' })
      expect(await run.replyFrom(rec, rec.sessionId!)).toEqual({ delivered: false, reason: 'not_authorized' })
    } finally {
      await run.daemon.stop()
    }
  })

  it('distinct sessions of one agent are distinct origins', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      // A second session of agent C, in another conversation.
      await run.d.store.upsertSession({
        key: sessionKey('webchat', 'wc-c2', '100.1', C),
        agentId: C,
        platform: 'webchat',
        channel: 'wc-c2',
        thread: '100.1',
        sessionId: 'sid-c2',
        acpSessionId: 'acp-seed-c2',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      expect((await run.call(C, { targetSessionId: b1.key })).delivered).toBe(true)
      await vi.waitFor(() => expect(run.prompts.get(B)!.length).toBe(2), WAIT)
      await settle()
      const rec = await run.session(b1.key)
      expect((await run.replyFrom(rec, `sid-${C}`)).delivered).toBe(true)
      expect(await run.replyFrom(rec, 'sid-c2')).toEqual({ delivered: false, reason: 'not_authorized' })
    } finally {
      await run.daemon.stop()
    }
  })

  it('refuses a mismatched agent, an unknown id, a closed conversation and a sub-session, opening and recording nothing', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      const sources = run.d.store.sessionSources
      const before = await run.sessionsOf(B)
      const promptsBefore = run.prompts.get(B)!.length
      const refusals = [
        await run.call(C, { toAgentId: D, targetSessionId: b1.key }),
        await run.call(C, { targetSessionId: 'webchat:nowhere:1:agent-b' }),
        await run.call(C, { targetSessionId: b1.acpSessionId! })
      ]
      run.steer.visible = () => false
      refusals.push(await run.call(C, { targetSessionId: b1.key }))
      run.steer.visible = () => true
      run.steer.askers = { people: [], nobody: true }
      refusals.push(await run.call(C, { targetSessionId: b1.key }))
      run.steer.askers = OWNER
      // B's own background sub-session, from B1.
      const child = await run.d.collab.messageAgent({
        callerAgentId: B,
        platform: b1.platform,
        callerChannel: b1.channel,
        callerThread: b1.thread,
        toAgentId: B,
        text: 'background work',
        channel: b1.channel,
        postless: true
      })
      expect(child.delivered).toBe(true)
      refusals.push(await run.call(C, { targetSessionId: child.targetSession }))
      for (const refusal of refusals)
        expect(refusal).toMatchObject({ delivered: false, reason: PEER_SESSION_NOT_FOUND })
      await settle()
      expect(await sources.get(b1.key, `sid-${C}`)).toBeUndefined()
      expect((await run.sessionsOf(B)).filter((key) => !before.includes(key))).toEqual([child.targetSession])
      expect(run.prompts.get(B)!.filter((text) => text.includes(`request from ${C}`))).toEqual([])
      expect(run.prompts.get(B)!.length).toBeGreaterThanOrEqual(promptsBefore)
      expect(await run.replyFrom(await run.session(b1.key), `sid-${C}`)).toEqual({
        delivered: false,
        reason: 'not_authorized'
      })
    } finally {
      await run.daemon.stop()
    }
  })

  it('the tool refuses a call into one of your own sessions and a channel beside the session, before any effect', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      const ctx = {
        agentId: C,
        platform: 'webchat',
        isDm: false,
        channel: `wc-${C}`,
        thread: '100.1',
        deliveryThread: '100.1',
        tools: [],
        integrations: []
      }
      const messageAgent = vi.fn()
      const deps = { messageAgent, replyToSession: vi.fn(), gatewayFor: () => undefined } as never
      await expect(
        executeTool(ctx, 'sendMessage', { action: 'callAgent', toAgent: C, sessionId: b1.key, message: 'm' }, deps)
      ).rejects.toThrow(/never one of yours/)
      await expect(
        executeTool(
          ctx,
          'sendMessage',
          { action: 'callAgent', toAgent: B, sessionId: b1.key, channel: 'wc-x', message: 'm' },
          deps
        )
      ).rejects.toThrow(/not both/)
      expect(messageAgent).not.toHaveBeenCalled()
      // The admitted form is postless and carries the handle, with the agent-call receipt.
      messageAgent.mockResolvedValue({ delivered: true, targetSession: b1.key })
      expect(
        await executeTool(
          ctx,
          'sendMessage',
          { action: 'callAgent', toAgent: { agentId: B, needsReply: true }, sessionId: b1.key, message: 'm' },
          deps
        )
      ).toMatchObject({
        ok: true,
        wake: { delivered: true, targetSession: b1.key },
        childSessionId: b1.key,
        nextAction: 'finish-turn-and-wait'
      })
      expect(messageAgent.mock.calls[0]![0]).toMatchObject({ toAgentId: B, targetSessionId: b1.key, needsReply: true })
      expect(messageAgent.mock.calls[0]![0]).not.toHaveProperty('postless')
    } finally {
      await run.daemon.stop()
    }
  })
})

describe('reply obligations per admitted call (send-message-guide.md §9.4)', () => {
  it('a newer caller does not clear an earlier one’s request; each inferred answer goes to its own call’s source', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const run = await boot(scaffold([A, B, C, D]), async (agent, text) => {
      if (agent !== B) return 'ok.'
      if (text.includes(`request from ${A}`)) {
        await held
        return 'ANSWER-FOR-A'
      }
      return text.includes(`request from ${C}`) ? 'ANSWER-FOR-C' : 'ok.'
    })
    try {
      const first = await run.call(A, { needsReply: true })
      await vi.waitFor(() => expect(run.prompts.get(B)!.length).toBe(1), WAIT)
      // C joins while A's turn still runs, which used to take over the one parent link.
      expect((await run.call(C, { needsReply: true, targetSessionId: first.targetSession })).delivered).toBe(true)
      const open = await run.d.store.sessionSources.open(first.targetSession)
      expect(open.map((request: { sourceSessionId: string }) => request.sourceSessionId)).toEqual([
        `sid-${A}`,
        `sid-${C}`
      ])
      release()
      await vi.waitFor(() => expect(run.prompts.get(A)!.join('\n')).toContain('ANSWER-FOR-A'), WAIT)
      await vi.waitFor(() => expect(run.prompts.get(C)!.join('\n')).toContain('ANSWER-FOR-C'), WAIT)
      await settle()
      expect(run.prompts.get(A)!.join('\n')).not.toContain('ANSWER-FOR-C')
      expect(run.prompts.get(C)!.join('\n')).not.toContain('ANSWER-FOR-A')
      expect(await run.d.store.sessionSources.open(first.targetSession)).toEqual([])
      // C's input named its source and every session B1 can answer.
      const second = run.prompts.get(B)!.find((text) => text.includes(`request from ${C}`))!
      expect(second).toContain('# Sessions you can reply to')
      expect(second).toContain(`This message comes from session sid-${C} (agent ${C}).`)
      expect(second).toContain(`- sid-${A} (agent ${A})`)
      expect(second).toContain(`- sid-${C} (agent ${C}) — waiting on your reply to one request`)
      // C's request names C as the session to report to; A's earlier one does not move to C.
      expect(second).toContain(`{"action":"replyToSession","sessionId":"sid-${C}","message":"..."}`)
    } finally {
      await run.daemon.stop()
    }
  })

  it('one reply answers one request: another source’s and the same source’s other requests stay open', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      const sources = run.d.store.sessionSources
      const now = Date.now()
      for (const [deliveryId, source, at] of [
        ['a-1', `sid-${A}`, now],
        ['c-1', `sid-${C}`, now + 1],
        ['a-2', `sid-${A}`, now + 2]
      ] as const) {
        await sources.record({ sessionKey: b1.key, agentId: B, sourceSessionId: source, sourceAgentId: 'x', now: at })
        await sources.openObligation({ sessionKey: b1.key, agentId: B, deliveryId, sourceSessionId: source, now: at })
      }
      // A duplicate admission of the same call adds nothing.
      expect(
        await sources.openObligation({
          sessionKey: b1.key,
          agentId: B,
          deliveryId: 'a-1',
          sourceSessionId: `sid-${A}`,
          now
        })
      ).toBe(false)
      expect((await run.replyFrom(b1, `sid-${A}`)).delivered).toBe(true)
      const ids = async () => (await sources.open(b1.key)).map((row: { deliveryId: string }) => row.deliveryId)
      expect(await ids()).toEqual(['c-1', 'a-2'])
      expect((await run.replyFrom(b1, `sid-${C}`)).delivered).toBe(true)
      expect(await ids()).toEqual(['a-2'])
    } finally {
      await run.daemon.stop()
    }
  })
})

describe('the owning daemon admits remote session calls and routes replies to remote origins (send-message-guide.md §9.2)', () => {
  const fwd = (b1: SessionRecord, over: Record<string, unknown> = {}) => ({
    trustedFromAgentId: REMOTE,
    orgId: 'org-1',
    toAgentId: B,
    text: 'From agent-remote: join in',
    coords: { platform: 'webchat', channel: 'wc-remote' },
    hopCount: 1,
    deliveryId: `remote-${Math.random()}`,
    originSessionId: 'sid-remote',
    originCoords: { platform: 'webchat', channel: 'wc-remote', thread: '9.9' },
    deliveryKind: 'session-call',
    targetSessionId: b1.key,
    callerAskers: OWNER,
    ...over
  })

  it('admits into the named session only, judging the forwarded askers, then replies over the relay by the recorded route', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      expect(await run.d.handleRelayAgentMsg(fwd(b1, { callerAskers: { people: [], nobody: true } }))).toMatchObject({
        delivered: false,
        reason: 'not_found'
      })
      expect(await run.d.handleRelayAgentMsg(fwd(b1, { targetSessionId: 'webchat:nowhere:1:agent-b' }))).toMatchObject({
        delivered: false,
        reason: 'not_found'
      })
      expect(await run.d.store.sessionSources.get(b1.key, 'sid-remote')).toBeUndefined()
      expect(await run.d.handleRelayAgentMsg(fwd(b1))).toMatchObject({ delivered: true, childSessionId: b1.key })
      await vi.waitFor(() => expect(run.prompts.get(B)!.join('\n')).toContain('join in'), WAIT)
      await settle()
      expect(await run.sessionsOf(B)).toEqual([b1.key])
      const sent: Record<string, unknown>[] = []
      run.d.relays = {
        stop: vi.fn(async () => {}),
        sendAgentMsg: vi.fn(async (payload: Record<string, unknown>) => {
          sent.push(payload)
          return { deliveryId: payload.deliveryId, delivered: true, childSessionId: 'remote-session-key' }
        })
      }
      // A later turn with no call metadata still reaches the remote origin, by its recorded coordinates.
      expect(await run.replyFrom(await run.session(b1.key), 'sid-remote')).toMatchObject({ delivered: true })
      expect(sent[0]).toMatchObject({
        toAgentId: REMOTE,
        coords: { platform: 'webchat', channel: 'wc-remote', thread: '9.9' },
        lineageReplyTo: 'sid-remote',
        deliveryKind: 'session-reply'
      })
    } finally {
      await run.daemon.stop()
    }
  })

  it('a local caller routes a remote target’s session call with its session, its people and no coordinate wake', async () => {
    const run = await boot()
    try {
      const sent: Record<string, unknown>[] = []
      run.d.relays = {
        stop: vi.fn(async () => {}),
        sendAgentMsg: vi.fn(async (payload: Record<string, unknown>) => {
          sent.push(payload)
          return { deliveryId: payload.deliveryId, delivered: payload.targetSessionId === 'remote-b1' }
        })
      }
      expect(await run.call(C, { toAgentId: REMOTE, targetSessionId: 'remote-b1', needsReply: true })).toEqual({
        delivered: true,
        targetSession: 'remote-b1'
      })
      expect(sent[0]).toMatchObject({
        toAgentId: REMOTE,
        deliveryKind: 'session-call',
        targetSessionId: 'remote-b1',
        callerAskers: OWNER,
        originSessionId: `sid-${C}`,
        needsReply: true
      })
      expect(await run.call(C, { toAgentId: REMOTE, targetSessionId: 'remote-other' })).toMatchObject({
        delivered: false,
        reason: 'offline'
      })
    } finally {
      await run.daemon.stop()
    }
  })
})

describe('the session-participation rule is the cross-conversation read rule (send-message-guide.md §9.2)', () => {
  const target = { platform: 'slack', channel: 'C-TARGET', conversationKind: 'channel' as const, sessionId: 'sid-b1' }
  const deps = {
    gatewayFor: () => undefined,
    placeSnapshot: () => ({ kind: 'channel' as const, isPrivate: false })
  }
  const lookups = (visible: boolean) => ({
    member: async () => false,
    fullMember: async () => true,
    linked: async () => null,
    console: async (_asker: unknown, ids: readonly string[]) => ({
      asker: 'linked' as const,
      visible: new Set(visible ? ids : [])
    })
  })
  const judge = (over: Partial<Parameters<typeof judgeSessionParticipation>[0]>) =>
    judgeSessionParticipation({
      callerPlace: { platform: 'webchat', channel: 'wc-c' },
      target,
      askers: OWNER,
      bot: 'int-b',
      lookups: lookups(true),
      deps,
      recorder: { refused: () => {} },
      ...over
    })

  it('admits the caller’s own conversation, and people who may read the target’s, and no one else', async () => {
    expect(
      await judge({ callerPlace: { platform: 'slack', channel: 'C-TARGET' }, askers: { people: [], nobody: true } })
    ).toBe(true)
    expect(await judge({ askers: { people: [], nobody: true } })).toBe(false)
    expect(await judge({})).toBe(true)
    expect(await judge({ lookups: lookups(false) })).toBe(false)
    // A member of the target's own bot reads a public channel there; a member of another bot only as the console shows it.
    const member = { kind: 'member' as const, platform: 'slack', integrationId: 'int-b', userId: 'U1' }
    expect(await judge({ askers: { people: [member], nobody: false }, lookups: lookups(false) })).toBe(true)
    expect(
      await judge({
        askers: { people: [{ ...member, integrationId: 'int-c' }], nobody: false },
        lookups: lookups(false)
      })
    ).toBe(false)
    // Every person on the turn must be allowed, and a part of it no one is behind closes it.
    expect(await judge({ askers: { people: [member], nobody: true } })).toBe(false)
  })
})
