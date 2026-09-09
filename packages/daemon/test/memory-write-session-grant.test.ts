/**
 * The daemon half of the private-session memory write (session-visibility.md §5.1), driven end to
 * end through `executeTool`: the gate asks, the webchat card answers, and "Allow for this session"
 * is remembered for THAT session's later writes and no other's.
 */
import { describe, expect, it, vi } from 'vitest'
import { agentHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { MEMORY_WRITE_NO_APPROVER, MEMORY_WRITE_NOT_APPROVED } from '../src/memory/tools.js'
import { sessionKey } from '../src/store/local-store.js'
import { pendingTurnKey } from '../src/daemon/turn-types.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
const OWNER = agentHostKey(AGENT)

function ctx(channel: string, over: Partial<SessionContext> = {}): SessionContext {
  return { agentId: AGENT, platform: 'webchat', channel, thread: channel, isDm: true, tools: [], ...over }
}

/** A daemon with one live webchat turn on `conv-1`, whose store calls every session private. */
function world(excluded = true) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    isCaptureExcluded: vi.fn(async () => excluded),
    getSessionByAcpIdForAgent: async () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: async () => new Map<string, string>(),
    upsertElicit: vi.fn(async () => {})
  }
  const sink = { output: vi.fn(), done: vi.fn() }
  const pending = {
    plan: {
      sessionKey: sessionKey('webchat', 'conv-1', 'conv-1', AGENT),
      agentId: AGENT,
      agentName: 'Butler',
      platform: 'webchat',
      channel: 'conv-1',
      statusThread: 'conv-1',
      requesterId: 'user-1',
      approvalSurfaceSuppressed: false
    },
    approval: { waitMs: 0, depth: 0 },
    acpSessionId: 's1',
    hostKey: OWNER,
    outwardSessionId: 'outward-1',
    builtinSystemToolCallIds: new Set<string>(),
    entry: { msg: { text: 'remember this' } },
    webchat: {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      sink,
      index: 0,
      replyText: '',
      heldText: '',
      messageEmitted: false
    }
  }
  daemon.pending.set(pendingTurnKey(OWNER, 's1'), pending)
  const deps = {
    memory: { read: vi.fn(async () => ({ content: '' })), write: vi.fn(async () => ({ ok: true })) },
    memoryAccessDecision: (c: SessionContext, m: 'read' | 'write') => daemon.memoryAccessDecisionFor(c, m),
    requestMemoryWriteApproval: (c: SessionContext, a: unknown) => daemon.requestMemoryWriteApprovalFor(c, a)
  } as unknown as OpsDeps
  const cards = (): any[] => sink.output.mock.calls.map(([o]: any[]) => o.event).filter((e) => e.kind === 'elicitation')
  const answer = async (value: string | null) => {
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0))
    const { requestId } = cards().at(-1)!
    await daemon.permissions.handleElicitChoice({ requestId, value, webchatConversationId: 'conv-1' })
  }
  return { daemon, deps, cards, answer }
}

describe('"Allow for this session" on a private webchat session', () => {
  it('asks once, then lets the rest of that session write without asking', async () => {
    const w = world()
    const first = executeTool(ctx('conv-1'), 'writeMemory', { path: 'deploys.md', content: '- ship' }, w.deps)
    await w.answer('allow_session')
    await first
    await executeTool(ctx('conv-1'), 'writeMemory', { path: 'deploys.md', content: '- ship v2' }, w.deps)
    expect(w.deps.memory.write).toHaveBeenCalledTimes(2)
    expect(w.cards()).toHaveLength(1)
  })

  it('does not carry over to another session, which has no live turn here and so nobody to ask', async () => {
    const w = world()
    const first = executeTool(ctx('conv-1'), 'writeMemory', { path: 'deploys.md', content: '- ship' }, w.deps)
    await w.answer('allow_session')
    await first
    await expect(executeTool(ctx('conv-2'), 'writeMemory', { content: 'x' }, w.deps)).rejects.toThrow(
      MEMORY_WRITE_NO_APPROVER
    )
    expect(w.deps.memory.write).toHaveBeenCalledTimes(1)
  })
})

describe('"Allow once" and Deny on the same session', () => {
  it('allows exactly the approved call and asks again for the next one', async () => {
    const w = world()
    const first = executeTool(ctx('conv-1'), 'writeMemory', { path: 'a.md', content: 'one' }, w.deps)
    await w.answer('allow_once')
    await first
    const second = executeTool(ctx('conv-1'), 'writeMemory', { path: 'b.md', content: 'two' }, w.deps)
    await vi.waitFor(() => expect(w.cards()).toHaveLength(2))
    await w.answer('deny')
    await expect(second).rejects.toThrow(MEMORY_WRITE_NOT_APPROVED)
    expect(w.deps.memory.write).toHaveBeenCalledTimes(1)
    expect(w.cards()[1].message).toContain('writeMemory → b.md')
  })
})

describe('what never asks', () => {
  it('a read, an org-visible session, and a daemon-minted memory binding', async () => {
    const w = world()
    await executeTool(ctx('conv-1'), 'readMemory', {}, w.deps)
    expect(w.deps.memory.read).toHaveBeenCalled()
    const bound = ctx('conv-1', { memoryBinding: { source: 'distill', scope: { agentId: AGENT } } })
    await executeTool(bound, 'writeMemory', { path: 'p.md', content: 'x' }, w.deps)
    const open = world(false)
    await executeTool(ctx('conv-1'), 'writeMemory', { path: 'p.md', content: 'x' }, open.deps)
    expect(w.cards()).toEqual([])
    expect(open.cards()).toEqual([])
    expect(w.deps.memory.write).toHaveBeenCalledTimes(1)
    expect(open.deps.memory.write).toHaveBeenCalledTimes(1)
  })
})
