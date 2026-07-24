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
