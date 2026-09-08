import { randomBytes } from 'node:crypto'
import type { LocalStore } from '../../store/local-store.js'
import type { MemoryContinuationStore } from './contract.js'
import { MemoryEntryTokens } from './tokens.js'

export const MEMORY_CONTINUATION_SLOTS = 16
export const MEMORY_CONTINUATION_MAX_BYTES = 2 * 1024 * 1024
export const MEMORY_CONTINUATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_entry_continuation (
    agentId TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot >= 0 AND slot < 16),
    token TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    PRIMARY KEY (agentId, slot)
  );
  CREATE INDEX IF NOT EXISTS memory_entry_continuation_expiry ON memory_entry_continuation (expiresAt);
`

export async function memoryEntryTokens(store: LocalStore): Promise<MemoryEntryTokens> {
  const key = await store.getOrCreateDaemonSecret(
    'memory-entry-refs-v1',
    () => randomBytes(32).toString('hex'),
    Date.now()
  )
  return new MemoryEntryTokens(Buffer.from(key, 'hex'))
}

export function memoryContinuations(store: LocalStore, agentId: string): MemoryContinuationStore {
  return {
    put: (value, expiresAt) => store.putMemoryEntryContinuation(agentId, value, expiresAt),
    get: (token, now) => store.getMemoryEntryContinuation(agentId, token, now)
  }
}
