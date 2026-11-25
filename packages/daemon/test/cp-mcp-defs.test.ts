import { describe, it, expect } from 'vitest'
import { CpMcpDefs, mcpView, parseMcpView } from '../src/mcp/cp-mcp-defs.js'
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
    expect(m.converge([['org-a', 'a', httpDef('https://relay/mcp/a2'), undefined]])).toBe(false)
    expect(m.converge([['org-a', 'b', httpDef('https://relay/mcp/b'), undefined]])).toBe(true)
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

    m.converge([['org-a', 'c', httpDef('https://relay/mcp/c'), undefined]])
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

  /**
   * A proxy def is versioned by its grant, and rotation keeps the retiring and the
   * fresh grant BOTH active until the fresh one is distributed. So a definition
   * projected inside that window — a `duty/fetch` bundle, or simply a slower live
   * push — can land after the fresh key and would otherwise reinstate one the
   * relay is about to revoke, breaking the agent's tools until an unrelated update.
   */
  describe('the monotonic fence', () => {
    const bearer = (key: string, issuedAt: number): [McpServerDef, number] => [
      {
        transport: 'http',
        args: [],
        env: [],
        url: 'https://relay/mcp/p1',
        headers: [{ name: 'Authorization', value: `Bearer ${key}` }]
      },
      issuedAt
    ]

    it('refuses a def older than the one already applied, and keeps the fresh key', () => {
      const m = new CpMcpDefs({})
      const [fresh, freshAt] = bearer('oct_fresh', 2_000)
      const [retiring, retiringAt] = bearer('oct_retiring', 1_000)

      expect(m.upsert('org-a', 'p', fresh, freshAt)).toBe(true)
      expect(m.upsert('org-a', 'p', retiring, retiringAt)).toBe(false)
      expect(m.effective('org-a').p).toEqual(fresh)
    })

    it('applies a NEWER def — the rotation itself must still land', () => {
      const m = new CpMcpDefs({})
      const [retiring, retiringAt] = bearer('oct_retiring', 1_000)
      const [fresh, freshAt] = bearer('oct_fresh', 2_000)

      m.upsert('org-a', 'p', retiring, retiringAt)
      expect(m.upsert('org-a', 'p', fresh, freshAt)).toBe(true)
      expect(m.effective('org-a').p).toEqual(fresh)
    })

    it('applies an EQUAL-marker change — a relay-base swap carries the same grant', () => {
      const m = new CpMcpDefs({})
      m.upsert('org-a', 'p', httpDef('https://old-relay/mcp/p1'), 2_000)
      expect(m.upsert('org-a', 'p', httpDef('https://new-relay/mcp/p1'), 2_000)).toBe(true)
      expect(m.effective('org-a').p).toEqual(httpDef('https://new-relay/mcp/p1'))
    })

    it('an unmarked def is unordered and applies — an older CP is not fenced out', () => {
      const m = new CpMcpDefs({})
      m.upsert('org-a', 'p', httpDef('https://relay/mcp/a'), 2_000)
      expect(m.upsert('org-a', 'p', httpDef('https://relay/mcp/b'))).toBe(true)
    })

    it('the marker never reaches the runtime — `effective` returns the bare definition', () => {
      const m = new CpMcpDefs({})
      m.upsert('org-a', 'p', httpDef('https://relay/mcp/a'), 2_000)
      expect(m.effective('org-a').p).toEqual(httpDef('https://relay/mcp/a'))
      expect(JSON.stringify(m.effective('org-a'))).not.toContain('issuedAt')
    })

    it('converge RECORDS the markers it installs, so a later stale push is still refused', () => {
      const m = new CpMcpDefs({})
      const [fresh, freshAt] = bearer('oct_fresh', 2_000)
      const [retiring, retiringAt] = bearer('oct_retiring', 1_000)

      // The reconnect snapshot wins unconditionally (CP wins on reconcile)…
      m.converge([['org-a', 'p', fresh, freshAt]])
      // …but a bundle that raced it is compared against what it installed.
      expect(m.upsert('org-a', 'p', retiring, retiringAt)).toBe(false)
      expect(m.effective('org-a').p).toEqual(fresh)
    })
  })
})

describe('CpMcpDefs — agent-scoped definitions (mcp-tool-permissions.md §7.1)', () => {
  const decisions = { allow: ['read_note'], approval: [], ask: [], block: ['write_note'] }

  it('layers an agent’s own definition over its organization’s for that agent alone', () => {
    const m = new CpMcpDefs({})
    m.upsert('org-a', 'notion', httpDef('https://relay/mcp/p1#shared'))
    m.upsert('org-a', 'notion', httpDef('https://relay/mcp/p1#agent'), undefined, 'agent-1', decisions)
    expect(m.effective('org-a', 'agent-1').notion?.url).toBe('https://relay/mcp/p1#agent')
    expect(m.effective('org-a', 'agent-2').notion?.url).toBe('https://relay/mcp/p1#shared')
    expect(m.effective('org-a').notion?.url).toBe('https://relay/mcp/p1#shared')
    // Another organization never sees it, even for the same agent id.
    expect(m.effective('org-b', 'agent-1').notion).toBeUndefined()
    expect(m.toolDecisions('org-a', 'agent-1', 'notion')).toEqual(decisions)
  })

  it('removing the agent’s definition falls back to the organization’s, and leaves the organization’s alone', () => {
    const m = new CpMcpDefs({})
    m.upsert('org-a', 'notion', httpDef('https://relay/mcp/p1#shared'))
    m.upsert('org-a', 'notion', httpDef('https://relay/mcp/p1#agent'), undefined, 'agent-1')
    expect(m.remove('org-a', 'notion', 'agent-1')).toBe(true)
    expect(m.effective('org-a', 'agent-1').notion?.url).toBe('https://relay/mcp/p1#shared')
    expect(m.remove('org-a', 'notion', 'agent-1')).toBe(false)
  })

  it('treats a changed decision table as a change, and converges agent entries with the rest', () => {
    const m = new CpMcpDefs({})
    expect(m.upsert('org-a', 'notion', httpDef('https://r/a'), 1, 'agent-1', decisions)).toBe(true)
    expect(m.upsert('org-a', 'notion', httpDef('https://r/a'), 1, 'agent-1', decisions)).toBe(false)
    expect(m.upsert('org-a', 'notion', httpDef('https://r/a'), 1, 'agent-1', { ...decisions, allow: [] })).toBe(true)
    // An older grant never replaces the agent's newer key either.
    expect(m.upsert('org-a', 'notion', httpDef('https://r/old'), 0, 'agent-1')).toBe(false)
    expect(m.converge([['org-a', 'notion', httpDef('https://r/shared'), 1]])).toBe(true)
    expect(m.effective('org-a', 'agent-1').notion?.url).toBe('https://r/shared')
    expect(
      m.converge([
        ['org-a', 'notion', httpDef('https://r/shared'), 1],
        ['org-a', 'notion', httpDef('https://r/a'), 1, 'agent-1', decisions]
      ])
    ).toBe(true)
    expect(m.effective('org-a', 'agent-1').notion?.url).toBe('https://r/a')
  })

  it('names the owner of each definition a view resolves, which is what keys a hosted connection', () => {
    const m = new CpMcpDefs({ clock: stdioDef('clock') })
    m.upsert('org-a', 'charts', httpDef('https://r/charts'))
    m.upsert('org-a', 'notion', httpDef('https://r/notion'), undefined, 'agent-1')
    const view = mcpView('org-a', 'agent-1')
    expect(m.scopeOf(view, 'notion')).toBe(view)
    // A shared definition stays keyed by the organization, so agents keep sharing its connection.
    expect(m.scopeOf(view, 'charts')).toBe('org-a')
    expect(m.scopeOf(mcpView('org-a', 'agent-2'), 'charts')).toBe('org-a')
    expect(m.scopeOf(view, 'clock')).toBeUndefined()
    expect(m.views().sort()).toEqual(['org-a', view].sort())
    expect(m.orgs()).toEqual(['org-a'])
    expect(parseMcpView(view)).toEqual({ orgId: 'org-a', agentId: 'agent-1' })
  })
})
