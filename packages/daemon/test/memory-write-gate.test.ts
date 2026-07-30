/**
 * The tool half of the memory-capture gate (session-visibility.md §5.1).
 *
 * Automatic post-turn distillation is gated in the daemon, but agent memory is
 * shared across users and the agent can also write it EXPLICITLY — the session
 * prompt actively encourages recording durable facts. A private session must not
 * be able to reach shared memory by either route.
 */
import { describe, it, expect, vi } from 'vitest'
import { executeTool, MEMORY_WRITE_BLOCKED, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'

const ctx = (): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  channel: 'C1',
  thread: 'T1',
  isDm: true,
  tools: []
})

function deps(allowed: boolean, over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    memory: {
      read: vi.fn(async () => ({ content: 'existing' })),
      write: vi.fn(async () => ({ ok: true }))
    },
    memoryWriteAllowed: () => allowed,
    ...over
  } as unknown as OpsDeps
}

describe('writeMemory under the session-visibility gate', () => {
  it('refuses a write from a private session, without touching the provider', async () => {
    const d = deps(false)
    await expect(executeTool(ctx(), 'writeMemory', { content: 'secret' }, d)).rejects.toThrow(MEMORY_WRITE_BLOCKED)
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('still allows READS — recalling what the agent already knows is not a disclosure', async () => {
    const d = deps(false)
    await expect(executeTool(ctx(), 'readMemory', {}, d)).resolves.toEqual({ content: 'existing' })
  })

  it('allows the write when the session is org-visible', async () => {
    const d = deps(true)
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })

  it('allows the write when no gate is wired at all (unit fixtures)', async () => {
    const d = deps(true, { memoryWriteAllowed: undefined })
    await executeTool(ctx(), 'writeMemory', { content: 'shared fact' }, d)
    expect(d.memory.write).toHaveBeenCalled()
  })
})

describe('record-memory mutations under the same gate', () => {
  const recordDeps = (allowed: boolean): OpsDeps => {
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
      memoryWriteAllowed: () => allowed
    } as unknown as OpsDeps
  }

  it('refuses saveMemory from a private session', async () => {
    await expect(
      executeTool(ctx(), 'saveMemory', { content: 'secret', metadata: {} }, recordDeps(false))
    ).rejects.toThrow(MEMORY_WRITE_BLOCKED)
  })

  it('still allows searchMemory from a private session', async () => {
    await expect(executeTool(ctx(), 'searchMemory', { query: 'deploys' }, recordDeps(false))).resolves.toBeTruthy()
  })
})
