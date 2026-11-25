import { describe, it, expect, vi } from 'vitest'
import { MCP_TOOL_POLICY_V1_FEATURE, type McpCatalogTool, type RcMcpCatalogOk } from '@agentconnect.md/protocol'
import { McpToolCatalogService } from './mcpToolCatalog.js'
import { OrgId } from '../domain/ids.js'
import { RequestTimeout } from '../ws/correlator.js'
import { ConnectionClosed } from '../ws/registry.js'
import type { McpToolCatalogRecord, McpToolCatalogRepo } from '../persistence/ports.js'
import type { RelayChannel } from '../ws/relay-registry.js'

const ORG = OrgId('org-1')
const PROVIDER = '77777777-7777-4777-8777-777777777777'
const NOW = Date.UTC(2026, 10, 25)
const TOOL: McpCatalogTool = { name: 'list_issues', readOnlyHint: true, interactive: false }

class MemoryCatalogs implements McpToolCatalogRepo {
  rows = new Map<string, McpToolCatalogRecord>()
  async get(_orgId: OrgId, providerId: string) {
    return this.rows.get(providerId) ?? null
  }
  async put(_orgId: OrgId, providerId: string, snapshot: Omit<McpToolCatalogRecord, 'mcpProviderId'>) {
    this.rows.set(providerId, { mcpProviderId: providerId, ...snapshot })
  }
  async recordFailure(_orgId: OrgId, providerId: string, failure: string) {
    const prev = this.rows.get(providerId)
    this.rows.set(
      providerId,
      prev ? { ...prev, failure } : { mcpProviderId: providerId, tools: [], fetchedAt: null, failure }
    )
  }
}

function relay(
  relayId: string,
  features: string[],
  answer?: (providerId: string) => Promise<RcMcpCatalogOk>
): RelayChannel & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (_type: string, payload: { providerId: string }) =>
    answer ? answer(payload.providerId) : { tools: [] }
  )
  return { relayId, features, send: vi.fn(), close: vi.fn(), request } as unknown as RelayChannel & {
    request: ReturnType<typeof vi.fn>
  }
}

function service(relays: RelayChannel[], catalogs = new MemoryCatalogs()) {
  const warn = vi.fn()
  const svc = new McpToolCatalogService({
    relays: { all: () => relays },
    catalogs,
    clock: { now: () => NOW },
    log: { warn }
  })
  return { svc, catalogs, warn }
}

describe('McpToolCatalogService', () => {
  it('asks only a relay that advertises tool policies', async () => {
    const old = relay('old', [])
    const capable = relay('capable', [MCP_TOOL_POLICY_V1_FEATURE], async () => ({ tools: [TOOL] }))
    const { svc } = service([old, capable])
    await svc.refresh(ORG, PROVIDER)
    expect(old.request).not.toHaveBeenCalled()
    expect(capable.request).toHaveBeenCalledWith('rc/mcp-catalog', { providerId: PROVIDER })
  })

  it('records relay_unavailable without a capable relay, or with one that cannot request', async () => {
    const fake = { relayId: 'fake', features: [MCP_TOOL_POLICY_V1_FEATURE], send: vi.fn(), close: vi.fn() }
    const { svc } = service([relay('old', []), fake])
    expect(await svc.refresh(ORG, PROVIDER)).toEqual({
      mcpProviderId: PROVIDER,
      tools: [],
      fetchedAt: null,
      failure: 'relay_unavailable'
    })
  })

  it('replaces the tools and clears the failure on success', async () => {
    const catalogs = new MemoryCatalogs()
    await catalogs.put(ORG, PROVIDER, {
      tools: [{ name: 'old', interactive: false }],
      fetchedAt: new Date(0),
      failure: 'timeout'
    })
    const { svc } = service([relay('r', [MCP_TOOL_POLICY_V1_FEATURE], async () => ({ tools: [TOOL] }))], catalogs)
    expect(await svc.refresh(ORG, PROVIDER)).toEqual({
      mcpProviderId: PROVIDER,
      tools: [TOOL],
      fetchedAt: new Date(NOW),
      failure: null
    })
  })

  it.each([
    [
      'a relay failure code',
      async (): Promise<RcMcpCatalogOk> => ({ failure: 'upstream_rejected' }),
      'upstream_rejected'
    ],
    [
      'a timeout',
      async (): Promise<RcMcpCatalogOk> => Promise.reject(new RequestTimeout('INTERNAL', 'x')),
      'relay_timeout'
    ],
    [
      'a closed socket',
      async (): Promise<RcMcpCatalogOk> => Promise.reject(new ConnectionClosed()),
      'relay_unavailable'
    ],
    [
      'a relay error frame',
      async (): Promise<RcMcpCatalogOk> => Promise.reject(new Error('secret upstream detail')),
      'relay_unavailable'
    ]
  ])('keeps the previous tools and records the code on %s', async (_label, answer, code) => {
    const catalogs = new MemoryCatalogs()
    const fetchedAt = new Date(NOW - 60_000)
    await catalogs.put(ORG, PROVIDER, { tools: [TOOL], fetchedAt, failure: null })
    const { svc, warn } = service([relay('r', [MCP_TOOL_POLICY_V1_FEATURE], answer)], catalogs)
    expect(await svc.refresh(ORG, PROVIDER)).toEqual({
      mcpProviderId: PROVIDER,
      tools: [TOOL],
      fetchedAt,
      failure: code
    })
    expect(warn).toHaveBeenCalledWith(
      { providerId: PROVIDER, failure: code, relayId: 'r' },
      'mcp tool catalog: fetch failed'
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
  })

  it('runs one refresh per provider at a time, in order', async () => {
    const replies: Array<(r: RcMcpCatalogOk) => void> = []
    const r = relay('r', [MCP_TOOL_POLICY_V1_FEATURE], () => new Promise((resolve) => replies.push(resolve)))
    const { svc, catalogs } = service([r])
    const first = svc.refresh(ORG, PROVIDER)
    const second = svc.refresh(ORG, PROVIDER)
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    replies[0]!({ tools: [{ name: 'first', interactive: false }] })
    await first
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    replies[1]!({ tools: [TOOL] })
    await second
    expect(r.request).toHaveBeenCalledTimes(2)
    expect((await catalogs.get(ORG, PROVIDER))?.tools).toEqual([TOOL])
  })

  it('schedules a refresh the caller does not wait for, and settles it on demand', async () => {
    const { svc, catalogs } = service([relay('r', [MCP_TOOL_POLICY_V1_FEATURE], async () => ({ tools: [TOOL] }))])
    svc.schedule(ORG, PROVIDER)
    await svc.settle()
    expect((await catalogs.get(ORG, PROVIDER))?.tools).toEqual([TOOL])
  })

  it('logs a scheduled refresh whose store write throws instead of rejecting', async () => {
    const catalogs = new MemoryCatalogs()
    catalogs.recordFailure = async () => {
      throw new Error('mcp tool catalog write outside its organization')
    }
    const { svc, warn } = service([], catalogs)
    svc.schedule(ORG, PROVIDER)
    await svc.settle()
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerId: PROVIDER }),
      'mcp tool catalog: scheduled refresh failed'
    )
  })
})
