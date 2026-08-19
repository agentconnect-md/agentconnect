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
    memoryAccessAllowed: (_ctx, mode) => mode === 'read' || writeAllowed,
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
