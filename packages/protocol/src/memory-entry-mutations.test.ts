import { describe, expect, it } from 'vitest'
import { MemoryEntryCreateRequest, MemoryEntryUpdateRequest, MemoryEntryDeleteRequest } from './memory-entries.js'

describe('entry mutation requests', () => {
  it('requires exactly one replacement mode and permits literal empty replacement text', () => {
    expect(MemoryEntryUpdateRequest.safeParse({ ref: 'opaque', text: '' }).success).toBe(true)
    expect(MemoryEntryUpdateRequest.safeParse({ ref: 'opaque', edit: { oldText: 'old', newText: '' } }).success).toBe(
      true
    )
    for (const value of [
      { ref: 'opaque' },
      { ref: 'opaque', text: '', edit: { oldText: 'old', newText: '' } },
      { ref: 'opaque', edit: { oldText: '', newText: 'new' } }
    ])
      expect(MemoryEntryUpdateRequest.safeParse(value).success).toBe(false)
  })
  it('keeps scope, source and operation identity outside caller-controlled arguments', () => {
    for (const field of ['agentId', 'root', 'source', 'sourceTurnId', 'operationId']) {
      expect(MemoryEntryCreateRequest.safeParse({ text: 'new', [field]: 'forged' }).success).toBe(false)
      expect(MemoryEntryUpdateRequest.safeParse({ ref: 'opaque', text: 'new', [field]: 'forged' }).success).toBe(false)
      expect(MemoryEntryDeleteRequest.safeParse({ ref: 'opaque', [field]: 'forged' }).success).toBe(false)
    }
  })
})
