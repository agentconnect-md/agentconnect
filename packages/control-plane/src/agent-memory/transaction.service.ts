import { MemoryTransactionReq, type MemoryTransactionResult } from '@agentconnect.md/protocol'
import type { AgentMemoryTransactionRepo } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import type { MemoryStoreAgent } from './store.service.js'
import { memoryPathSegments } from './paths.js'

export class AgentMemoryTransactionService {
  constructor(
    private readonly repo: AgentMemoryTransactionRepo,
    private readonly clock: Clock
  ) {}
  async apply(agent: MemoryStoreAgent, input: MemoryTransactionReq): Promise<MemoryTransactionResult> {
    const parsed = MemoryTransactionReq.safeParse(input)
    if (!parsed.success || parsed.data.agentId !== agent.id)
      return { operation: 'error', code: 'INVALID_ARGUMENT', message: 'invalid memory transaction' }
    const request = parsed.data
    let parts: string[]
    try {
      parts = memoryPathSegments(request.root)
    } catch {
      return { operation: 'error', code: 'INVALID_ARGUMENT', message: 'invalid memory root' }
    }
    if (
      !(parts.length === 1 && parts[0] === 'memory') &&
      !(parts.length === 3 && parts[0] === 'channels' && parts[2] === 'memory')
    )
      return {
        operation: 'error',
        code: 'INVALID_ARGUMENT',
        message: 'transaction must name an agent or channel memory root'
      }
    return this.repo.apply(agent.id, agent.orgId, { ...request, root: parts.join('/') }, new Date(this.clock.now()))
  }
}
