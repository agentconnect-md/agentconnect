import { describe, expect, it, vi } from 'vitest'
import type { McpToolDecisions } from '@agentconnect.md/protocol'
import type { McpServerDef } from '../src/config/config-schema.js'
import { connFingerprint, McpAppsHost } from '../src/mcp/apps/host.js'
import { mcpView } from '../src/mcp/cp-mcp-defs.js'

// The Apps host dials a restricted agent's `ui` definition from the daemon, before which no runtime gate stands (mcp-tool-permissions.md §7.1).

const VIEW = mcpView('org-a', 'agent-1')
const DEF: McpServerDef = {
  transport: 'http',
  url: 'https://relay.example.test/mcp/p1',
  args: [],
  env: [],
  headers: [{ name: 'Authorization', value: 'Bearer grant' }],
  ui: true
}
const DECISIONS: McpToolDecisions = { allow: ['read'], approval: ['write'], ask: ['wire'], block: ['wipe'] }

function hostWith(decisions: McpToolDecisions | undefined) {
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ran' }] }))
  const host = new McpAppsHost({
    defs: () => ({ charts: DEF }),
    scopeOf: (view) => view,
    toolDecisions: (view, name) => (view === VIEW && name === 'charts' ? decisions : undefined),
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never
  })
  const tools = new Map(
    ['read', 'write', 'wire', 'wipe'].map((name) => [
      name,
      { descriptor: { name: `charts__${name}` }, resultVisibleToModel: true, raw: {} }
    ])
  )
  ;(host as never as { dial: () => Promise<unknown> }).dial = async () => ({
    client: { callTool, close: async () => undefined },
    fingerprint: connFingerprint(DEF),
    tools,
    templates: new Map()
  })
  return { host, callTool }
}

describe('the Apps host on a restricted definition', () => {
  it('passes Always allow and refuses approval-gated and Blocked tools without calling them', async () => {
    const { host, callTool } = hostWith(DECISIONS)
    expect(await host.call(VIEW, 'charts', 'read', {})).toMatchObject({ isError: false })
    expect(callTool).toHaveBeenCalledTimes(1)
    for (const tool of ['write', 'wire']) {
      const result = await host.call(VIEW, 'charts', tool, {})
      expect(result).toMatchObject({ isError: true })
      expect(JSON.stringify(result.content)).toContain('requires approval')
    }
    expect(await host.callForView(VIEW, 'charts', 'wipe', {})).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The tool "wipe" is blocked for this agent.' }]
    })
    expect(callTool).toHaveBeenCalledTimes(1)
    expect((await host.toolsFor(VIEW, ['charts'])).map((tool) => tool.name)).toEqual(['charts__read'])
  })

  it('leaves an unrestricted definition’s tools alone', async () => {
    const { host, callTool } = hostWith(undefined)
    expect(await host.call(VIEW, 'charts', 'write', {})).toMatchObject({ isError: false })
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(await host.toolsFor(VIEW, ['charts'])).toHaveLength(4)
  })
})
