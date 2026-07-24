import { describe, it, expect } from 'vitest'
import { CpMcpDefs } from '../src/mcp/cp-mcp-defs.js'
import type { McpServerDef } from '../src/config/config-schema.js'

const httpDef = (url: string): McpServerDef => ({ transport: 'http', args: [], env: [], url, headers: [] })
const stdioDef = (command: string): McpServerDef => ({ transport: 'stdio', command, args: [], env: [], headers: [] })

describe('CpMcpDefs — CP-pushed defs layered over local config', () => {
  it('a CP def wins over a same-named local def, and the local def is restored on remove', () => {
    const m = new CpMcpDefs({ notion: stdioDef('local-notion') })
    expect(m.effective().notion).toEqual(stdioDef('local-notion'))

    expect(m.upsert('notion', httpDef('https://relay/mcp/p1'))).toBe(true) // CP shadows local
    expect(m.effective().notion).toEqual(httpDef('https://relay/mcp/p1'))

    expect(m.remove('notion')).toBe(true) // local restored, not deleted
    expect(m.effective().notion).toEqual(stdioDef('local-notion'))
  })

  it('reports whether an op changed the set — idempotent re-push and no-op converge return false', () => {
    const m = new CpMcpDefs({})
    expect(m.upsert('a', httpDef('https://relay/mcp/a'))).toBe(true)
    expect(m.upsert('a', httpDef('https://relay/mcp/a'))).toBe(false) // identical re-push — no churn
    expect(m.upsert('a', httpDef('https://relay/mcp/a2'))).toBe(true) // value changed
    expect(m.remove('missing')).toBe(false)
    expect(m.converge([['a', httpDef('https://relay/mcp/a2')]])).toBe(false) // same set
    expect(m.converge([['b', httpDef('https://relay/mcp/b')]])).toBe(true) // different set
  })

  it('local-only and CP-only names both pass through; remove of an absent name is a no-op', () => {
    const m = new CpMcpDefs({ localOnly: stdioDef('x') })
    m.upsert('cpOnly', httpDef('https://relay/mcp/p2'))
    expect(Object.keys(m.effective()).sort()).toEqual(['cpOnly', 'localOnly'])
    expect(m.remove('missing')).toBe(false)
    expect(m.remove('cpOnly')).toBe(true)
    expect(Object.keys(m.effective())).toEqual(['localOnly'])
  })

  it('converge FULL-REPLACES the CP set — a def absent from the snapshot is pruned, local survives', () => {
    const m = new CpMcpDefs({ base: stdioDef('b') })
    m.upsert('a', httpDef('https://relay/mcp/a'))
    m.upsert('b', httpDef('https://relay/mcp/b')) // CP shadows local base

    m.converge([['c', httpDef('https://relay/mcp/c')]]) // reconnect snapshot: only c
    const eff = m.effective()
    expect(eff.a).toBeUndefined() // pruned (not in snapshot)
    expect(eff.c).toEqual(httpDef('https://relay/mcp/c'))
    expect(eff.base).toEqual(stdioDef('b')) // local unshadowed again (b no longer in CP set)
  })
})
