import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MemoryContextRequest, MemoryEntryGetRequest, MemoryEntryListRequest } from './memory-entries.js'

describe('memory entries v1 request contract', () => {
  it('shares bounded defaults across future model and admin projections', () => {
    expect(MemoryEntryListRequest.parse({})).toEqual({ limit: 20 })
    expect(MemoryEntryGetRequest.parse({ ref: 'opaque' })).toEqual({ ref: 'opaque', maxBytes: 32768 })
    expect(MemoryContextRequest.parse({})).toEqual({ maxBytes: 25000 })
    const descriptor = z.toJSONSchema(MemoryEntryListRequest)
    expect(descriptor.additionalProperties).toBe(false)
    expect(descriptor.properties?.limit).toMatchObject({ minimum: 1, maximum: 100, default: 20 })
  })

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { cursor: '' },
    { cursor: 'c'.repeat(2049) },
    { agentId: 'foreign' },
    { connectionId: 'foreign' },
    { root: '/another/home' }
  ])('rejects invalid enumeration arguments %j', (args) => {
    expect(MemoryEntryListRequest.safeParse(args).success).toBe(false)
  })

  it('requires a reference and a content budget large enough for a UTF-8 character', () => {
    expect(MemoryEntryGetRequest.safeParse({ id: 'legacy-id' }).success).toBe(false)
    expect(MemoryEntryGetRequest.safeParse({ ref: 'opaque', maxBytes: 3 }).success).toBe(false)
    expect(MemoryEntryGetRequest.safeParse({ ref: 'opaque', maxBytes: 32769 }).success).toBe(false)
    expect(MemoryEntryGetRequest.safeParse({ ref: 'opaque', maxBytes: 4 }).success).toBe(true)
  })
})
