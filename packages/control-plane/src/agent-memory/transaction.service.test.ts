import { describe, expect, it, vi } from 'vitest'
import { AgentMemoryTransactionService } from './transaction.service.js'
import type { AgentMemoryTransactionRepo } from '../persistence/ports.js'

const AGENT = { id: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222' }

function service() {
  const apply = vi.fn(async () => ({ operation: 'capture-status' as const, suppressed: false }))
  const svc = new AgentMemoryTransactionService(
    { apply } as unknown as AgentMemoryTransactionRepo,
    {
      now: () => 0
    } as never
  )
  return { svc, apply }
}

describe('AgentMemoryTransactionService roots', () => {
  it('takes the shared store and every layer root beside it, and nothing else', async () => {
    const { svc, apply } = service()
    const req = (root: string) =>
      ({
        agentId: AGENT.id,
        root,
        operation: 'capture-status',
        sourceTurnId: '33333333-3333-4333-8333-333333333333'
      }) as never
    for (const root of ['memory', 'channels/place-a/memory', 'people/user-a/memory']) {
      expect(await svc.apply(AGENT as never, req(root))).toEqual({ operation: 'capture-status', suppressed: false })
    }
    expect(apply).toHaveBeenCalledTimes(3)
    for (const root of ['people/user-a', 'people/user-a/notes', 'other/user-a/memory']) {
      expect(await svc.apply(AGENT as never, req(root))).toMatchObject({ operation: 'error', code: 'INVALID_ARGUMENT' })
    }
    expect(apply).toHaveBeenCalledTimes(3)
  })
})
