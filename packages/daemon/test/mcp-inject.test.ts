import { describe, it, expect } from 'vitest'
import { buildMcpServers, buildSandboxMcpServers } from '../src/mcp/inject.js'
import { SANDBOX_TUNNEL_PATHS } from '../src/shim/sandbox-paths.js'

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

describe('buildSandboxMcpServers', () => {
  it('names the image’s own bridge and the tunnel socket, never a path on this daemon', () => {
    const bridge = { command: '/usr/local/bin/node', args: ['/opt/agentconnect/shim/mcp-bridge.js'] }
    const [server] = buildSandboxMcpServers({ bridge, token: 'tok-1' })
    expect(server!.name).toBe('agentconnect')
    // Not process.execPath and not the daemon's CLI entry: both name files the pod does not have,
    // and a runtime handed them retries a missing module instead of serving tools.
    expect(server!.command).toBe(bridge.command)
    expect(server!.args).toEqual(bridge.args)
    expect(server!.env).toEqual([
      { name: 'AC_MCP_ENDPOINT', value: SANDBOX_TUNNEL_PATHS.mcp },
      { name: 'AC_MCP_TOKEN', value: 'tok-1' }
    ])
    expect(server!.args).not.toContain('tok-1')
  })
})
