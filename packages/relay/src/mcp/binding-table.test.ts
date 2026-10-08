import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { McpBindingTable } from './binding-table.js'

const PID = '11111111-1111-4111-8111-111111111111'
const hash = (k: string) => createHash('sha256').update(k).digest('hex')
const headers = [{ name: 'Authorization', value: 'Bearer upstream-secret' }]

describe('McpBindingTable — grant → upstream resolution', () => {
  it('resolves a bound providerId + valid grant key to its upstream; rejects wrong key / unknown provider', () => {
    const t = new McpBindingTable()
    t.assign({ providerId: PID, upstreamUrl: 'https://mcp.notion.com', headers, grantKeyHashes: [hash('grant-1')] })

    expect(t.resolve(PID, 'grant-1')).toEqual({ upstreamUrl: 'https://mcp.notion.com', headers })
    expect(t.resolve(PID, 'wrong-key')).toBeNull()
    expect(t.resolve('22222222-2222-4222-8222-222222222222', 'grant-1')).toBeNull()
  })

  it('assign replaces the whole binding (keys + upstream)', () => {
    const t = new McpBindingTable()
    t.assign({ providerId: PID, upstreamUrl: 'https://a', headers, grantKeyHashes: [hash('k1')] })
    t.assign({ providerId: PID, upstreamUrl: 'https://b', headers, grantKeyHashes: [hash('k2')] })
    expect(t.resolve(PID, 'k1')).toBeNull() // old key retired by replace
    expect(t.resolve(PID, 'k2')?.upstreamUrl).toBe('https://b')
  })

  it('unassign drops a whole provider, or retires one grant hash (and drops the provider when the last key goes)', () => {
    const t = new McpBindingTable()
    t.assign({ providerId: PID, upstreamUrl: 'https://a', headers, grantKeyHashes: [hash('k1'), hash('k2')] })

    t.unassign(PID, hash('k1')) // rotation: retire one key
    expect(t.resolve(PID, 'k1')).toBeNull()
    expect(t.resolve(PID, 'k2')).not.toBeNull()

    t.unassign(PID, hash('k2')) // last key gone → provider dropped
    expect(t.size()).toBe(0)

    t.assign({ providerId: PID, upstreamUrl: 'https://a', headers, grantKeyHashes: [hash('k1')] })
    t.unassign(PID) // whole-provider drop
    expect(t.size()).toBe(0)
  })
})

describe('McpBindingTable — reconnect snapshot', () => {
  const SNAP = '33333333-3333-4333-8333-333333333333'
  const REVOKED = '22222222-2222-4222-8222-222222222222'
  const bind = (t: McpBindingTable, providerId: string) =>
    t.assign({ providerId, upstreamUrl: 'https://a', headers, grantKeyHashes: [hash('k1')] })

  it('keeps serving during the replay and drops a provider revoked while the link was down', () => {
    const t = new McpBindingTable()
    bind(t, PID)
    bind(t, REVOKED)
    t.beginSnapshot(SNAP)
    // Nothing is dropped before the replay completes: every binding still resolves.
    expect(t.resolve(REVOKED, 'k1')).not.toBeNull()
    bind(t, PID)
    t.endSnapshot(SNAP, [])
    expect(t.resolve(PID, 'k1')).not.toBeNull()
    expect(t.resolve(REVOKED, 'k1')).toBeNull()
  })

  it('keeps a provider the CP withheld because it failed to replay it', () => {
    const t = new McpBindingTable()
    bind(t, PID)
    t.beginSnapshot(SNAP)
    t.endSnapshot(SNAP, [PID])
    expect(t.resolve(PID, 'k1')).not.toBeNull()
  })

  it('prunes nothing when the snapshot never ends', () => {
    const t = new McpBindingTable()
    bind(t, PID)
    t.beginSnapshot(SNAP)
    t.abandonSnapshot()
    t.endSnapshot(SNAP, [])
    expect(t.resolve(PID, 'k1')).not.toBeNull()
  })
})
