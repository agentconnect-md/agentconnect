import { describe, it, expect } from 'vitest'
import { CpMcpDefs } from '../src/mcp/cp-mcp-defs.js'
import type { McpServerDef } from '../src/config/config-schema.js'

const httpDef = (url: string): McpServerDef => ({ transport: 'http', args: [], env: [], url, headers: [] })
const stdioDef = (command: string): McpServerDef => ({ transport: 'stdio', command, args: [], env: [], headers: [] })

describe('CpMcpDefs — CP-pushed defs layered over local config', () => {
  it('a CP def wins over a same-named local def, and the local def is restored on remove', () => {
    const m = new CpMcpDefs({ notion: stdioDef('local-notion') })
    expect(m.effective('org-a').notion).toEqual(stdioDef('local-notion'))

    expect(m.upsert('org-a', 'notion', httpDef('https://relay/mcp/p1'))).toBe(true)
    expect(m.effective('org-a').notion).toEqual(httpDef('https://relay/mcp/p1'))

    expect(m.remove('org-a', 'notion')).toBe(true)
    expect(m.effective('org-a').notion).toEqual(stdioDef('local-notion'))
  })

  it('reports whether an op changed the set — idempotent re-push and no-op converge return false', () => {
    const m = new CpMcpDefs({})
    expect(m.upsert('org-a', 'a', httpDef('https://relay/mcp/a'))).toBe(true)
    expect(m.upsert('org-a', 'a', httpDef('https://relay/mcp/a'))).toBe(false)
    expect(m.upsert('org-a', 'a', httpDef('https://relay/mcp/a2'))).toBe(true)
    expect(m.remove('org-a', 'missing')).toBe(false)
    expect(m.converge([['org-a', 'a', httpDef('https://relay/mcp/a2')]])).toBe(false)
    expect(m.converge([['org-a', 'b', httpDef('https://relay/mcp/b')]])).toBe(true)
  })

  it('local-only and CP-only names both pass through; remove of an absent name is a no-op', () => {
    const m = new CpMcpDefs({ localOnly: stdioDef('x') })
    m.upsert('org-a', 'cpOnly', httpDef('https://relay/mcp/p2'))
    expect(Object.keys(m.effective('org-a')).sort()).toEqual(['cpOnly', 'localOnly'])
    expect(m.remove('org-a', 'missing')).toBe(false)
    expect(m.remove('org-a', 'cpOnly')).toBe(true)
    expect(Object.keys(m.effective('org-a'))).toEqual(['localOnly'])
  })

  it('converge FULL-REPLACES the CP set — a def absent from the snapshot is pruned, local survives', () => {
    const m = new CpMcpDefs({ base: stdioDef('b') })
    m.upsert('org-a', 'a', httpDef('https://relay/mcp/a'))
    m.upsert('org-a', 'b', httpDef('https://relay/mcp/b'))

    m.converge([['org-a', 'c', httpDef('https://relay/mcp/c')]])
    const eff = m.effective('org-a')
    expect(eff.a).toBeUndefined()
    expect(eff.c).toEqual(httpDef('https://relay/mcp/c'))
    expect(eff.base).toEqual(stdioDef('b'))
  })

  it('keeps same-named CP definitions isolated by organization', () => {
    const m = new CpMcpDefs({})
    m.upsert('org-a', 'shared-name', httpDef('https://relay/mcp/a'))
    m.upsert('org-b', 'shared-name', httpDef('https://relay/mcp/b'))

    expect(m.effective('org-a')['shared-name']).toEqual(httpDef('https://relay/mcp/a'))
    expect(m.effective('org-b')['shared-name']).toEqual(httpDef('https://relay/mcp/b'))
  })
})
