// send-message-guide.md §9.2–§9.7: callAgent into an existing peer session, and replies addressed to the message they answer.
import { describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { MESSAGE_NOT_FOUND, PEER_SESSION_NOT_FOUND } from '../src/collab/coordinator.js'
import type { MessageAgentReq } from '../src/mcp/ops.js'
import { executeTool } from '../src/mcp/ops.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'
import type { ReceivedSessionMessage } from '../src/store/session-messages.js'
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

/** Every message id a prompt shows in a session-message header. */
const idsIn = (text: string): string[] => [...text.matchAll(/\[Message (msg-[^\]\s]+)\]/g)].map((m) => m[1]!)

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
  const replyFrom = (rec: SessionRecord, messageId: string, text = 'answer', submissionId?: string) =>
    d.collab.replyToSession({
      callerAgentId: rec.agentId,
      platform: rec.platform,
      ...(rec.transportScope ? { callerTransportScope: rec.transportScope } : {}),
      callerChannel: rec.channel,
      callerThread: rec.thread,
      messageId,
      text,
      ...(submissionId ? { submissionId } : {})
    }) as Promise<{ delivered: boolean; targetSession?: string; inReplyTo: string; reason?: string }>
  const sessionsOf = async (agent: string) =>
    ((await d.store.listSessions(agent)) as SessionRecord[]).map((rec) => rec.key).sort()
  /** What `key` received, oldest first. */
  const received = async (key: string): Promise<ReceivedSessionMessage[]> =>
    ((await d.store.sessionMessages.listFor(key, 100)) as ReceivedSessionMessage[]).sort(
      (a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId)
    )
  const fromSource = async (key: string, source: string) =>
    (await received(key)).filter((message) => message.sourceSessionId === source)
  return { daemon, d, prompts, bindings, steer, call, session, replyFrom, sessionsOf, received, fromSource }
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

describe('A → B1 ← C: replies addressed to the message they answer (send-message-guide.md §9.1, §9.7)', () => {
  it('B1 holds three messages and answers each by id, in C’s turn, later, and after a restart, reaching only its source', async () => {
    const root = scaffold([A, B, C, D])
    const fromC = 'please check the Windows behavior'
    const replies: string[] = []
    const reply: Reply = async (agent, text, sid) => {
      if (agent !== B || !text.includes(fromC)) return 'ok.'
      // In C's own turn, B1 answers A's first message and C's by id through the real tool.
      const binding = run.bindings.get(sid)!
      const [m1] = (await run.fromSource(b1.key, `sid-${A}`)).map((m) => m.messageId)
      const [m2] = (await run.fromSource(b1.key, `sid-${C}`)).map((m) => m.messageId)
      expect(idsIn(text)).toContain(m2)
      for (const [id, label] of [
        [m1!, 'A'],
        [m2!, 'C']
      ] as const) {
        const result = await callDaemonTool(binding, 'sendMessage', {
          action: 'replyToSession',
          messageId: id,
          message: `answer for ${label}`
        })
        replies.push(`${label}:${result.ok ? 'sent' : result.error}`)
      }
      return 'done.'
    }
    let run = await boot(root, reply)
    let b1!: SessionRecord
    try {
      b1 = await openB1(run)
      const owner = b1.agentId
      const joined = await run.call(C, { targetSessionId: b1.key, text: fromC })
      expect(joined).toEqual({ delivered: true, targetSession: b1.key })
      await vi.waitFor(() => expect(replies).toHaveLength(2), WAIT)
      expect(replies).toEqual(['A:sent', 'C:sent'])
      await vi.waitFor(() => expect(run.prompts.get(A)!.join('\n')).toContain('answer for A'), WAIT)
      await vi.waitFor(() => expect(run.prompts.get(C)!.join('\n')).toContain('answer for C'), WAIT)
      expect(run.prompts.get(A)!.join('\n')).not.toContain('answer for C')
      expect(run.prompts.get(C)!.join('\n')).not.toContain('answer for A')
      // C's message shows its id and source, and asks for no reply, so it carries no reply call.
      const cTurn = run.prompts.get(B)!.find((text) => text.includes(fromC))!
      const [m2] = (await run.fromSource(b1.key, `sid-${C}`)).map((m) => m.messageId)
      expect(cTurn).toContain(`[Message ${m2}] From ${C} (agent ${C}, session sid-${C}):\n${fromC}`)
      expect(cTurn).not.toContain('This message waits on your reply')
      expect(cTurn).not.toContain('Parent session')
      // A calls again: a third message, distinct from its first.
      await settle()
      expect((await run.call(A, { targetSessionId: b1.key, text: 'one more thing' })).delivered).toBe(true)
      await vi.waitFor(async () => expect(await run.received(b1.key)).toHaveLength(3), WAIT)
      await settle()
      const [m1, m3] = (await run.fromSource(b1.key, `sid-${A}`)).map((m) => m.messageId)
      expect(new Set([m1, m2, m3]).size).toBe(3)
      // B1 is the same session: same owner, same conversation, and B gained no other session.
      const after = await run.session(b1.key)
      expect(after.agentId).toBe(owner)
      expect([after.channel, after.thread]).toEqual([b1.channel, b1.thread])
      expect(await run.sessionsOf(B)).toEqual([b1.key])
      // A later turn, with no call metadata, still answers each.
      for (const id of [m1!, m2!, m3!]) expect((await run.replyFrom(after, id)).delivered).toBe(true)
      await run.daemon.stop()
      run = await boot(root, reply)
      const restarted = await run.session(b1.key)
      expect(await run.replyFrom(restarted, m1!)).toMatchObject({ delivered: true, inReplyTo: m1 })
      expect(await run.replyFrom(restarted, m2!)).toMatchObject({
        delivered: true,
        targetSession: callerKeyOf(C),
        inReplyTo: m2
      })
    } finally {
      await run.daemon.stop()
    }
  })

  it('answering one message twice delivers twice and settles once; other messages stay open', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run, { needsReply: true })
      await settle()
      expect((await run.call(C, { targetSessionId: b1.key, needsReply: true })).delivered).toBe(true)
      expect((await run.call(A, { targetSessionId: b1.key, needsReply: true })).delivered).toBe(true)
      await vi.waitFor(async () => expect(await run.received(b1.key)).toHaveLength(3), WAIT)
      await settle()
      const rec = await run.session(b1.key)
      // The inferred answers already settled each turn's own message; reopen them to test explicit replies alone.
      for (const message of await run.received(b1.key))
        await run.d.store.db.query("UPDATE session_message SET replyState = 'open' WHERE messageId = ?", [
          message.messageId
        ])
      const [m1, m3] = (await run.fromSource(b1.key, `sid-${A}`)).map((m) => m.messageId)
      const [m2] = (await run.fromSource(b1.key, `sid-${C}`)).map((m) => m.messageId)
      const before = run.prompts.get(A)!.length
      expect(await run.replyFrom(rec, m1!, 'progress')).toMatchObject({ delivered: true, inReplyTo: m1 })
      expect(await run.replyFrom(rec, m1!, 'result')).toMatchObject({ delivered: true, inReplyTo: m1 })
      await vi.waitFor(() => expect(run.prompts.get(A)!.length).toBeGreaterThanOrEqual(before + 1), WAIT)
      await vi.waitFor(() => expect(run.prompts.get(A)!.join('\n')).toContain('\nresult'), WAIT)
      const states = async () =>
        Object.fromEntries((await run.received(b1.key)).map((m) => [m.messageId, m.replyState]))
      expect(await states()).toEqual({ [m1!]: 'replied', [m2!]: 'open', [m3!]: 'open' })
      // Each reply is its own message to A, naming the one it answers.
      const repliesToA = (await run.received(callerKeyOf(A))).filter((m) => m.kind === 'reply' && m.inReplyTo === m1)
      expect(repliesToA.length).toBeGreaterThanOrEqual(2)
      expect(new Set(repliesToA.map((m) => m.messageId)).size).toBe(repliesToA.length)
    } finally {
      await run.daemon.stop()
    }
  })

  it('refuses an unknown, foreign, dropped or forged id with one refusal, delivering and recording nothing', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      await settle()
      const [m1] = (await run.fromSource(b1.key, `sid-${A}`)).map((m) => m.messageId)
      const records = async () => (await run.d.store.sessionMessages.countFor(callerKeyOf(A))) as number
      const before = await records()
      const promptsBefore = run.prompts.get(A)!.length
      const refusal = (id: string) => ({ delivered: false, inReplyTo: id, reason: MESSAGE_NOT_FOUND })
      // Unknown and forged ids.
      expect(await run.replyFrom(b1, 'msg-unknown')).toEqual(refusal('msg-unknown'))
      expect(await run.replyFrom(b1, `${m1}x`)).toEqual(refusal(`${m1}x`))
      // A message to another session: D cannot answer B1's message, and B1 cannot answer as another session.
      expect(await run.replyFrom(await run.session(callerKeyOf(D)), m1!)).toEqual(refusal(m1!))
      // A dropped record: purging its source drops it.
      await run.d.store.deleteSession(callerKeyOf(A))
      expect(await run.replyFrom(b1, m1!)).toEqual(refusal(m1!))
      expect(run.prompts.get(A)!.length).toBe(promptsBefore)
      expect(await records()).toBe(before === 0 ? 0 : 0)
    } finally {
      await run.daemon.stop()
    }
  })

  it('never reads the origin: a session can answer only messages it holds, whatever its origin says', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      await settle()
      expect(b1.originSessionId).toBe(`sid-${A}`)
      const [m1] = (await run.fromSource(b1.key, `sid-${A}`)).map((m) => m.messageId)
      // An origin naming D gives no way to reach D; one removed changes nothing for A's message.
      await run.d.store.upsertSession({ ...b1, originSessionId: `sid-${D}` })
      const promptsD = run.prompts.get(D)!.length
      expect((await run.fromSource(b1.key, `sid-${D}`)).length).toBe(0)
      expect((await run.replyFrom(await run.session(b1.key), m1!)).targetSession).toBe(callerKeyOf(A))
      await run.d.store.db.query('UPDATE sessions SET originSessionId = NULL WHERE key = ?', [b1.key])
      expect(await run.replyFrom(await run.session(b1.key), m1!)).toMatchObject({
        delivered: true,
        targetSession: callerKeyOf(A)
      })
      expect(run.prompts.get(D)!.length).toBe(promptsD)
    } finally {
      await run.daemon.stop()
    }
  })

  it('keeps distinct sessions of one agent distinct, and no session answers itself', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
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
      expect(
        (await run.call(C, { targetSessionId: b1.key, callerChannel: 'wc-c2', channel: 'wc-c2', text: 'from c2' }))
          .delivered
      ).toBe(true)
      await vi.waitFor(async () => expect(await run.received(b1.key)).toHaveLength(3), WAIT)
      await settle()
      const [fromC] = await run.fromSource(b1.key, `sid-${C}`)
      const [fromC2] = await run.fromSource(b1.key, 'sid-c2')
      expect((await run.replyFrom(b1, fromC!.messageId)).targetSession).toBe(callerKeyOf(C))
      expect((await run.replyFrom(b1, fromC2!.messageId)).targetSession).toBe(
        sessionKey('webchat', 'wc-c2', '100.1', C)
      )
      // B1 never received a message from itself, so it has none of its own to answer.
      expect((await run.fromSource(b1.key, b1.sessionId!)).length).toBe(0)
    } finally {
      await run.daemon.stop()
    }
  })

  it('answers a reply in turn, and the hop limit stops an exchange that never settles', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      await settle()
      const [m1] = (await run.fromSource(b1.key, `sid-${A}`)).map((m) => m.messageId)
      expect((await run.replyFrom(b1, m1!, 'first answer')).delivered).toBe(true)
      await vi.waitFor(async () => expect((await run.received(callerKeyOf(A))).length).toBeGreaterThanOrEqual(1), WAIT)
      await settle()
      const r1 = (await run.received(callerKeyOf(A))).find((m) => m.kind === 'reply' && m.inReplyTo === m1)!
      expect(r1).toMatchObject({ sourceSessionId: b1.sessionId, sourceAgentId: B })
      // A answers B1's reply, which lands in B1 as a reply to it.
      expect(await run.replyFrom(await run.session(callerKeyOf(A)), r1.messageId, 'thanks')).toMatchObject({
        delivered: true,
        targetSession: b1.key,
        inReplyTo: r1.messageId
      })
      await vi.waitFor(
        async () =>
          expect((await run.received(b1.key)).some((m) => m.kind === 'reply' && m.inReplyTo === r1.messageId)).toBe(
            true
          ),
        WAIT
      )
      // A message already at the edge of the hop limit cannot be answered.
      await run.d.store.db.query('UPDATE session_message SET hopCount = ? WHERE messageId = ?', [
        MAX_AGENT_CALL_HOPS - 1,
        m1
      ])
      expect(await run.replyFrom(b1, m1!)).toEqual({ delivered: false, inReplyTo: m1, reason: 'hop_limit' })
    } finally {
      await run.daemon.stop()
    }
  })

  it('refuses a mismatched agent, an unknown id, a closed conversation and a task, opening and recording nothing', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
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
      // B's own background task, from B1.
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
      expect(await run.fromSource(b1.key, `sid-${C}`)).toEqual([])
      expect((await run.sessionsOf(B)).filter((key) => !before.includes(key))).toEqual([child.targetSession])
      expect(run.prompts.get(B)!.filter((text) => text.includes(`request from ${C}`))).toEqual([])
      expect(run.prompts.get(B)!.length).toBeGreaterThanOrEqual(promptsBefore)
      // Nothing C sent was recorded as sent either, so no reply could be accepted for it.
      const sent = await run.d.store.db.query('SELECT * FROM session_message_sent WHERE senderKey = ?', [
        callerKeyOf(C)
      ])
      expect(sent.rows).toEqual([])
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
      const replyToSession = vi.fn()
      const deps = { messageAgent, replyToSession, gatewayFor: () => undefined } as never
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
      // A legacy session-addressed reply is an argument error naming messageId.
      await expect(
        executeTool(ctx, 'sendMessage', { action: 'replyToSession', sessionId: `sid-${A}`, message: 'm' }, deps)
      ).rejects.toThrow(/requires `messageId` and does not accept `sessionId`/)
      expect(messageAgent).not.toHaveBeenCalled()
      expect(replyToSession).not.toHaveBeenCalled()
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

  it('records one message and one obligation for a replayed submission', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      await settle()
      const again = { targetSessionId: b1.key, needsReply: true, submissionId: 'call-1', text: 'the same call' }
      expect((await run.call(C, again)).delivered).toBe(true)
      expect((await run.call(C, again)).delivered).toBe(true)
      await vi.waitFor(async () => expect((await run.fromSource(b1.key, `sid-${C}`)).length).toBe(1), WAIT)
      await settle()
      expect(await run.fromSource(b1.key, `sid-${C}`)).toHaveLength(1)
      expect(run.prompts.get(B)!.filter((text) => text.includes('the same call'))).toHaveLength(1)
      const [m] = await run.fromSource(b1.key, `sid-${C}`)
      expect(m!.replyState).not.toBe('none')
      // A replayed reply is one message too (the inferred answer to the call is already one).
      const answers = async () =>
        (await run.received(callerKeyOf(C))).filter((r) => r.kind === 'reply' && r.inReplyTo === m!.messageId)
      const before = (await answers()).length
      expect((await run.replyFrom(b1, m!.messageId, 'once', 'reply-1')).delivered).toBe(true)
      expect((await run.replyFrom(b1, m!.messageId, 'once', 'reply-1')).delivered).toBe(true)
      await settle()
      expect((await answers()).length).toBe(before + 1)
    } finally {
      await run.daemon.stop()
    }
  })
})

describe('a replayed new-session call (send-message-guide.md §8.6)', () => {
  it('gets its first receipt back and runs no second turn, in process and from the recorded message', async () => {
    const run = await boot()
    try {
      const replay = { submissionId: 'call-new-1', text: 'a postless call' }
      const first = await run.call(C, replay)
      expect(first.delivered).toBe(true)
      expect(await run.call(C, replay)).toEqual(first)
      await vi.waitFor(async () => expect(await run.fromSource(first.targetSession, `sid-${C}`)).toHaveLength(1), WAIT)
      await settle()
      // After a restart only the recorded message remains to say where it went.
      run.d.collab.callSubmissions.clear()
      expect(await run.call(C, replay)).toEqual({ delivered: true, targetSession: first.targetSession })
      await settle()
      expect(run.prompts.get(B)!.filter((text) => text.includes('a postless call'))).toHaveLength(1)
      expect(await run.fromSource(first.targetSession, `sid-${C}`)).toHaveLength(1)
    } finally {
      await run.daemon.stop()
    }
  })
})

describe('sessions from before the upgrade (send-message-guide.md §9.6)', () => {
  it('answer their origin’s outstanding request through the call the upgrade synthesized', async () => {
    const run = await boot()
    try {
      // A session the upgrade found: an origin, an outstanding request, and only the synthesized call to show for it.
      const b0 = sessionKey('webchat', 'wc-old', '1.1', B)
      await run.d.store.upsertSession({
        key: b0,
        agentId: B,
        platform: 'webchat',
        channel: 'wc-old',
        thread: '1.1',
        sessionId: 'sid-b0',
        acpSessionId: 'acp-b0',
        originSessionId: `sid-${A}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      await run.d.store.sessionMessages.recordReceived({
        messageId: 'msg-migrated',
        recipientKey: b0,
        recipientAgentId: B,
        sourceSessionId: `sid-${A}`,
        sourceAgentId: A,
        kind: 'call',
        replyState: 'open',
        hopCount: 0,
        legacy: true,
        now: Date.now()
      })
      expect(await run.replyFrom(await run.session(b0), 'msg-migrated', 'the old answer')).toEqual({
        delivered: true,
        targetSession: callerKeyOf(A),
        inReplyTo: 'msg-migrated'
      })
      await vi.waitFor(() => expect(run.prompts.get(A)!.join('\n')).toContain('the old answer'), WAIT)
      expect((await run.d.store.sessionMessages.received('msg-migrated'))?.replyState).toBe('replied')
    } finally {
      await run.daemon.stop()
    }
  })
})

describe('obligations, inference and failures follow the message (send-message-guide.md §9.5)', () => {
  it('a newer caller does not clear an earlier one’s request; each inferred answer goes to its own message’s source', async () => {
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
      // C joins while A's turn still runs.
      expect((await run.call(C, { needsReply: true, targetSessionId: first.targetSession })).delivered).toBe(true)
      await vi.waitFor(async () => expect(await run.received(first.targetSession)).toHaveLength(2), WAIT)
      expect((await run.received(first.targetSession)).map((m) => [m.sourceSessionId, m.replyState])).toEqual([
        [`sid-${A}`, 'open'],
        [`sid-${C}`, 'open']
      ])
      release()
      await vi.waitFor(() => expect(run.prompts.get(A)!.join('\n')).toContain('ANSWER-FOR-A'), WAIT)
      await vi.waitFor(() => expect(run.prompts.get(C)!.join('\n')).toContain('ANSWER-FOR-C'), WAIT)
      await settle()
      expect(run.prompts.get(A)!.join('\n')).not.toContain('ANSWER-FOR-C')
      expect(run.prompts.get(C)!.join('\n')).not.toContain('ANSWER-FOR-A')
      expect((await run.received(first.targetSession)).map((m) => m.replyState)).toEqual(['replied', 'replied'])
      // C's input showed its id and the exact reply call, and the list of messages B1 may answer.
      const [mA] = (await run.fromSource(first.targetSession, `sid-${A}`)).map((m) => m.messageId)
      const [mC] = (await run.fromSource(first.targetSession, `sid-${C}`)).map((m) => m.messageId)
      const second = run.prompts.get(B)!.find((text) => text.includes(`request from ${C}`))!
      expect(second).toContain(`[Message ${mC}] From ${C} (agent ${C}, session sid-${C}):`)
      expect(second).toContain(`{"action":"replyToSession","messageId":"${mC}","message":"..."}`)
      expect(second).toContain('# Messages you may answer')
      // A's turn ended, and its inferred answer settled A's message, before C's turn ran; the open one is listed first.
      expect(second).toContain(
        `- ${mC}: a message from agent ${C}, session sid-${C} — waiting on your reply\n- ${mA}: a message from agent ${A}, session sid-${A}\n`
      )
      // The inferred answers are replies naming their own message.
      expect(run.prompts.get(A)!.join('\n')).toContain(`to your message ${mA}:`)
    } finally {
      await run.daemon.stop()
    }
  })

  it('infers nothing for a turn into which another message was folded', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const run = await boot(scaffold([A, B, C, D]), async (agent, text) => {
      if (agent === B && text.includes(`request from ${A}`) && !text.includes(`request from ${C}`)) await held
      return agent === B ? 'FOLDED-OUTPUT' : 'ok.'
    })
    try {
      const first = await run.call(A, { needsReply: true })
      await vi.waitFor(() => expect(run.prompts.get(B)!.length).toBe(1), WAIT)
      const key = first.targetSession
      // A call folded into the live turn, as a steered message would be.
      const live = run.d.activeGateEntries.get(key)
      live.foldedCalls = [...(live.foldedCalls ?? []), { deliveryId: 'folded-delivery', messageId: 'msg-folded' }]
      release()
      await vi.waitFor(() => expect(run.d.activeGateEntries.has(key)).toBe(false), WAIT)
      await settle()
      expect(run.prompts.get(A)!.join('\n')).not.toContain('FOLDED-OUTPUT')
      expect((await run.received(key))[0]!.replyState).toBe('open')
    } finally {
      await run.daemon.stop()
    }
  })

  it('reports an admitted call’s failed turn to its own message’s source and settles that message only', async () => {
    const run = await boot(scaffold([A, B, C, D]), (agent, text) => {
      if (agent === B && text.includes('FAIL-ME')) throw new Error('the runtime exited')
      return 'ok.'
    })
    try {
      const b1 = await openB1(run, { needsReply: true })
      await settle()
      const joined = await run.call(C, { targetSessionId: b1.key, text: 'FAIL-ME', needsReply: true })
      expect(joined).toEqual({ delivered: true, targetSession: b1.key })
      await vi.waitFor(() => expect(run.prompts.get(C)!.join('\n')).toContain('the runtime exited'), WAIT)
      await settle()
      const [mC] = await run.fromSource(b1.key, `sid-${C}`)
      expect(run.prompts.get(C)!.join('\n')).toContain(`failed to process your message ${mC!.messageId}`)
      expect(run.prompts.get(A)!.join('\n')).not.toContain('the runtime exited')
      expect(mC!.replyState).toBe('failed')
    } finally {
      await run.daemon.stop()
    }
  })
})

describe('remote sessions: ids travel with the delivery, and a reply lands only in the sender (send-message-guide.md §9.4)', () => {
  const fwd = (b1: SessionRecord, over: Record<string, unknown> = {}) => ({
    trustedFromAgentId: REMOTE,
    orgId: 'org-1',
    toAgentId: B,
    text: 'join in',
    coords: { platform: 'webchat', channel: 'wc-remote' },
    hopCount: 1,
    deliveryId: `remote-${Math.random()}`,
    originSessionId: 'sid-remote',
    originCoords: { platform: 'webchat', channel: 'wc-remote', thread: '9.9' },
    deliveryKind: 'session-call',
    targetSessionId: b1.key,
    callerAskers: OWNER,
    messageId: `msg-remote-${Math.random()}`,
    messageKind: 'call',
    needsReply: true,
    ...over
  })

  it('records a remote call under its id, shows it, and answers it over the relay naming that id', async () => {
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
      expect(await run.fromSource(b1.key, 'sid-remote')).toEqual([])
      const call = fwd(b1, { needsReply: false })
      expect(await run.d.handleRelayAgentMsg(call)).toMatchObject({ delivered: true, childSessionId: b1.key })
      await vi.waitFor(() => expect(run.prompts.get(B)!.join('\n')).toContain('join in'), WAIT)
      await settle()
      expect(run.prompts.get(B)!.join('\n')).toContain(
        `[Message ${call.messageId}] From ${REMOTE} (agent ${REMOTE}, session sid-remote):\njoin in`
      )
      expect(await run.d.store.sessionMessages.received(call.messageId)).toMatchObject({
        recipientKey: b1.key,
        sourceSessionId: 'sid-remote',
        sourceAgentId: REMOTE,
        sourceChannel: 'wc-remote',
        sourceThread: '9.9',
        replyState: 'none'
      })
      expect(await run.sessionsOf(B)).toEqual([b1.key])
      // An id already another session's names that message, so a delivery reusing it is refused.
      await run.d.store.sessionMessages.recordReceived({
        messageId: 'msg-taken',
        recipientKey: callerKeyOf(D),
        recipientAgentId: D,
        sourceSessionId: 'sid-x',
        sourceAgentId: REMOTE,
        kind: 'call',
        replyState: 'none',
        hopCount: 1,
        now: Date.now()
      })
      expect(await run.d.handleRelayAgentMsg(fwd(b1, { messageId: 'msg-taken' }))).toMatchObject({ delivered: false })
      expect(await run.d.store.sessionMessages.received('msg-taken')).toMatchObject({ recipientKey: callerKeyOf(D) })
      const sent: Record<string, unknown>[] = []
      run.d.relays = {
        stop: vi.fn(async () => {}),
        sendAgentMsg: vi.fn(async (payload: Record<string, unknown>) => {
          sent.push(payload)
          return { deliveryId: payload.deliveryId, delivered: true, childSessionId: 'remote-session-key' }
        })
      }
      // A later turn with no call metadata still reaches the remote source, by the recorded coordinates.
      expect(await run.replyFrom(await run.session(b1.key), call.messageId)).toMatchObject({
        delivered: true,
        inReplyTo: call.messageId
      })
      expect(sent.at(-1)).toMatchObject({
        toAgentId: REMOTE,
        coords: { platform: 'webchat', channel: 'wc-remote', thread: '9.9' },
        lineageReplyTo: 'sid-remote',
        deliveryKind: 'session-reply',
        messageKind: 'reply',
        inReplyTo: call.messageId
      })
      expect(String(sent.at(-1)!.messageId)).toMatch(/^msg-/)
    } finally {
      await run.daemon.stop()
    }
  })

  it('a local caller’s remote call carries its message id, and the remote reply lands only in the sending session', async () => {
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
      const messageId = String(sent[0]!.messageId)
      expect(sent[0]).toMatchObject({
        toAgentId: REMOTE,
        deliveryKind: 'session-call',
        targetSessionId: 'remote-b1',
        callerAskers: OWNER,
        originSessionId: `sid-${C}`,
        needsReply: true,
        messageKind: 'call',
        text: `request from ${C}`
      })
      expect(messageId).toMatch(/^msg-/)
      // A refused call recorded nothing a reply could land on.
      expect(await run.call(C, { toAgentId: REMOTE, targetSessionId: 'remote-other' })).toMatchObject({
        delivered: false,
        reason: 'offline'
      })
      expect(await run.d.store.sessionMessages.sent(String(sent[1]!.messageId))).toBeUndefined()
      const reply = (over: Record<string, unknown>) =>
        run.d.handleRelayAgentMsg({
          trustedFromAgentId: REMOTE,
          orgId: 'org-1',
          toAgentId: C,
          text: 'the answer',
          coords: { platform: 'webchat', channel: 'wc-remote' },
          hopCount: 2,
          deliveryId: `remote-reply-${Math.random()}`,
          originSessionId: 'sid-remote-b1',
          originCoords: { platform: 'webchat', channel: 'wc-remote', thread: '9.9' },
          deliveryKind: 'session-reply',
          lineageReplyTo: `sid-${C}`,
          messageId: `msg-r-${Math.random()}`,
          messageKind: 'reply',
          inReplyTo: messageId,
          ...over
        })
      // Not a message this daemon sent, or one sent to another agent, or one claimed for another session: nowhere.
      expect(await reply({ inReplyTo: 'msg-never-sent' })).toMatchObject({ delivered: false, reason: 'not_found' })
      expect(await reply({ trustedFromAgentId: D })).toMatchObject({ delivered: false, reason: 'not_found' })
      expect(await reply({ lineageReplyTo: `sid-${A}` })).toMatchObject({ delivered: false, reason: 'not_found' })
      expect(run.prompts.get(C)!.join('\n')).not.toContain('the answer')
      const accepted = await reply({})
      expect(accepted).toMatchObject({ delivered: true, childSessionId: callerKeyOf(C) })
      await vi.waitFor(() => expect(run.prompts.get(C)!.join('\n')).toContain('the answer'), WAIT)
      expect(run.prompts.get(C)!.join('\n')).toContain(`to your message ${messageId}:\nthe answer`)
      expect(run.prompts.get(A)!.join('\n')).not.toContain('the answer')
    } finally {
      await run.daemon.stop()
    }
  })

  it('accepts a pre-id peer’s reply into its named session, and answers a pre-id call the pre-id way', async () => {
    const run = await boot()
    try {
      const b1 = await openB1(run)
      // A call from a peer that predates ids: recorded under a stable synthesized id, shown with it.
      const {
        messageId: _id,
        messageKind: _kind,
        ...legacy
      } = {
        ...(await (async () => ({
          trustedFromAgentId: REMOTE,
          orgId: 'org-1',
          toAgentId: B,
          text: 'From remote: legacy call',
          coords: { platform: 'webchat', channel: 'wc-remote' },
          hopCount: 1,
          deliveryId: 'legacy-delivery-1',
          originSessionId: 'sid-remote',
          originCoords: { platform: 'webchat', channel: 'wc-remote', thread: '9.9' },
          deliveryKind: 'session-call',
          targetSessionId: b1.key,
          callerAskers: OWNER,
          messageId: 'x',
          messageKind: 'call'
        }))())
      }
      expect(await run.d.handleRelayAgentMsg(legacy)).toMatchObject({ delivered: true })
      await vi.waitFor(async () => expect(await run.fromSource(b1.key, 'sid-remote')).toHaveLength(1), WAIT)
      const [synth] = await run.fromSource(b1.key, 'sid-remote')
      expect(synth).toMatchObject({ legacy: true, kind: 'call' })
      const sent: Record<string, unknown>[] = []
      run.d.relays = {
        stop: vi.fn(async () => {}),
        sendAgentMsg: vi.fn(async (payload: Record<string, unknown>) => {
          sent.push(payload)
          return { deliveryId: payload.deliveryId, delivered: true }
        })
      }
      expect((await run.replyFrom(await run.session(b1.key), synth!.messageId)).delivered).toBe(true)
      expect(sent[0]).toMatchObject({ lineageReplyTo: 'sid-remote', deliveryKind: 'session-reply' })
      expect(sent[0]).not.toHaveProperty('inReplyTo')
      expect(sent[0]).not.toHaveProperty('messageId')
      // A pre-id reply into a session of this daemon still lands in the session it names.
      expect(
        await run.d.handleRelayAgentMsg({
          trustedFromAgentId: REMOTE,
          orgId: 'org-1',
          toAgentId: C,
          text: 'legacy answer',
          coords: { platform: 'webchat', channel: 'wc-remote' },
          hopCount: 2,
          deliveryId: 'legacy-reply-1',
          originSessionId: 'sid-remote',
          deliveryKind: 'session-reply',
          lineageReplyTo: `sid-${C}`
        })
      ).toMatchObject({ delivered: true, childSessionId: callerKeyOf(C) })
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

  it('never treats a shared `a2a:` coordinate as the caller’s own conversation', async () => {
    // Two sibling peers one agent woke without a channel land on the same synthetic coordinate.
    const sibling = { ...target, channel: 'a2a:agent-y' }
    const callerPlace = { platform: 'slack', channel: 'a2a:agent-y' }
    expect(await judge({ callerPlace, target: sibling, askers: { people: [], nobody: true } })).toBe(false)
    expect(await judge({ callerPlace, target: sibling, lookups: lookups(false) })).toBe(false)
    expect(await judge({ callerPlace, target: sibling })).toBe(true)
  })
})
