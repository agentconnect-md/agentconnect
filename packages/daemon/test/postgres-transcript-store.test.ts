import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { PostgresTranscriptStore } from '../src/store/postgres-transcript-store.js'

const noPool = {} as Pool

describe('PostgreSQL transcript tenant boundary', () => {
  it('refuses a write whose organization cannot be resolved', () => {
    const onFailure = vi.fn()
    const store = new PostgresTranscriptStore(noPool, () => undefined, onFailure)
    expect(() =>
      store.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: '1',
        sender: 'user',
        recipient: 'unknown-agent',
        kind: 'text',
        text: 'must not be unscoped'
      })
    ).toThrow(/cannot resolve transcript organization/)
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('refuses a cross-organization sender and recipient', () => {
    const onFailure = vi.fn()
    const store = new PostgresTranscriptStore(
      noPool,
      (agentId) => (agentId === 'sender' ? 'org-a' : agentId === 'recipient' ? 'org-b' : undefined),
      onFailure
    )
    expect(() =>
      store.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: '1',
        sender: 'sender',
        recipient: 'recipient',
        kind: 'text',
        text: 'must not cross tenants'
      })
    ).toThrow(/different organizations/)
    expect(onFailure).toHaveBeenCalledOnce()
  })
})
