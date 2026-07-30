import { describe, it, expect } from 'vitest'
import { buildMcpServers } from '../src/mcp/inject.js'

describe('buildMcpServers', () => {
  it('builds a single stdio server that re-invokes this CLI with mcp-bridge', () => {
    const servers = buildMcpServers({ socketPath: '/tmp/x/mcp.sock', token: 'tok-1', cliEntry: '/app/index.js' })
    expect(servers).toHaveLength(1)
    const s = servers[0]!
    expect(s.name).toBe('agentconnect')
    expect(s.command).toBe(process.execPath)
    expect(s.args).toContain('/app/index.js')
    expect(s.args).toContain('mcp-bridge')
  })

  it('passes the socket path and token via env (never as args)', () => {
    const [s] = buildMcpServers({ socketPath: '/sock', token: 'secret', cliEntry: '/e.js' })
    expect(s!.env).toEqual([
      { name: 'AC_MCP_ENDPOINT', value: '/sock' },
      { name: 'AC_MCP_TOKEN', value: 'secret' }
    ])
    expect(s!.args).not.toContain('secret')
  })

  it('enables lazy tool discovery only when explicitly requested', () => {
    const [shared] = buildMcpServers({ socketPath: '/shared', token: 'shared-token', cliEntry: '/e.js' })
    const [privateServer] = buildMcpServers({
      socketPath: '/private',
      token: 'private-token',
      cliEntry: '/e.js',
      lazyTools: true
    })

    expect(shared!.args).not.toContain('--lazy-tools')
    expect(privateServer!.args).toContain('--lazy-tools')
    expect(privateServer!.env).toEqual([
      { name: 'AC_MCP_ENDPOINT', value: '/private' },
      { name: 'AC_MCP_TOKEN', value: 'private-token' }
    ])
  })
})
