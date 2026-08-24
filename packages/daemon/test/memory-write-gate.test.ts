/**
 * The tool half of the shared-memory isolation gate (#653).
 *
 * Agent memory is shared across users. Every session may READ it (the agent can
 * use what it already knows anywhere), but only a non-isolated session may WRITE
 * it — automatic post-turn distillation is gated in the daemon, and the explicit
 * write tools are gated here, so a private session cannot push its content into
 * shared memory by either route. The gate is queried per operation (`read` vs
 * `write`); this suite mirrors the daemon wiring where reads are always allowed.
 */
import { describe, it, expect, vi } from 'vitest'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { boundWrittenTopics } from '../src/mcp/ops/memory.js'
import { MEMORY_ACCESS_BLOCKED } from '../src/memory/tools.js'

const ctx = (): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  channel: 'C1',
  thread: 'T1',
  isDm: true,
  tools: []
})

// Mirror the daemon: reads are always allowed; writes are gated on the session's
// isolation verdict.
function deps(writeAllowed: boolean, over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    memory: {
      read: vi.fn(async () => ({ content: 'existing' })),
      write: vi.fn(async () => ({ ok: true }))
    },
    memoryAccessAllowed: (_ctx: SessionContext, mode: 'read' | 'write') => mode === 'read' || writeAllowed,
    ...over
  } as unknown as OpsDeps
}

describe('file memory under the session-isolation gate', () => {
  it('refuses a write from a private session, without touching the provider', async () => {
    const d = deps(false)
    await expect(executeTool(ctx(), 'writeMemory', { content: 'secret' }, d)).rejects.toThrow(MEMORY_ACCESS_BLOCKED)
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('allows a read from an isolated session — every session can use shared memory (#653)', async () => {
    const d = deps(false)
    await executeTool(ctx(), 'readMemory', {}, d)
    expect(d.memory.read).toHaveBeenCalled()
  })

  it('allows the write when the session is org-visible', async () => {
    const d = deps(true)
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })

  it('allows the write when no gate is wired at all (unit fixtures)', async () => {
    const d = deps(true, { memoryAccessAllowed: undefined })
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })
})

describe('record-memory mutations under the same gate', () => {
  const recordDeps = (writeAllowed: boolean): OpsDeps => {
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
      memoryAccessAllowed: (_ctx: SessionContext, mode: 'read' | 'write') => mode === 'read' || writeAllowed
    } as unknown as OpsDeps
  }

  it('refuses saveMemory (a write) from a private session', async () => {
    await expect(
      executeTool(ctx(), 'saveMemory', { content: 'secret', metadata: {} }, recordDeps(false))
    ).rejects.toThrow(MEMORY_ACCESS_BLOCKED)
  })

  it('allows searchMemory (a read) from an isolated session (#653)', async () => {
    await expect(executeTool(ctx(), 'searchMemory', { query: 'deploys' }, recordDeps(false))).resolves.toBeDefined()
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
    const d = deps(true)
    await executeTool(distillCtx(), 'writeMemory', { path: 'prefs.md', content: '- likes tabs' }, d)
    const [, , , , source] = (d.memory.write as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(source).toBe('distill')
  })

  it('writes into the ORIGINATING channel store, not one derived from its own coordinates', async () => {
    // Its own coordinates are the synthetic `memory`/`distill` pair; resolving from
    // those would send a channel-scoped agent's facts to the wrong folder.
    const d = deps(true, { memoryScope: () => ({ agentId: 'bot-a', channelKey: 'WRONG' }) })
    await executeTool(distillCtx(), 'writeMemory', { path: 'prefs.md', content: '- likes tabs' }, d)
    const [scope] = (d.memory.write as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(scope).toMatchObject({ agentId: 'bot-a', channelKey: 'C1-abc123' })
  })

  it('still reads through the same surface', async () => {
    const d = deps(true)
    await executeTool(distillCtx(), 'readMemory', { path: 'prefs.md' }, d)
    expect(d.memory.read).toHaveBeenCalled()
  })

  it('leaves an ordinary turn writing as `tool`', async () => {
    const d = deps(true)
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    const [, , , , source] = (d.memory.write as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(source).toBe('tool')
  })
})

describe('the distillation binding is its own authorization', () => {
  it('permits the write even though the synthetic session has no persisted row', async () => {
    // The real daemon derives this verdict from `isCaptureExcluded`, which fails
    // CLOSED for coordinates with no session row — exactly what a synthetic
    // distillation session has. Mocking the gate to `true` hid that, so model the
    // real rule here: unknown session ⇒ excluded, unless a binding is present.
    const realGate = async (ctx: SessionContext, mode: 'read' | 'write') =>
      mode === 'read' || Boolean(ctx.memoryBinding) || false
    const d = deps(false, { memoryAccessAllowed: realGate })

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

    // An ordinary session with no row is still refused — the binding is the only
    // thing that grants this, and it is daemon-minted, never model-supplied.
    const plain = deps(false, { memoryAccessAllowed: realGate })
    await expect(executeTool(ctx(), 'writeMemory', { content: 'x' }, plain)).rejects.toThrow(MEMORY_ACCESS_BLOCKED)
    expect(plain.memory.write).not.toHaveBeenCalled()
  })

  it('keeps two channels apart: each binding writes to its own store', async () => {
    // One warm host serves every channel, so a per-agent cached session would reuse
    // the FIRST channel's pinned scope for all later channels.
    const d = deps(true)
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

    const calls = (d.memory.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
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
      maxTopics: 2,
      ...over
    }
  })

  it('writes to the pinned staged store, recorded as `dream`', async () => {
    const d = deps(true)
    await executeTool(dreamCtx(), 'writeMemory', { path: 'deploys.md', content: '- x' }, d)
    const [scope, , , , source] = (d.memory.write as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect((scope as { root?: unknown }).root).toEqual({ key: 'staged' })
    expect(source).toBe('dream')
  })

  it('keeps the lowercase-kebab filename rule the proposal format used to enforce', async () => {
    const d = deps(true)
    await expect(executeTool(dreamCtx(), 'writeMemory', { path: 'Bad_Name.md', content: 'x' }, d)).rejects.toThrow(
      /invalid memory path/
    )
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('caps DISTINCT topics, while letting one topic be rewritten freely', async () => {
    const d = deps(true)
    const ctx = dreamCtx()
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a' }, d)
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a2' }, d) // same topic, fine
    await executeTool(ctx, 'writeMemory', { path: 'two.md', content: 'b' }, d)
    await expect(executeTool(ctx, 'writeMemory', { path: 'three.md', content: 'c' }, d)).rejects.toThrow(
      /topic limit reached/
    )
    expect((d.memory.write as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(3)
  })

  it('reports the topics it wrote, which is what the dream stages against', async () => {
    const d = deps(true)
    const ctx = dreamCtx()
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a' }, d)
    await executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'a2' }, d)
    expect(boundWrittenTopics(ctx)).toEqual(['one.md'])
  })

  it('does not let a REFUSED write vouch for its topic or spend a topic slot', async () => {
    // The store rejects the write (a subdirectory path, an oversized body). The name must
    // not enter the provenance record, or a dream could claim a topic through the tool and
    // then put the actual bytes there with the runtime's own file tool.
    const d = deps(true)
    const ctx = dreamCtx()
    ;(d.memory.write as unknown as { mockRejectedValueOnce(e: Error): void }).mockRejectedValueOnce(
      new Error('memory is a flat directory')
    )
    await expect(executeTool(ctx, 'writeMemory', { path: 'one.md', content: 'x' }, d)).rejects.toThrow()
    expect(boundWrittenTopics(ctx)).toEqual([])

    // ...and the refusal did not consume one of the two allowed topics.
    await executeTool(ctx, 'writeMemory', { path: 'two.md', content: 'x' }, d)
    await executeTool(ctx, 'writeMemory', { path: 'three.md', content: 'x' }, d)
    expect(boundWrittenTopics(ctx).sort()).toEqual(['three.md', 'two.md'])
  })

  it('leaves an unbound turn unconstrained', async () => {
    const d = deps(true)
    await executeTool(ctx(), 'writeMemory', { path: 'Any_Name.md', content: 'x' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })
})
