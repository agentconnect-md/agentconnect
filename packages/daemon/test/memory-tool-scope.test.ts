// The memory tools' scope: the session's own layer with no card, or the one an optional `layer` argument names.
import { describe, it, expect, vi } from 'vitest'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { boundWrittenTopics, type MemoryToolCall } from '../src/mcp/ops/memory.js'
import type { MemoryScope } from '../src/memory/types.js'

const ctx = (): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  channel: 'D1',
  thread: 'T1',
  deliveryThread: 'T1',
  isDm: true,
  tools: []
})

type WriteCalls = { mock: { calls: unknown[][] } }

function deps(over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    memory: {
      read: vi.fn(async () => ({ content: 'existing' })),
      write: vi.fn(async () => ({ ok: true }))
    },
    ...over
  } as unknown as OpsDeps
}

/** The daemon's scope seam, recording each call: the session's layer is a person's, `layer` picks another. */
function layered() {
  const calls: MemoryToolCall[] = []
  const memoryScope = vi.fn(async (_ctx: SessionContext, call: MemoryToolCall): Promise<MemoryScope> => {
    calls.push(call)
    if (call.layer === 'shared') return { agentId: 'bot-a' }
    if (call.layer === 'person') throw new Error('not this turn')
    return { agentId: 'bot-a', personKey: 'person-1', ...(call.layer === 'here' ? { alone: true as const } : {}) }
  })
  return { calls, d: deps({ memoryScope }) }
}

describe('memory tools write to the session layer with no card', () => {
  it('writes from a DM straight away, to the layer the daemon picked', async () => {
    const { d, calls } = layered()
    await executeTool(ctx(), 'writeMemory', { path: 'deploys.md', content: '- ship on Fridays' }, d)
    const [scope] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(scope).toEqual({ agentId: 'bot-a', personKey: 'person-1' })
    expect(calls).toEqual([{ mode: 'write' }])
  })

  it('passes `layer` to the scope seam, and the seam may refuse it', async () => {
    const { d, calls } = layered()
    await executeTool(ctx(), 'writeMemory', { content: 'for everyone', layer: 'shared' }, d)
    await executeTool(ctx(), 'readMemory', { layer: 'here' }, d)
    await expect(executeTool(ctx(), 'writeMemory', { content: 'x', layer: 'person' }, d)).rejects.toThrow(
      'not this turn'
    )
    expect(calls).toEqual([
      { mode: 'write', layer: 'shared' },
      { mode: 'read', layer: 'here' },
      { mode: 'write', layer: 'person' }
    ])
    const [shared] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(shared).toEqual({ agentId: 'bot-a' })
    expect((d.memory.read as unknown as WriteCalls).mock.calls[0]![0]).toEqual({
      agentId: 'bot-a',
      personKey: 'person-1',
      alone: true
    })
  })

  it('refuses a layer outside the three names at the tool boundary', async () => {
    const { d } = layered()
    await expect(executeTool(ctx(), 'writeMemory', { content: 'x', layer: 'everyone' }, d)).rejects.toThrow(/layer/)
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('uses the agent-level store when no scope seam is wired (unit fixtures)', async () => {
    const d = deps()
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    expect((d.memory.write as unknown as WriteCalls).mock.calls[0]![0]).toEqual({ agentId: 'bot-a' })
  })
})

describe('record-memory tools under the same seam', () => {
  const recordDeps = (memoryScope?: OpsDeps['memoryScope']): OpsDeps => {
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
      ...(memoryScope ? { memoryScope } : {})
    } as unknown as OpsDeps
  }

  it('asks the seam as a write for saveMemory and as a read for searchMemory', async () => {
    const memoryScope = vi.fn(async (_ctx: SessionContext, call: MemoryToolCall) => {
      if (call.mode === 'write') throw new Error('shared layer only')
      return { agentId: 'bot-a' }
    })
    await expect(executeTool(ctx(), 'saveMemory', { text: 'secret' }, recordDeps(memoryScope))).rejects.toThrow(
      'shared layer only'
    )
    await expect(
      executeTool(ctx(), 'searchMemory', { query: 'deploys' }, recordDeps(memoryScope))
    ).resolves.toBeDefined()
  })

  it('lets deleteMemory through where the seam allows it', async () => {
    await expect(executeTool(ctx(), 'deleteMemory', { id: 'r1' }, recordDeps())).resolves.toEqual({
      id: 'r1',
      deleted: true
    })
  })
})

describe('a bound session names no layer', () => {
  it('refuses `layer` from a distillation, which could otherwise leave its conversation', async () => {
    const d = deps()
    const bound: SessionContext = {
      ...ctx(),
      platform: 'distill',
      memoryBinding: { source: 'distill', scope: { agentId: 'bot-a', personKey: 'person-1' } }
    }
    await expect(executeTool(bound, 'writeMemory', { content: 'x', layer: 'shared' }, d)).rejects.toThrow(
      'argument layer is not available in this memory session'
    )
    expect(d.memory.write).not.toHaveBeenCalled()
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
    deliveryThread: 'distill',
    isDm: false,
    tools: [],
    memoryBinding: { source: 'distill', scope: { agentId: 'bot-a', channelKey: 'C1-abc123', channel: 'C1' } }
  })

  it('records the write as `distill`, not `tool`, so the dream rebase stays honest', async () => {
    const d = deps()
    await executeTool(distillCtx(), 'writeMemory', { path: 'prefs.md', content: '- likes tabs' }, d)
    const [, , , , source] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(source).toBe('distill')
  })

  it('writes into the ORIGINATING channel store, not one derived from its own coordinates', async () => {
    // Its own coordinates are the synthetic `memory`/`distill` pair; resolving from
    // those would send a channel-scoped agent's facts to the wrong folder.
    const d = deps({ memoryScope: () => ({ agentId: 'bot-a', channelKey: 'WRONG' }) })
    await executeTool(distillCtx(), 'writeMemory', { path: 'prefs.md', content: '- likes tabs' }, d)
    const [scope] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(scope).toMatchObject({ agentId: 'bot-a', channelKey: 'C1-abc123' })
  })

  it('still reads through the same surface', async () => {
    const d = deps()
    await executeTool(distillCtx(), 'readMemory', { path: 'prefs.md' }, d)
    expect(d.memory.read).toHaveBeenCalled()
  })

  it('leaves an ordinary turn writing as `tool`', async () => {
    const d = deps()
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    const [, , , , source] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect(source).toBe('tool')
  })
})

describe('the distillation binding is its own store', () => {
  it('keeps two channels apart: each binding writes to its own store', async () => {
    // One warm host serves every channel, so a per-agent cached session would reuse
    // the FIRST channel's pinned scope for all later channels.
    const d = deps()
    const bind = (channelKey: string): SessionContext => ({
      agentId: 'bot-a',
      platform: 'distill',
      channel: 'memory',
      thread: 'distill',
      deliveryThread: 'distill',
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
    deliveryThread: 'drm-1',
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
    const d = deps()
    await executeTool(dreamCtx(), 'writeMemory', { path: 'deploys.md', content: '- x' }, d)
    const [scope, , , , source] = (d.memory.write as unknown as WriteCalls).mock.calls[0]!
    expect((scope as { root?: unknown }).root).toEqual({ key: 'staged' })
    expect(source).toBe('dream')
  })

  it('keeps the lowercase-kebab filename rule the proposal format used to enforce', async () => {
    const d = deps()
    await expect(executeTool(dreamCtx(), 'writeMemory', { path: 'Bad_Name.md', content: 'x' }, d)).rejects.toThrow(
      /invalid memory path/
    )
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('never caps the number of distinct topics — a rebuild must be able to keep every live one', async () => {
    const d = deps()
    const ctx = dreamCtx()
    for (let i = 0; i < 200; i++) {
      await executeTool(ctx, 'writeMemory', { path: `topic-${i}.md`, content: `entry ${i}` }, d)
    }
    expect((d.memory.write as unknown as WriteCalls).mock.calls).toHaveLength(200)
    expect(boundWrittenTopics(ctx)).toHaveLength(200)
  })

  it('reports the topics it wrote, which is what the dream stages against', async () => {
    const d = deps()
    const ctx = dreamCtx()
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a' }, d)
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a2' }, d)
    expect(boundWrittenTopics(ctx)).toEqual(['one.md'])
  })

  it('does not let a REFUSED write vouch for its topic', async () => {
    // The store rejects the write (a subdirectory path, an oversized body). The name must
    // not enter the provenance record, or a dream could claim a topic through the tool and
    // then put the actual bytes there with the runtime's own file tool.
    const d = deps()
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
    const d = deps()
    await executeTool(ctx(), 'writeMemory', { path: 'Any_Name.md', content: 'x' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })
})
