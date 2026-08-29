/**
 * The #800 inferred reply — a headless needsReply child's answer is never
 * silently dropped (the delegate-and-forward red pin, flipped).
 *
 * Measured motivation (webchat night-collection, #941/#905 validation): a COLD
 * needsReply child mostly answers its delegation as its ordinary assistant
 * response — a correct answer delivered to nobody — and the parent is never
 * woken again. The mechanism fix: when a delegation turn ends cleanly without
 * a `sendMessage {sessionId}` report, the daemon delivers the child's final
 * output to the parent as the report, explicitly marked `[inferred reply]`.
 */
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { MessageAgentReq } from '../src/mcp/ops.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeCpClient, scaffold, seedCallPolicy, settle } from './webchat-continuation-fixture.js'
import { callDaemonTool, daemonMcpBinding } from '../../../evals/games/mcp-client.js'
import { WAIT } from './wait-support.js'

const CALLER = 'bot-parent'
const CHILD = 'bot-child'

function callReq(over: Partial<MessageAgentReq> = {}): MessageAgentReq {
  return {
    callerAgentId: CALLER,
    platform: 'webchat',
    callerChannel: 'wc-parent-1',
    callerThread: '100.1',
    toAgentId: CHILD,
    text: 'What is 2 + 40? Reply with just the number.',
    channel: 'wc-parent-1',
    thread: '100.1',
    postless: true,
    needsReply: true,
    ...over
  }
}

/** Boot a daemon whose CHILD host behaves per `childReply`, with the CALLER's
 *  session row seeded (acpSessionId minted) so needsReply has an origin. */
async function boot(childReply: (text: string, chunk: (t: string) => void) => Promise<string> | string) {
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
  const daemon = new Daemon({ root: scaffold([CALLER, CHILD]), hostFactory: factory as never })
  await daemon.start()
  ;(daemon as any).cpClient = fakeCpClient()
  seedCallPolicy(daemon, [CALLER, CHILD])
  // The caller's live session (mid-turn its acpSessionId is already minted) —
  // what messageAgent captures as the child's origin.
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
  return { daemon, prompts, bindings, call, parentPrompts }
}

// The dispatch into the seeded parent row targets its ACP session by id, which
// the scripted factory does not have loaded — but SessionManager recreates it
// through the ordinary resume path, so the parent still receives the turn.

describe('inferred parent reply (#800 mechanism fix)', () => {
  it('a prose answer from a needsReply child is delivered to the parent, marked inferred', async () => {
    const run = await boot(() => 'The answer is 42.')
    try {
      expect((await run.call(callReq())).delivered).toBe(true)
      await vi.waitFor(() => expect(run.parentPrompts().length).toBeGreaterThanOrEqual(1), WAIT)
      await settle()
      const parentInput = run.parentPrompts().join('\n')
      expect(parentInput).toContain('[inferred reply]')
      expect(parentInput).toContain('The answer is 42.')
      // Exactly one parent wake — the inferred delivery, nothing else.
      expect(run.parentPrompts()).toHaveLength(1)
    } finally {
      await run.daemon.stop()
    }
  })

  it('an empty / no-response child answer becomes an explicit "finished without reporting" wake', async () => {
    const run = await boot(() => 'AC_NO_RESPONSE')
    try {
      expect((await run.call(callReq())).delivered).toBe(true)
      await vi.waitFor(() => expect(run.parentPrompts().length).toBeGreaterThanOrEqual(1), WAIT)
      const parentInput = run.parentPrompts().join('\n')
      expect(parentInput).toContain('[inferred reply]')
      expect(parentInput).toContain('produced no final output')
    } finally {
      await run.daemon.stop()
    }
  })

  it('a child that sends its real report is NOT doubled by an inferred copy', async () => {
    const run = await boot(async (text) => {
      const sessionId = [...text.matchAll(/"sessionId":"([^"]+)"/g)].map((m) => m[1]).find((v) => !v!.startsWith('<'))
      const binding = [...run.bindings.entries()].find(([sid]) => sid.includes(CHILD))?.[1]
      if (!binding || !sessionId) return `cannot report: ${Boolean(binding)}/${sessionId}`
      const result = await callDaemonTool(binding, 'sendMessage', { sessionId, message: 'REAL-REPORT: 42.' })
      return result.ok ? 'reported.' : `report failed: ${result.error}`
    })
    try {
      expect((await run.call(callReq())).delivered).toBe(true)
      await vi.waitFor(() => expect(run.parentPrompts().join('\n')).toContain('REAL-REPORT: 42.'), WAIT)
      await settle()
      const parentInput = run.parentPrompts().join('\n')
      expect(parentInput).not.toContain('[inferred reply]')
      expect(run.parentPrompts()).toHaveLength(1)
    } finally {
      await run.daemon.stop()
    }
  })

  it('a plain call without needsReply never infers', async () => {
    const run = await boot(() => 'Some ordinary answer.')
    try {
      expect((await run.call(callReq({ needsReply: false }))).delivered).toBe(true)
      await vi.waitFor(() => expect(run.prompts.get(CHILD)!.length).toBeGreaterThanOrEqual(1), WAIT)
      await settle()
      expect(run.parentPrompts()).toHaveLength(0)
    } finally {
      await run.daemon.stop()
    }
  })
})
