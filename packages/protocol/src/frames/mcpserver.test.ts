import { describe, it, expect } from 'vitest'
import { McpServerRemove, McpServerSpec } from './mcpserver.js'

const base = { orgId: 'org-a', name: 'notion', transport: 'http', url: 'https://relay.example.test/mcp/p1' }

describe('McpServerSpec — agent-scoped definitions (mcp-tool-permissions.md §7.1)', () => {
  it('carries an agent id and a decision table, with each list defaulting to empty', () => {
    const spec = McpServerSpec.parse({ ...base, agentId: 'agent-1', toolDecisions: { allow: ['read_note'] } })
    expect(spec.agentId).toBe('agent-1')
    expect(spec.toolDecisions).toEqual({ allow: ['read_note'], approval: [], ask: [], block: [] })
  })

  it('still decodes an organization definition without either field', () => {
    const spec = McpServerSpec.parse(base)
    expect(spec.agentId).toBeUndefined()
    expect(spec.toolDecisions).toBeUndefined()
  })

  it('refuses an empty agent id or tool name', () => {
    expect(McpServerSpec.safeParse({ ...base, agentId: '' }).success).toBe(false)
    expect(McpServerSpec.safeParse({ ...base, toolDecisions: { allow: [''] } }).success).toBe(false)
  })

  it('lets a remove name one agent’s own definition', () => {
    expect(McpServerRemove.parse({ orgId: 'org-a', agentId: 'agent-1', name: 'notion' }).agentId).toBe('agent-1')
    expect(McpServerRemove.parse({ orgId: 'org-a', name: 'notion' }).agentId).toBeUndefined()
  })
})
