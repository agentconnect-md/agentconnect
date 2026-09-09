import { describe, expect, it } from 'vitest'
import {
  MemoryEntriesReadReq,
  MemoryEntriesReadResult,
  MemoryEntriesWriteReq,
  memoryEntryMutationFits
} from './memory-entries.js'
import { buildEnvelope, decodeEnvelope, encode } from '../index.js'

const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
describe('versioned unified entry read frames', () => {
  it('roundtrips defaulted bounded requests through the registered codec', () => {
    const payload = MemoryEntriesReadReq.parse({ agentId, operation: 'list', request: {} })
    expect(payload).toMatchObject({ request: { limit: 20 } })
    expect(decodeEnvelope(encode(buildEnvelope('memory/entries/read/v1', payload))).ok).toBe(true)
    expect(
      decodeEnvelope(encode(buildEnvelope('memory/entries/read/v1/result', { operation: 'get', result: null }))).ok
    ).toBe(true)
  })
  it('refuses forged operation scope and unknown contract shapes', () => {
    expect(MemoryEntriesReadReq.safeParse({ agentId, operation: 'list', request: { agentId } }).success).toBe(false)
    expect(MemoryEntriesReadReq.safeParse({ agentId, operation: 'get', request: { id: 'legacy' } }).success).toBe(false)
    expect(MemoryEntriesReadReq.safeParse({ agentId, operation: 'delete', request: { ref: 'r' } }).success).toBe(false)
    expect(
      MemoryEntriesReadResult.safeParse({ operation: 'error', code: 'CURSOR_EXPIRED', message: 'Expired' }).success
    ).toBe(true)
  })
})

it('roundtrips scoped mutations and measures JSON escaping instead of text length', () => {
  const request = MemoryEntriesWriteReq.parse({ agentId, operation: 'create', request: { text: 'hello' } })
  expect(decodeEnvelope(encode(buildEnvelope('memory/entries/write/v1', request))).ok).toBe(true)
  expect(memoryEntryMutationFits(request)).toBe(true)
  expect(memoryEntryMutationFits({ ...request, operation: 'create', request: { text: '\u0000'.repeat(40000) } })).toBe(
    false
  )
  expect(MemoryEntriesWriteReq.safeParse({ ...request, source: 'tool' }).success).toBe(false)
})
