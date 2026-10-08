import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryConnectionBindingTable } from './binding-table.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

describe('MemoryConnectionBindingTable — purpose-separated per-connection grants', () => {
  it('resolves only the exact connection grant and never an MCP/provider id', () => {
    const table = new MemoryConnectionBindingTable()
    const headers = [{ name: 'X-Api-Key', value: 'upstream-secret' }]
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 1,
      upstreamUrl: 'https://plugin.example/mcp',
      headers,
      grantKeyHashes: [hash('memory-grant')]
    })
    expect(table.resolve(CONNECTION_ID, 'memory-grant')).toEqual({
      upstreamUrl: 'https://plugin.example/mcp',
      headers
    })
    expect(table.resolve(CONNECTION_ID, 'mcp-provider-grant')).toBeNull()
    expect(table.resolve('22222222-2222-4222-8222-222222222222', 'memory-grant')).toBeNull()
  })

  it('supports overlap-safe rotation then revokes the retired hash immediately', () => {
    const table = new MemoryConnectionBindingTable()
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 1,
      upstreamUrl: 'https://plugin.example/mcp',
      headers: [],
      grantKeyHashes: [hash('old'), hash('fresh')]
    })
    expect(table.resolve(CONNECTION_ID, 'old')).not.toBeNull()
    expect(table.resolve(CONNECTION_ID, 'fresh')).not.toBeNull()

    table.unassign(CONNECTION_ID, 1, hash('old'))
    expect(table.resolve(CONNECTION_ID, 'old')).toBeNull()
    expect(table.resolve(CONNECTION_ID, 'fresh')).not.toBeNull()
    table.unassign(CONNECTION_ID, 2)
    expect(table.size()).toBe(0)
  })

  it('ignores a delayed stale assignment after a newer update or delete tombstone', () => {
    const table = new MemoryConnectionBindingTable()
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 2,
      upstreamUrl: 'https://new.example/mcp',
      headers: [],
      grantKeyHashes: [hash('new')]
    })
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 1,
      upstreamUrl: 'https://old.example/mcp',
      headers: [],
      grantKeyHashes: [hash('old')]
    })
    expect(table.resolve(CONNECTION_ID, 'new')?.upstreamUrl).toBe('https://new.example/mcp')
    expect(table.resolve(CONNECTION_ID, 'old')).toBeNull()

    table.unassign(CONNECTION_ID, 3)
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 2,
      upstreamUrl: 'https://new.example/mcp',
      headers: [],
      grantKeyHashes: [hash('new')]
    })
    expect(table.resolve(CONNECTION_ID, 'new')).toBeNull()
    expect(table.size()).toBe(0)
  })

  it('does not let a conflicting equal-revision assignment replace credentials', () => {
    const table = new MemoryConnectionBindingTable()
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 2,
      upstreamUrl: 'https://first.example/mcp',
      headers: [{ name: 'Authorization', value: 'upstream-secret' }],
      grantKeyHashes: [hash('first')]
    })
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 2,
      upstreamUrl: 'https://equivocated.example/mcp',
      headers: [{ name: 'Authorization', value: 'other-secret' }],
      grantKeyHashes: [hash('second')]
    })

    expect(table.resolve(CONNECTION_ID, 'first')).toEqual({
      upstreamUrl: 'https://first.example/mcp',
      headers: [{ name: 'Authorization', value: 'upstream-secret' }]
    })
    expect(table.resolve(CONNECTION_ID, 'second')).toBeNull()
  })

  it('clears stale grants only when a fresh CP registration baseline begins', () => {
    const table = new MemoryConnectionBindingTable()
    table.assign({
      connectionId: CONNECTION_ID,
      revision: 1,
      upstreamUrl: 'https://plugin.example/mcp',
      headers: [],
      grantKeyHashes: [hash('grant')]
    })

    table.clear()

    expect(table.resolve(CONNECTION_ID, 'grant')).toBeNull()
    expect(table.size()).toBe(0)
  })
})

describe('MemoryConnectionBindingTable — reconnect snapshot', () => {
  const SNAP = '33333333-3333-4333-8333-333333333333'
  const DELETED = '22222222-2222-4222-8222-222222222222'
  const bind = (table: MemoryConnectionBindingTable, connectionId: string, revision = 1) =>
    table.assign({
      connectionId,
      revision,
      upstreamUrl: 'https://plugin.example/mcp',
      headers: [],
      grantKeyHashes: [hash('memory-grant')]
    })

  it('keeps every binding serving until the replay ends, then drops the ones it no longer names', () => {
    const table = new MemoryConnectionBindingTable()
    bind(table, CONNECTION_ID, 3)
    bind(table, DELETED)
    table.beginSnapshot(SNAP)
    expect(table.resolve(DELETED, 'memory-grant')).not.toBeNull()
    // The replay re-sends the unchanged revision: ignored as an update, still counted as current.
    bind(table, CONNECTION_ID, 3)
    table.endSnapshot(SNAP, [])
    expect(table.resolve(CONNECTION_ID, 'memory-grant')).not.toBeNull()
    expect(table.resolve(DELETED, 'memory-grant')).toBeNull()
  })

  it('keeps a deletion that landed during the replay, so a delayed older assign cannot restore it', async () => {
    const table = new MemoryConnectionBindingTable()
    bind(table, DELETED, 2)
    table.beginSnapshot(SNAP)
    table.unassign(DELETED, 3)
    table.endSnapshot(SNAP, [])
    bind(table, DELETED, 2)
    expect(table.resolve(DELETED, 'memory-grant')).toBeNull()
  })

  it('keeps the revision of a binding it prunes, so only a newer assign re-enables it', async () => {
    const table = new MemoryConnectionBindingTable()
    bind(table, DELETED, 2)
    table.beginSnapshot(SNAP)
    table.endSnapshot(SNAP, [])
    bind(table, DELETED, 2)
    expect(table.resolve(DELETED, 'memory-grant')).toBeNull()
    bind(table, DELETED, 3)
    expect(table.resolve(DELETED, 'memory-grant')).not.toBeNull()
  })
})
