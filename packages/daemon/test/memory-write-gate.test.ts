/**
 * The tool half of the shared-memory isolation gate.
 *
 * Automatic post-turn distillation is gated in the daemon, but agent memory is
 * shared across users and the agent can also write it EXPLICITLY — the session
 * prompt actively encourages recording durable facts. A private session must not
 * be able to reach shared memory by either route.
 */
import { describe, it, expect, vi } from 'vitest'
import { executeTool, MEMORY_ACCESS_BLOCKED, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'

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
    memoryAccessAllowed: () => allowed,
    ...over
  } as unknown as OpsDeps
}

describe('file memory under the session-isolation gate', () => {
  it('refuses a write from a private session, without touching the provider', async () => {
    const d = deps(false)
    await expect(executeTool(ctx(), 'writeMemory', { content: 'secret' }, d)).rejects.toThrow(MEMORY_ACCESS_BLOCKED)
    expect(d.memory.write).not.toHaveBeenCalled()
  })

  it('refuses reads from an isolated session, without touching the provider', async () => {
    const d = deps(false)
    await expect(executeTool(ctx(), 'readMemory', {}, d)).rejects.toThrow(MEMORY_ACCESS_BLOCKED)
    expect(d.memory.read).not.toHaveBeenCalled()
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
      memoryAccessAllowed: () => allowed
    } as unknown as OpsDeps
  }

  it('refuses saveMemory from a private session', async () => {
    await expect(
      executeTool(ctx(), 'saveMemory', { content: 'secret', metadata: {} }, recordDeps(false))
    ).rejects.toThrow(MEMORY_ACCESS_BLOCKED)
  })

  it('refuses searchMemory from an isolated session', async () => {
    await expect(executeTool(ctx(), 'searchMemory', { query: 'deploys' }, recordDeps(false))).rejects.toThrow(
      MEMORY_ACCESS_BLOCKED
    )
  })
})
