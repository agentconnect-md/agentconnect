import { createHash } from 'node:crypto'

// Source ids can be platform strings; persist only a stable, agent-scoped UUID-shaped digest in the home ledger.
export function memorySourceTurnId(agentId: string, turnId: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['memory-source-turn-v1', agentId, turnId]))
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
