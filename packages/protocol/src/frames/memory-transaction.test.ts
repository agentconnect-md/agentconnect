import { describe, expect, it } from 'vitest'
import { MemoryTransactionReq } from './memory-transaction.js'
import { buildEnvelope, decodeEnvelope, encode } from '../index.js'

const req = {
  operation: 'commit',
  agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  root: 'memory',
  operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expectedRevision: 'a'.repeat(64),
  source: 'tool',
  changes: [
    {
      action: 'put',
      path: 'topic.md',
      expectedRevision: null,
      temp: '.agentconnect-memory-cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp',
      stagedRevision: 'b'.repeat(64)
    }
  ]
}
describe('memory transaction v1', () => {
  it('carries staged references without file bodies and roundtrips in the frame codec', () => {
    const value = MemoryTransactionReq.parse(req)
    expect(decodeEnvelope(encode(buildEnvelope('memory/transaction/v1', value))).ok).toBe(true)
    expect(encode(buildEnvelope('memory/transaction/v1', value)).length).toBeLessThan(4096)
  })
  it('refuses duplicate targets, reserved files, inline bodies and unconditioned deletes', () => {
    expect(MemoryTransactionReq.safeParse({ ...req, changes: [...req.changes, ...req.changes] }).success).toBe(false)
    for (const path of ['../topic.md', '.entry-lineage', '.history', 'nested/topic.md']) {
      expect(MemoryTransactionReq.safeParse({ ...req, changes: [{ ...req.changes[0], path }] }).success).toBe(false)
    }
    expect(
      MemoryTransactionReq.safeParse({ ...req, changes: [{ ...req.changes[0], content: 'bypass staging' }] }).success
    ).toBe(false)
    expect(
      MemoryTransactionReq.safeParse({
        ...req,
        changes: [{ action: 'delete', path: 'topic.md', expectedRevision: null }]
      }).success
    ).toBe(false)
  })
})
