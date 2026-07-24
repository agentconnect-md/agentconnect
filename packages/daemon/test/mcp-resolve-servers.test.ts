import { describe, it, expect, vi } from 'vitest'
import { resolveAgentMcpServers, RESERVED_MCP_SERVER_NAME } from '../src/mcp/resolve-servers.js'
import { McpServerDefSchema, type McpServerDef } from '../src/config/config-schema.js'

const defs: Record<string, McpServerDef> = {
  files: McpServerDefSchema.parse({
    command: 'mcp-files',
    args: ['--root', '/data'],
    env: [{ name: 'A', value: '1' }]
  }),
  search: McpServerDefSchema.parse({
    transport: 'http',
    url: 'http://localhost:9000/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer t' }]
  }),
  legacy: McpServerDefSchema.parse({ transport: 'sse', url: 'http://localhost:9001/sse' })
}

describe('resolveAgentMcpServers', () => {
  it('builds the untagged stdio variant and the tagged http/sse variants', () => {
    const servers = resolveAgentMcpServers({
      enabled: ['files', 'search', 'legacy'],
      defs,
      caps: { http: true, sse: true }
    })
    expect(servers).toEqual([
      { name: 'files', command: 'mcp-files', args: ['--root', '/data'], env: [{ name: 'A', value: '1' }] },
      {
        type: 'http',
        name: 'search',
        url: 'http://localhost:9000/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer t' }]
      },
      { type: 'sse', name: 'legacy', url: 'http://localhost:9001/sse', headers: [] }
    ])
  })

  it('returns [] for an agent with no enabled servers', () => {
    expect(resolveAgentMcpServers({ enabled: [], defs })).toEqual([])
  })

  it('skips an unknown name with a warn', () => {
    const warn = vi.fn()
    const servers = resolveAgentMcpServers({ enabled: ['nope', 'files'], defs, warn })
    expect(servers.map((s) => s.name)).toEqual(['files'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"nope"'))
  })

  it('skips the reserved bridge name even if a def somehow carries it', () => {
    const warn = vi.fn()
    const servers = resolveAgentMcpServers({
      enabled: [RESERVED_MCP_SERVER_NAME],
      defs: { ...defs, [RESERVED_MCP_SERVER_NAME]: defs.files! },
      warn
    })
    expect(servers).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserved'))
  })

  it('gates http/sse on KNOWN runtime caps (stdio always passes)', () => {
    const warn = vi.fn()
    const servers = resolveAgentMcpServers({
      enabled: ['files', 'search', 'legacy'],
      defs,
      caps: { http: true, sse: false },
      warn
    })
    expect(servers.map((s) => s.name)).toEqual(['files', 'search'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"legacy"'))
  })

  it('includes http/sse optimistically when the runtime was never probed', () => {
    const servers = resolveAgentMcpServers({ enabled: ['search', 'legacy'], defs, caps: undefined })
    expect(servers.map((s) => s.name)).toEqual(['search', 'legacy'])
  })
})
