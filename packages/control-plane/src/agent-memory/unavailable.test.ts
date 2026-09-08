import { describe, it, expect } from 'vitest'
import { ProtocolError } from '../domain/errors.js'
import { MemoryHomeUnavailableReason, memoryHomeUnavailable } from './unavailable.js'

const refused = (reason?: string) =>
  new ProtocolError('BAD_PAYLOAD', 'memory/write failed: home unreachable', reason ? { details: { reason } } : {})

describe('memoryHomeUnavailable', () => {
  it('keeps the sleeping-sandbox answer byte-for-byte: the workspace code the console wakes on', () => {
    expect(memoryHomeUnavailable(refused('sandbox-unavailable'))).toEqual({
      status: 503,
      error: 'Service Unavailable',
      message: 'memory/write failed: home unreachable',
      code: 'WORKSPACE_SANDBOX_UNAVAILABLE'
    })
  })

  it('answers every other reason with 503 and the reason as a MEMORY_HOME_* code, never the wake code', () => {
    for (const reason of MemoryHomeUnavailableReason.options.filter((r) => r !== 'sandbox-unavailable')) {
      const failure = memoryHomeUnavailable(refused(reason))
      expect(failure?.status, reason).toBe(503)
      expect(failure?.code, reason).toBe(`MEMORY_HOME_${reason.toUpperCase().replaceAll('-', '_')}`)
    }
  })

  it('is null for a refusal that names no home reason, so the route keeps its 400', () => {
    expect(memoryHomeUnavailable(refused())).toBeNull()
    expect(memoryHomeUnavailable(refused('path-escape'))).toBeNull()
    expect(
      memoryHomeUnavailable(new ProtocolError('CONFLICT', 'stale', { details: { reason: 'migrating' } }))
    ).toBeNull()
    expect(memoryHomeUnavailable(new Error('connection closed'))).toBeNull()
  })
})
