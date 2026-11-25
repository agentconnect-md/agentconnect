/**
 * The two ways a CP-pushed `ui: true` definition can be present and still never reach a session:
 * arriving on the reconnect snapshot without announcing itself, and being keyed as though a
 * daemon-local server belonged to one organization.
 */
import { describe, it, expect, vi } from 'vitest'
import { CpMcpDefs } from '../src/mcp/cp-mcp-defs.js'
import { applyMcpServerRemove, applyMcpServerUpsert, applyReconcileSnapshot } from '../src/cp/config-apply-handlers.js'

const ORG = 'org-a'
const DEF = { transport: 'http' as const, url: 'https://relay.example.test/mcp/p1', args: [], env: [], headers: [] }

describe('a CP definition arriving on the reconnect snapshot', () => {
  /**
   * The snapshot applier touches a great deal of the daemon. Only the MCP-definition half is under
   * test, so the host answers those members concretely and everything else with an inert function
   * — which keeps the REAL applier running (the point of the test) without restating its whole
   * surface, and makes the test survive an unrelated member being added to it.
   */
  function hostWith(defs: CpMcpDefs, onMcpDefsChanged: () => void) {
    const noop = () => undefined
    const known: Record<string, unknown> = {
      cpMcpDefs: () => defs,
      onMcpDefsChanged,
      log: () => ({ warn: noop, info: noop, debug: noop, error: noop }),
      cpDroppedAgents: () => new Set<string>(),
      drainingAgents: () => new Set<string>(),
      cpCollab: () => ({ replace: noop }),
      cpRouting: () => ({ converge: noop })
    }
    return new Proxy(known, {
      get: (target, key: string) => target[key] ?? (() => undefined)
    }) as never
  }

  const snapshot = {
    agents: [],
    assignments: [],
    leases: [],
    relays: [],
    collabRoutes: [],
    routingEpoch: 1,
    crons: [],
    integrations: [],
    drop: { assignments: [], crons: [], agents: [], integrations: [] },
    mcpServers: [{ orgId: ORG, name: 'charts', ...DEF, ui: true }]
  } as never

  it('announces itself, so its connection is opened rather than waiting for an unrelated push', async () => {
    const defs = new CpMcpDefs({})
    const changed = vi.fn()
    await applyReconcileSnapshot(hostWith(defs, changed), snapshot)
    // Every daemon start takes this path. Without the announcement the definition is present but
    // its connection is never dialed, so its tools are missing from every session until some other
    // push happens to change something.
    expect(changed).toHaveBeenCalled()
    expect(defs.effective(ORG).charts).toMatchObject({ ui: true })
  })

  it('stays quiet when the snapshot changes nothing, so an idle reconnect re-dials nothing', async () => {
    const defs = new CpMcpDefs({})
    await applyReconcileSnapshot(hostWith(defs, vi.fn()), snapshot)
    const changed = vi.fn()
    await applyReconcileSnapshot(hostWith(defs, changed), snapshot)
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('CpMcpDefs.isOrgScoped — what a connection may be keyed by', () => {
  it('separates an org’s own definition from the daemon-local one every org shares', () => {
    const defs = new CpMcpDefs({ clock: DEF })
    defs.upsert(ORG, 'charts', DEF, 1)
    expect(defs.isOrgScoped(ORG, 'charts')).toBe(true)
    // Local: shared by every org, so it must NOT be keyed per org.
    expect(defs.isOrgScoped(ORG, 'clock')).toBe(false)
    expect(defs.isOrgScoped(undefined, 'clock')).toBe(false)
    // Another org does not own the first org's definition.
    expect(defs.isOrgScoped('org-b', 'charts')).toBe(false)
  })
})

describe('agent-scoped definitions on the CP frame paths', () => {
  const noop = () => undefined
  const hostWith = (defs: CpMcpDefs, onMcpDefsChanged: () => void) =>
    new Proxy(
      {
        cpMcpDefs: () => defs,
        onMcpDefsChanged,
        log: () => ({ warn: noop, info: noop, debug: noop, error: noop }),
        cpDroppedAgents: () => new Set<string>(),
        drainingAgents: () => new Set<string>(),
        cpCollab: () => ({ replace: noop }),
        cpRouting: () => ({ converge: noop })
      } as Record<string, unknown>,
      { get: (target, key: string) => target[key] ?? (() => undefined) }
    ) as never
  const decisions = { allow: ['read_note'], approval: [], ask: [], block: [] }

  it('installs the agent layer from the snapshot, a live upsert, and removes it on an agent-scoped remove', async () => {
    const defs = new CpMcpDefs({})
    const changed = vi.fn()
    await applyReconcileSnapshot(hostWith(defs, changed), {
      agents: [],
      assignments: [],
      leases: [],
      relays: [],
      collabRoutes: [],
      routingEpoch: 1,
      crons: [],
      integrations: [],
      drop: { assignments: [], crons: [], agents: [], integrations: [] },
      mcpServers: [
        { orgId: ORG, name: 'notion', ...DEF },
        {
          orgId: ORG,
          agentId: 'agent-1',
          name: 'notion',
          ...DEF,
          url: 'https://relay.example.test/mcp/p1#a',
          toolDecisions: decisions
        }
      ]
    } as never)
    expect(changed).toHaveBeenCalled()
    expect(defs.effective(ORG, 'agent-1').notion?.url).toBe('https://relay.example.test/mcp/p1#a')
    expect(defs.effective(ORG, 'agent-2').notion?.url).toBe(DEF.url)
    // The routing fields never leak into the definition the runtime is handed.
    expect(defs.effective(ORG, 'agent-1').notion).not.toHaveProperty('agentId')
    expect(defs.effective(ORG, 'agent-1').notion).not.toHaveProperty('toolDecisions')
    expect(defs.toolDecisions(ORG, 'agent-1', 'notion')).toEqual(decisions)

    applyMcpServerUpsert(hostWith(defs, vi.fn()), {
      orgId: ORG,
      agentId: 'agent-2',
      name: 'notion',
      ...DEF,
      url: 'https://relay.example.test/mcp/p1#b'
    } as never)
    expect(defs.effective(ORG, 'agent-2').notion?.url).toBe('https://relay.example.test/mcp/p1#b')
    applyMcpServerRemove(hostWith(defs, vi.fn()), { orgId: ORG, agentId: 'agent-2', name: 'notion' })
    expect(defs.effective(ORG, 'agent-2').notion?.url).toBe(DEF.url)
  })
})
