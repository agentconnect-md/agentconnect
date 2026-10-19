import { describe, expect, it } from 'vitest'
import { AhpSessionUri } from '@agentconnect.md/protocol'
import { historicalSessionUri } from './ahpSessionUri.js'

describe('historical AHP session URI', () => {
  it('exports arbitrary opaque ids without encoding aliases or unbounded URI length', () => {
    const values = ['runtime:id/with space%?#', '界'.repeat(256), 'runtime-id', 'runtime/id']
    const uris = values.map((sessionId) => historicalSessionUri({ orgId: 'org', agentId: 'agent', sessionId }))
    expect(new Set(uris).size).toBe(values.length)
    for (const uri of uris) {
      expect(AhpSessionUri.safeParse(uri).success).toBe(true)
      expect(uri.length).toBeLessThan(512)
    }
    expect(historicalSessionUri({ orgId: 'org', agentId: 'agent', sessionId: values[0]! })).toBe(uris[0])
    expect(historicalSessionUri({ orgId: 'other', agentId: 'agent', sessionId: values[0]! })).not.toBe(uris[0])
    expect(historicalSessionUri({ orgId: 'org', agentId: 'other', sessionId: values[0]! })).not.toBe(uris[0])
  })
})
