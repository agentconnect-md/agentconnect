/**
 * The #800 needsReply deadline: silence becomes an event.
 *
 * #984's inferred reply already covers a child that ENDS its turn without reporting. It cannot
 * cover a child that never runs, never finishes, or whose wake is gated — there is no turn end
 * to hang the inference on, so the awaiting parent is never woken at all. That is the gap these
 * tests pin.
 */
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { MessageAgentReq } from '../src/mcp/ops.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeCpClient, scaffold, seedCallPolicy, settle } from './webchat-continuation-fixture.js'
import { callDaemonTool, daemonMcpBinding } from '../../../evals/games/mcp-client.js'

const WAIT = { timeout: 10_000 }
const CALLER = 'bot-parent'
const CHILD = 'bot-child'

function callReq(over: Partial<MessageAgentReq> = {}): MessageAgentReq {
  return {
    callerAgentId: CALLER,
    platform: 'webchat',
    callerChannel: 'wc-parent-1',
    callerThread: '100.1',
    toAgentId: CHILD,
    text: 'Cast your vote. Reply with just the name.',
    channel: 'wc-parent-1',
    thread: '100.1',
    postless: true,
    needsReply: true,
    ...over
  }
}

/** Boot a daemon whose CHILD host behaves per `childReply`. `root` is reusable so a restart
 *  can be exercised against the SAME store. */
async function boot(
  childReply: (text: string, chunk: (t: string) => void) => Promise<string> | string,
  root = scaffold([CALLER, CHILD])
) {
  const prompts = new Map<string, string[]>([
    [CALLER, []],
    [CHILD, []]
  ])
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
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
      const text = blocks.map((b) => b.text ?? '').join('\n')
      prompts.get(agent.id)!.push(text)
      const chunk = (t: string) =>
        onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
      if (agent.id === CHILD) {
        chunk(await childReply(text, chunk))
      } else {
        chunk('parent acknowledges.')
      }
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  })
  const daemon = new Daemon({ root, hostFactory: factory as never })
  await daemon.start()
  ;(daemon as any).cpClient = fakeCpClient()
  seedCallPolicy(daemon, [CALLER, CHILD])
  await (daemon as any).store.upsertSession({
    key: sessionKey('webchat', 'wc-parent-1', '100.1', CALLER),
    agentId: CALLER,
    platform: 'webchat',
    channel: 'wc-parent-1',
    thread: '100.1',
    acpSessionId: 'acp-parent-origin-1',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  const call = (req: MessageAgentReq) => (daemon as any).collab.messageAgent(req) as Promise<{ delivered: boolean }>
  const parentPrompts = () => prompts.get(CALLER)!
  const store = () => (daemon as any).store
  return { daemon, root, prompts, bindings, call, parentPrompts, store }
}

/** A child whose turn never ends — the shape #984's turn-final inference cannot reach. */
function hangingChild() {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { behavior: async () => (await gate, 'finally done.'), release: () => release() }
}

describe('needsReply deadline (#800)', () => {
  it('fires on silence: a child that never finishes wakes the parent with a notice, not an answer', async () => {
    const child = hangingChild()
    const run = await boot(child.behavior)
    try {
      expect((await run.call(callReq({ replyDeadlineMs: 120 }))).delivered).toBe(true)
      await vi.waitFor(() => expect(run.parentPrompts().length).toBeGreaterThanOrEqual(1), WAIT)
      const parentInput = run.parentPrompts().join('\n')
      expect(parentInput).toContain('[needsReply deadline]')
      expect(parentInput).toContain('No report arrived')
      expect(parentInput).toContain(CHILD)
      // Never fabricates a reply.
      expect(parentInput).toContain('this notice is NOT its answer')
      // The claim consumed the durable row, so nothing can fire twice.
      expect(await run.store().listParentReplyDeadlines()).toHaveLength(0)
    } finally {
      child.release()
      await settle()
      await run.daemon.stop()
    }
  }, 30_000)

  it('an arriving report cancels it — the parent is woken once, by the report', async () => {
    const run = await boot(async (text) => {
      const sessionId = [...text.matchAll(/"sessionId":"([^"]+)"/g)].map((m) => m[1]).find((v) => !v!.startsWith('<'))
      const binding = [...run.bindings.entries()].find(([sid]) => sid.includes(CHILD))?.[1]
      if (!binding || !sessionId) return `cannot report: ${Boolean(binding)}/${sessionId}`
      const result = await callDaemonTool(binding, 'sendMessage', { sessionId, message: 'VOTE: player-3.' })
      return result.ok ? 'reported.' : `report failed: ${result.error}`
    })
    try {
      // Long enough that the deadline cannot fire on its own under load: cancellation is proved
      // by the durable row and the live timer both being gone, not by outliving a short timer.
      expect((await run.call(callReq({ replyDeadlineMs: 30_000 }))).delivered).toBe(true)
      await vi.waitFor(() => expect(run.parentPrompts().join('\n')).toContain('VOTE: player-3.'), WAIT)
      await settle()
      expect(await run.store().listParentReplyDeadlines()).toHaveLength(0)
      expect((run.daemon as any).collab.parentReplyDeadlines.size).toBe(0)
      expect(run.parentPrompts().join('\n')).not.toContain('[needsReply deadline]')
      expect(run.parentPrompts()).toHaveLength(1)
    } finally {
      await run.daemon.stop()
    }
  }, 30_000)

  it('exactly once under the fire/report race: a second fire of the same deadline is a no-op', async () => {
    const child = hangingChild()
    const run = await boot(child.behavior)
    try {
      // Long enough that only the explicit fires below can run.
      expect((await run.call(callReq({ replyDeadlineMs: 60_000 }))).delivered).toBe(true)
      const [row] = await run.store().listParentReplyDeadlines()
      expect(row).toBeDefined()
      const key = row.childSessionKey
      await (run.daemon as any).collab.fireParentReplyDeadline(key)
      await (run.daemon as any).collab.fireParentReplyDeadline(key)
      await vi.waitFor(() => expect(run.parentPrompts().length).toBeGreaterThanOrEqual(1), WAIT)
      await settle()
      const deadlineWakes = run.parentPrompts().filter((p: string) => p.includes('[needsReply deadline]'))
      expect(deadlineWakes).toHaveLength(1)
    } finally {
      child.release()
      await settle()
      await run.daemon.stop()
    }
  }, 30_000)

  it('survives a restart: the re-arm reads the durable row and still wakes the parent', async () => {
    // Arm on the first daemon, then let it go down WITHOUT the child ever reporting. Releasing
    // the hung turn would settle the obligation (#984 infers the reply and disarms), so the
    // child stays hung and the row is carried across the restart.
    const first = hangingChild()
    const run = await boot(first.behavior)
    const root = run.root
    try {
      // Short enough to come due across the restart, long enough not to fire before the stop.
      expect((await run.call(callReq({ replyDeadlineMs: 1_000 }))).delivered).toBe(true)
      expect(await run.store().listParentReplyDeadlines()).toHaveLength(1)
    } finally {
      await run.daemon.stop()
      first.release()
    }

    // A fresh daemon over the SAME store re-arms from the durable row alone.
    const second = hangingChild()
    const restarted = await boot(second.behavior, root)
    try {
      await vi.waitFor(() => expect(restarted.parentPrompts().length).toBeGreaterThanOrEqual(1), WAIT)
      expect(restarted.parentPrompts().join('\n')).toContain('[needsReply deadline]')
      expect(await restarted.store().listParentReplyDeadlines()).toHaveLength(0)
    } finally {
      second.release()
      await settle()
      await restarted.daemon.stop()
    }
  }, 45_000)

  it('a report that FAILED to deliver does not disarm it — the parent still got nothing', async () => {
    const child = hangingChild()
    const run = await boot(child.behavior)
    try {
      expect((await run.call(callReq({ replyDeadlineMs: 60_000 }))).delivered).toBe(true)
      const [row] = await run.store().listParentReplyDeadlines()
      expect(row).toBeDefined()
      // A terminal delivery failure of the child's report reached nobody, so the obligation
      // is still open and the deadline must survive.
      await (run.daemon as any).collab.markChildParentReply(row.childSessionKey, row.parentSessionId, 'failed')
      expect(await run.store().listParentReplyDeadlines()).toHaveLength(1)
      await (run.daemon as any).collab.fireParentReplyDeadline(row.childSessionKey)
      await vi.waitFor(() => expect(run.parentPrompts().join('\n')).toContain('[needsReply deadline]'), WAIT)
    } finally {
      child.release()
      await settle()
      await run.daemon.stop()
    }
  }, 30_000)

  it('is PARENT-owned: a caller whose duty is held elsewhere refuses instead of arming a dud', async () => {
    const child = hangingChild()
    const run = await boot(child.behavior)
    try {
      // The wake dispatches into the CALLER's session, so the caller's duty holder must fire it.
      // This member no longer serves the caller, so arming here would be a silent no-op.
      ;(run.daemon as any).collab.host.servesAgent = (agentId: string) => agentId !== CALLER
      const res = (await run.call(callReq({ replyDeadlineMs: 60_000 }))) as Record<string, unknown>
      expect(res.delivered).toBe(true)
      expect(res.deadlineIgnored).toBe('caller_duty_elsewhere')
      expect(await run.store().listParentReplyDeadlines()).toHaveLength(0)
    } finally {
      child.release()
      await settle()
      await run.daemon.stop()
    }
  }, 30_000)

  it('a child served elsewhere still gets a deadline — only the caller must be held here', async () => {
    const child = hangingChild()
    const run = await boot(child.behavior)
    try {
      ;(run.daemon as any).collab.host.servesAgent = (agentId: string) => agentId !== CHILD
      const res = (await run.call(callReq({ replyDeadlineMs: 120 }))) as Record<string, unknown>
      expect(res.delivered).toBe(true)
      expect(res.deadlineIgnored).toBeUndefined()
      await vi.waitFor(() => expect(run.parentPrompts().join('\n')).toContain('[needsReply deadline]'), WAIT)
    } finally {
      child.release()
      await settle()
      await run.daemon.stop()
    }
  }, 30_000)

  it('a call without a deadline arms nothing', async () => {
    const child = hangingChild()
    const run = await boot(child.behavior)
    try {
      expect((await run.call(callReq())).delivered).toBe(true)
      await settle()
      expect(await run.store().listParentReplyDeadlines()).toHaveLength(0)
    } finally {
      child.release()
      await settle()
      await run.daemon.stop()
    }
  }, 30_000)
})
