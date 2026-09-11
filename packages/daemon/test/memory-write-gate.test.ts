/**
 * The tool half of the shared-memory isolation gate (#653).
 *
 * Agent memory is shared across users. Every session may READ it (the agent can
 * use what it already knows anywhere). A non-isolated session WRITES it freely; a
 * private session's write is `ask` — the human in that session approves exactly the
 * pending call, or the tool is refused with a reason the model can act on. Post-turn
 * distillation is gated in the daemon. The gate is queried per operation (`read` vs
 * `write`); this suite mirrors the daemon wiring where reads are always allowed.
 */
import { describe, it, expect, vi } from 'vitest'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import {
  boundWrittenTopics,
  memoryWriteAsk,
  type MemoryAccessDecision,
  type MemoryWriteAsk,
  type MemoryWriteVerdict
} from '../src/mcp/ops/memory.js'
import { MEMORY_WRITE_NO_APPROVER, MEMORY_WRITE_NOT_APPROVED } from '../src/memory/tools.js'

const ctx = (): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  channel: 'C1',
  thread: 'T1',
  isDm: true,
  tools: []
})

type WriteCalls = { mock: { calls: unknown[][] } }

// Mirror the daemon: reads are always allowed; a write takes the session's verdict.
function deps(write: MemoryAccessDecision, over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    memory: {
      read: vi.fn(async () => ({ content: 'existing' })),
      write: vi.fn(async () => ({ ok: true }))
    },
    memoryAccessDecision: (_ctx: SessionContext, mode: 'read' | 'write') => (mode === 'read' ? 'allow' : write),
    ...over
  } as unknown as OpsDeps
}

/** A private session whose human answers every ask the same way, recording what was asked. */
function asking(verdict: MemoryWriteVerdict) {
  const asks: MemoryWriteAsk[] = []
  const d = deps('ask', {
    requestMemoryWriteApproval: vi.fn(async (_ctx: SessionContext, ask: MemoryWriteAsk) => {
      asks.push(ask)
      return verdict
    })
  })
  return { d, asks }
}

describe('a private session asks the human before writing file memory', () => {
  it('proceeds with the write once the human allows it', async () => {
    const { d, asks } = asking('allowed')
    await executeTool(ctx(), 'writeMemory', { path: 'deploys.md', content: '- ship on Fridays' }, d)
    expect(d.memory.write).toHaveBeenCalledTimes(1)
    expect(asks).toEqual([{ tool: 'writeMemory', target: 'deploys.md', summary: 'Content: "- ship on Fridays"' }])
  })

  it('tells the model the user declined, and writes nothing', async () => {
    const { d } = asking('denied')
    await expect(executeTool(ctx(), 'writeMemory', { content: 'secret' }, d)).rejects.toThrow(MEMORY_WRITE_NOT_APPROVED)
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('tells the model nobody could be asked, without hanging', async () => {
    const { d } = asking('no_approver')
    await expect(executeTool(ctx(), 'writeMemory', { content: 'secret' }, d)).rejects.toThrow(MEMORY_WRITE_NO_APPROVER)
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('treats a missing asker, and a hard deny, as nobody to ask', async () => {
    const unwired = deps('ask')
    await expect(executeTool(ctx(), 'writeMemory', { content: 'x' }, unwired)).rejects.toThrow(MEMORY_WRITE_NO_APPROVER)
    const denied = deps('deny')
    await expect(executeTool(ctx(), 'writeMemory', { content: 'x' }, denied)).rejects.toThrow(MEMORY_WRITE_NO_APPROVER)
    expect(unwired.memory.write).not.toHaveBeenCalled()
    expect(denied.memory.write).not.toHaveBeenCalled()
  })

  it('asks once per call, for THAT call: two writes are two asks', async () => {
    const { d, asks } = asking('allowed')
    await executeTool(ctx(), 'writeMemory', { path: 'a.md', content: 'one' }, d)
    await executeTool(ctx(), 'writeMemory', { path: 'b.md', content: 'two' }, d)
    expect(asks.map((a) => a.target)).toEqual(['a.md', 'b.md'])
  })

  it('never asks for a read — every session can use shared memory (#653)', async () => {
    const { d } = asking('denied')
    await executeTool(ctx(), 'readMemory', {}, d)
    expect(d.memory.read).toHaveBeenCalled()
    expect(d.requestMemoryWriteApproval).not.toHaveBeenCalled()
  })

  it('does not ask when the session is org-visible', async () => {
    const asker = vi.fn(async () => 'denied' as const)
    const d = deps('allow', { requestMemoryWriteApproval: asker })
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    expect(d.memory.write).toHaveBeenCalled()
    expect(asker).not.toHaveBeenCalled()
  })

  it('allows the write when no gate is wired at all (unit fixtures)', async () => {
    const d = deps('allow', { memoryAccessDecision: undefined })
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })
})

describe('what the approval card is told about the pending write', () => {
  it('names the file and the first ~200 characters of a full write', () => {
    const long = 'x'.repeat(500)
    const ask = memoryWriteAsk('writeMemory', { path: 'deploys.md', content: long })
    expect(ask.target).toBe('deploys.md')
    expect(ask.summary.length).toBeLessThanOrEqual('Content: ""'.length + 200)
    expect(ask.summary.endsWith('…"')).toBe(true)
    expect(memoryWriteAsk('writeMemory', { content: 'idx' })).toEqual({
      tool: 'writeMemory',
      target: 'MEMORY.md',
      summary: 'Content: "idx"'
    })
  })

  it('says what an edit replaces or removes, and that an empty write clears the file', () => {
    expect(memoryWriteAsk('writeMemory', { path: 'p.md', oldString: 'tabs', newString: 'spaces' }).summary).toBe(
      'Replace "tabs" with "spaces"'
    )
    expect(memoryWriteAsk('writeMemory', { path: 'p.md', oldString: '- stale', newString: '' }).summary).toBe(
      'Remove "- stale"'
    )
    expect(memoryWriteAsk('writeMemory', { path: 'p.md', content: '' }).summary).toBe('Clear p.md (empty write)')
  })

  it('describes the record tools by record, and never throws on malformed arguments', () => {
    expect(memoryWriteAsk('saveMemory', { text: 'likes tabs' })).toEqual({
      tool: 'saveMemory',
      target: 'a new memory record',
      summary: 'Content: "likes tabs"'
    })
    expect(memoryWriteAsk('deleteMemory', { id: 'r1' })).toEqual({
      tool: 'deleteMemory',
      target: 'record r1',
      summary: 'Delete record r1'
    })
    expect(memoryWriteAsk('updateMemory', { id: 7, text: 42 }).summary).toBe('New content: ""')
    expect(memoryWriteAsk('writeMemory', { path: 3, content: { nested: true } }).target).toBe('MEMORY.md')
  })
})

describe('record-memory mutations under the same gate', () => {
  const recordDeps = (write: MemoryAccessDecision, verdict: MemoryWriteVerdict = 'denied'): OpsDeps => {
    const surface = {
      shape: 'records' as const,
      capabilities: new Set(['recall', 'create', 'update', 'delete', 'get']),
      search: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 'r1' })),
      update: vi.fn(async () => ({ id: 'r1' })),
      delete: vi.fn(async () => true)
    }
    return {
      memory: { adminSurface: () => surface, adminSurfaceForAgent: () => surface },
      memoryAccessDecision: (_ctx: SessionContext, mode: 'read' | 'write') => (mode === 'read' ? 'allow' : write),
      requestMemoryWriteApproval: vi.fn(async () => verdict)
    } as unknown as OpsDeps
  }

  it('refuses saveMemory (a write) from a private session whose human declined', async () => {
    await expect(
      executeTool(ctx(), 'saveMemory', { text: 'secret', metadata: {} }, recordDeps('ask', 'denied'))
    ).rejects.toThrow(MEMORY_WRITE_NOT_APPROVED)
  })

  it('lets deleteMemory through once approved', async () => {
    await expect(executeTool(ctx(), 'deleteMemory', { id: 'r1' }, recordDeps('ask', 'allowed'))).resolves.toEqual({
      id: 'r1',
      deleted: true
    })
  })

  it('allows searchMemory (a read) from an isolated session (#653)', async () => {
    await expect(executeTool(ctx(), 'searchMemory', { query: 'deploys' }, recordDeps('ask'))).resolves.toBeDefined()
  })
})

// The distillation session reaches memory through the SAME tool surface as a turn,
// differing only by its binding (#41). These execute the tool end to end, which is
// what the earlier attachment-only assertions failed to cover.
describe('a distillation-bound session writing through the shared tools', () => {
  const distillCtx = (): SessionContext => ({
    agentId: 'bot-a',
    platform: 'distill',
    channel: 'memory',
    thread: 'distill',
    isDm: false,
    tools: [],
    memoryBinding: { source: 'distill', scope: { agentId: 'bot-a', channelKey: 'C1-abc123', channel: 'C1' } }
  })

  it('records the write as `distill`, not `tool`, so the dream rebase stays honest', async () => {
    const d = deps('allow')
    await executeTool(distillCtx(), 'writeMemory', { path: 'prefs.md', content: '- likes tabs' }, d)
    const [, , , , source] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(source).toBe('distill')
  })

  it('writes into the ORIGINATING channel store, not one derived from its own coordinates', async () => {
    // Its own coordinates are the synthetic `memory`/`distill` pair; resolving from
    // those would send a channel-scoped agent's facts to the wrong folder.
    const d = deps('allow', { memoryScope: () => ({ agentId: 'bot-a', channelKey: 'WRONG' }) })
    await executeTool(distillCtx(), 'writeMemory', { path: 'prefs.md', content: '- likes tabs' }, d)
    const [scope] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(scope).toMatchObject({ agentId: 'bot-a', channelKey: 'C1-abc123' })
  })

  it('still reads through the same surface', async () => {
    const d = deps('allow')
    await executeTool(distillCtx(), 'readMemory', { path: 'prefs.md' }, d)
    expect(d.memory.read).toHaveBeenCalled()
  })

  it('leaves an ordinary turn writing as `tool`', async () => {
    const d = deps('allow')
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    const [, , , , source] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(source).toBe('tool')
  })
})

describe('the distillation binding is its own authorization', () => {
  it('permits the write even though the synthetic session has no persisted row, and never asks', async () => {
    // The real daemon derives this verdict from `isCaptureExcluded`, which fails
    // CLOSED for coordinates with no session row — exactly what a synthetic
    // distillation session has. Model the real rule here: unknown session ⇒ ask,
    // unless a binding is present.
    const realGate = (ctx: SessionContext, mode: 'read' | 'write'): MemoryAccessDecision =>
      mode === 'read' || ctx.memoryBinding ? 'allow' : 'ask'
    const asker = vi.fn(async () => 'denied' as const)
    const d = deps('ask', { memoryAccessDecision: realGate, requestMemoryWriteApproval: asker })

    await executeTool(
      {
        agentId: 'bot-a',
        platform: 'distill',
        channel: 'memory',
        thread: 'distill',
        isDm: false,
        tools: [],
        memoryBinding: { source: 'distill', scope: { agentId: 'bot-a' } }
      },
      'writeMemory',
      { path: 'prefs.md', content: '- a durable fact' },
      d
    )
    expect(d.memory.write).toHaveBeenCalled()
    expect(asker).not.toHaveBeenCalled()

    // An ordinary session with no row still asks — and this human says no. The binding is
    // the only thing that skips the ask, and it is daemon-minted, never model-supplied.
    const plain = deps('ask', { memoryAccessDecision: realGate, requestMemoryWriteApproval: asker })
    await expect(executeTool(ctx(), 'writeMemory', { content: 'x' }, plain)).rejects.toThrow(MEMORY_WRITE_NOT_APPROVED)
    expect(plain.memory.write).not.toHaveBeenCalled()
    expect(asker).toHaveBeenCalledTimes(1)
  })

  it('keeps two channels apart: each binding writes to its own store', async () => {
    // One warm host serves every channel, so a per-agent cached session would reuse
    // the FIRST channel's pinned scope for all later channels.
    const d = deps('allow')
    const bind = (channelKey: string): SessionContext => ({
      agentId: 'bot-a',
      platform: 'distill',
      channel: 'memory',
      thread: 'distill',
      isDm: false,
      tools: [],
      memoryBinding: { source: 'distill', scope: { agentId: 'bot-a', channelKey } }
    })
    await executeTool(bind('chan-A'), 'writeMemory', { path: 'a.md', content: '- from A' }, d)
    await executeTool(bind('chan-B'), 'writeMemory', { path: 'b.md', content: '- from B' }, d)

    const calls = (d.memory.write as unknown as WriteCalls).mock.calls
    expect((calls[0]![0] as { channelKey?: string }).channelKey).toBe('chan-A')
    expect((calls[1]![0] as { channelKey?: string }).channelKey).toBe('chan-B')
  })
})

describe('a dream-bound session writing its staged store', () => {
  const dreamCtx = (over: Partial<SessionContext['memoryBinding']> = {}): SessionContext => ({
    agentId: 'bot-a',
    platform: 'dream',
    channel: 'memory',
    thread: 'drm-1',
    isDm: false,
    tools: [],
    memoryBinding: {
      source: 'dream',
      scope: { agentId: 'bot-a', root: { key: 'staged' } as never },
      topicPattern: /^[a-z0-9][a-z0-9-]{0,62}\.md$/,
      ...over
    }
  })

  it('writes to the pinned staged store, recorded as `dream`', async () => {
    const d = deps('allow')
    await executeTool(dreamCtx(), 'writeMemory', { path: 'deploys.md', content: '- x' }, d)
    const [scope, , , , source] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect((scope as { root?: unknown }).root).toEqual({ key: 'staged' })
    expect(source).toBe('dream')
  })

  it('keeps the lowercase-kebab filename rule the proposal format used to enforce', async () => {
    const d = deps('allow')
    await expect(executeTool(dreamCtx(), 'writeMemory', { path: 'Bad_Name.md', content: 'x' }, d)).rejects.toThrow(
      /invalid memory path/
    )
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('never caps the number of distinct topics — a rebuild must be able to keep every live one', async () => {
    const d = deps('allow')
    const ctx = dreamCtx()
    for (let i = 0; i < 200; i++) {
      await executeTool(ctx, 'writeMemory', { path: `topic-${i}.md`, content: `entry ${i}` }, d)
    }
    expect((d.memory.write as unknown as WriteCalls).mock.calls).toHaveLength(200)
    expect(boundWrittenTopics(ctx)).toHaveLength(200)
  })

  it('reports the topics it wrote, which is what the dream stages against', async () => {
    const d = deps('allow')
    const ctx = dreamCtx()
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a' }, d)
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a2' }, d)
    expect(boundWrittenTopics(ctx)).toEqual(['one.md'])
  })

  it('does not let a REFUSED write vouch for its topic', async () => {
    // The store rejects the write (a subdirectory path, an oversized body). The name must
    // not enter the provenance record, or a dream could claim a topic through the tool and
    // then put the actual bytes there with the runtime's own file tool.
    const d = deps('allow')
    const ctx = dreamCtx()
    ;(d.memory.write as unknown as { mockRejectedValueOnce(e: Error): void }).mockRejectedValueOnce(
      new Error('memory is a flat directory')
    )
    await expect(executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'x' }, d)).rejects.toThrow()
    expect(boundWrittenTopics(ctx)).toEqual([])

    // ...and it stays out of the record once later writes succeed.
    await executeTool(ctx, 'writeMemory', { path: 'two.md', content: 'x' }, d)
    await executeTool(ctx, 'writeMemory', { path: 'three.md', content: 'x' }, d)
    expect(boundWrittenTopics(ctx).sort()).toEqual(['three.md', 'two.md'])
  })

  it('leaves an unbound turn unconstrained', async () => {
    const d = deps('allow')
    await executeTool(ctx(), 'writeMemory', { path: 'Any_Name.md', content: 'x' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })
})
