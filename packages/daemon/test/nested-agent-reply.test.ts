// send-message-guide.md §9.4: a worker's reply reaches a parent that is itself a delegated session,
// when the parent's agent has no integration on the conversation's platform (a Slack-only agent in webchat).
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'
import { fakeCpClient, scaffold, seedCallPolicy, settle } from './webchat-continuation-fixture.js'
import { callDaemonTool, daemonMcpBinding } from '../../../evals/games/mcp-client.js'
import { WAIT } from './wait-support.js'

const PL = 'product-lead'
const EL = 'engineering-lead'
const ENG = 'engineer'
const ROOT = sessionKey('webchat', 'wc-owner', '100.1', PL)

/** Every message id a prompt names, from its session-message header or its reply call. */
const messageIdIn = (text: string): string | undefined =>
  [...text.matchAll(/\[Message (msg-[^\]\s]+)\]/g), ...text.matchAll(/"messageId":"(msg-[^"]+)"/g)].map((m) => m[1]!)[0]

/** The tool's own result, from a control-socket round trip. */
const payload = (call: unknown): Record<string, any> => {
  const result = (call as { ok: boolean; result?: any }).result
  const text = result?.content?.[0]?.text
  return typeof text === 'string' ? JSON.parse(text) : result
}

const slack = (agentId: string) => ({
  id: `slack-${agentId}`,
  platform: 'slack',
  core: { bindRules: [{ channel: 'C1', match: { kind: 'mention' } }] },
  config: { botToken: `xoxb-${agentId}`, appToken: `xapp-${agentId}` }
})

async function boot(beforeEngineerReply: (d: any) => void = () => {}) {
  const prompts = new Map<string, string[]>([PL, EL, ENG].map((id) => [id, []]))
  const bindings = new Map<string, { endpoint: string; token: string }>()
  const results: Record<string, unknown[]> = { elCall: [], engReply: [], elReply: [] }
  let fromProductLead: string | undefined
  let sessions = 0
  const live: { d?: any } = {}
  const answer = async (agentId: string, text: string, sid: string): Promise<string> => {
    const tool = (args: Record<string, unknown>) => callDaemonTool(bindings.get(sid)!, 'sendMessage', args)
    if (agentId === EL && !fromProductLead) {
      fromProductLead = messageIdIn(text)
      results.elCall!.push(
        await tool({ action: 'callAgent', toAgent: { agentId: ENG, needsReply: true }, message: 'Build the artifact.' })
      )
      return 'Delegated to Engineer; awaiting the artifact.'
    }
    if (agentId === EL) {
      results.elReply!.push(
        await tool({ action: 'replyToSession', messageId: fromProductLead, message: 'RESULT: PASS — 9/9 checks.' })
      )
      return 'Reviewed.'
    }
    if (agentId === ENG) {
      beforeEngineerReply(live.d)
      results.engReply!.push(
        await tool({ action: 'replyToSession', messageId: messageIdIn(text), message: 'RESULT: DONE — artifact v1.' })
      )
      return 'Reported.'
    }
    return 'ok.'
  }
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
        content: { type: 'text', text: await answer(agent.id, text, sid) }
      })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  })
  const daemon = new Daemon({ root: scaffold([PL, EL, ENG]), hostFactory: factory as never })
  await daemon.start()
  const d = daemon as any
  live.d = d
  d.cpClient = fakeCpClient()
  // Slack-only agents; attached after start so no live Slack connection is opened.
  for (const id of [PL, EL, ENG]) d.agents.get(id).integrations = [slack(id)]
  seedCallPolicy(daemon, [PL, EL, ENG], {
    [PL]: {
      callPolicy: 'selected',
      allowedCallerAgentIds: [EL],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [EL]
    },
    [EL]: {
      callPolicy: 'selected',
      allowedCallerAgentIds: [PL],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [ENG]
    },
    [ENG]: {
      callPolicy: 'selected',
      allowedCallerAgentIds: [EL],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: []
    }
  })
  // Product Lead's own top-level webchat conversation (no transport scope), where the owner started the task.
  await d.store.upsertSession({
    key: ROOT,
    agentId: PL,
    platform: 'webchat',
    channel: 'wc-owner',
    thread: '100.1',
    sessionId: 'sid-product-lead',
    acpSessionId: 'acp-seed-product-lead',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { daemon, d, prompts, results }
}

describe('nested agent calls: PL → EL → Engineer → EL → PL (send-message-guide.md §9.4)', () => {
  it('returns the Engineer report to the delegated Engineering Lead, which then reports to Product Lead', async () => {
    const { daemon, d, prompts, results } = await boot()
    try {
      const first = await d.collab.messageAgent({
        callerAgentId: PL,
        platform: 'webchat',
        callerChannel: 'wc-owner',
        callerThread: '100.1',
        toAgentId: EL,
        text: 'Brief: build and review the synthetic artifact.',
        channel: 'wc-owner',
        thread: '100.1',
        postless: true,
        needsReply: true
      })
      expect(first.delivered).toBe(true)
      const elSession = await vi.waitFor(async () => {
        const rec = (await d.store.getSession(first.targetSession)) as SessionRecord | undefined
        expect(rec).toBeDefined()
        return rec!
      }, WAIT)
      // The precondition of the defect: a webchat child carrying its Slack-only agent's scope.
      expect(elSession.platform).toBe('webchat')
      expect(elSession.transportScope).toMatch(/^slack:/)

      await vi.waitFor(() => expect(results.engReply).toHaveLength(1), WAIT)
      expect(payload(results.elCall![0])).toMatchObject({ ok: true, wake: { delivered: true } })
      expect(payload(results.engReply![0])).toEqual(
        expect.objectContaining({ delivered: true, targetSession: first.targetSession })
      )
      expect(payload(results.engReply![0])).not.toHaveProperty('reason')

      // Engineering Lead resumes in the same session on the Engineer's report and answers Product Lead.
      await vi.waitFor(() => expect(results.elReply).toHaveLength(1), WAIT)
      expect(prompts.get(EL)!.at(-1)).toContain('RESULT: DONE — artifact v1.')
      expect(payload(results.elReply![0])).toMatchObject({ delivered: true, targetSession: ROOT })
      await vi.waitFor(() => expect(prompts.get(PL)!.join('\n')).toContain('RESULT: PASS — 9/9 checks.'), WAIT)
      await settle()
      expect(prompts.get(ENG)).toHaveLength(1)
      expect(prompts.get(EL)).toHaveLength(2)
    } finally {
      await daemon.stop()
    }
  })

  it("fails closed when the delegated parent's integration is gone, and leaves the parent unwoken", async () => {
    // A disconnected or removed connection: the scope names no integration this agent still owns.
    const { daemon, d, prompts, results } = await boot((running) => {
      running.agents.get(EL).integrations = []
    })
    try {
      await d.collab.messageAgent({
        callerAgentId: PL,
        platform: 'webchat',
        callerChannel: 'wc-owner',
        callerThread: '100.1',
        toAgentId: EL,
        text: 'Brief.',
        channel: 'wc-owner',
        thread: '100.1',
        postless: true,
        needsReply: true
      })
      await vi.waitFor(() => expect(results.engReply).toHaveLength(1), WAIT)
      expect(payload(results.engReply![0])).toMatchObject({ delivered: false, reason: 'not_found' })
      await settle()
      expect(prompts.get(EL)).toHaveLength(1)
    } finally {
      await daemon.stop()
    }
  })

  it('still refuses a reply naming a message the replying session did not receive', async () => {
    const { daemon, d } = await boot()
    try {
      const reply = await d.collab.replyToSession({
        callerAgentId: ENG,
        platform: 'webchat',
        callerChannel: `a2a:${EL}`,
        callerThread: '100.1',
        messageId: 'msg-forged',
        text: 'injected'
      })
      expect(reply).toMatchObject({ delivered: false, reason: 'message_not_found' })
    } finally {
      await daemon.stop()
    }
  })
})
