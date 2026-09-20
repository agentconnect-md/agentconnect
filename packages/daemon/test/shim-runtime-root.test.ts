import { describe, expect, it } from 'vitest'
import { buildSandboxMcpServers } from '../src/mcp/inject.js'
import { shimEntryOptions } from '../src/shim/entry-options.js'
import {
  DEFAULT_SHIM_PATHS,
  SANDBOX_GIT_CONFIG_DIR,
  SANDBOX_GIT_CREDENTIAL_HELPER,
  SANDBOX_TUNNEL_PATHS
} from '../src/shim/sandbox-paths.js'
import { sandboxGitCredentialTarget } from '../src/workspace/git-injection.js'

const bridge = { command: '/usr/bin/node', args: ['/opt/agentconnect/shim/mcp-bridge.js'] }
const mcpEndpoint = (runtimeRoot?: string): string | undefined =>
  buildSandboxMcpServers({ bridge, token: 't', runtimeRoot })[0]!.env.find((e) => e.name === 'AC_MCP_ENDPOINT')?.value

describe('daemon-authored sandbox paths follow the runtime root', () => {
  it('keeps the image layout when no root is named', () => {
    expect(sandboxGitCredentialTarget()).toEqual({
      kind: 'sandbox',
      helper: SANDBOX_GIT_CREDENTIAL_HELPER,
      configDir: SANDBOX_GIT_CONFIG_DIR,
      socketPath: SANDBOX_TUNNEL_PATHS.gitcred
    })
    expect(mcpEndpoint()).toBe('/run/agentconnect/mcp.sock')
  })

  it('moves the git-credential socket, the Git config location and the MCP endpoint together', () => {
    const root = '/home/agent/.agentconnect/hs/0a1b2c3d4e5f'
    const target = sandboxGitCredentialTarget(root)
    expect(target.socketPath).toBe(`${root}/gitcred.sock`)
    expect(target.configDir).toBe(`${root}/git`)
    expect(mcpEndpoint(root)).toBe(`${root}/mcp.sock`)
    // The helper is the image's, not the runtime root's.
    expect(target.helper).toBe(SANDBOX_GIT_CREDENTIAL_HELPER)
  })
})

describe('shim entry options', () => {
  it('derives the image layout, a TCP port and no complete environment from an empty environment', () => {
    expect(shimEntryOptions({})).toEqual({
      listen: { port: 8085 },
      workspaceRoot: '/agent',
      paths: DEFAULT_SHIM_PATHS,
      completeEnv: false
    })
  })

  it('takes the complete environment from its own flag alone', () => {
    expect(shimEntryOptions({ AC_SHIM_COMPLETE_ENV: '1' }).completeEnv).toBe(true)
    expect(shimEntryOptions({ AC_SHIM_COMPLETE_ENV: 'true' }).completeEnv).toBe(false)
    // A socket, a runtime root and a helper root say where the shim runs, not where its daemon does.
    const host = shimEntryOptions({
      AC_SHIM_SOCKET: '/d/hs/x/shim.sock',
      AC_SHIM_RUNTIME_ROOT: '/d/hs/x',
      AC_SHIM_HELPER_ROOT: '/d/dist',
      AC_SHIM_RUNTIME_MARK: 'm'
    })
    expect(host.runtimeMark).toBe('m')
    expect(host.completeEnv).toBe(false)
    expect(host.listen).toEqual({ socketPath: '/d/hs/x/shim.sock' })
    expect(host.paths.tunnels).toEqual({ gitcred: '/d/hs/x/gitcred.sock', mcp: '/d/hs/x/mcp.sock' })
    expect(host.paths.mcpBridgeEntry).toBe('/d/dist/shim/mcp-bridge.js')
  })

  it('refuses a port that is not one, and ignores it when a socket is named', () => {
    expect(() => shimEntryOptions({ AC_SHIM_PORT: '0' })).toThrow('AC_SHIM_PORT is not a valid port')
    expect(shimEntryOptions({ AC_SHIM_PORT: '0', AC_SHIM_SOCKET: '/s' }).listen).toEqual({ socketPath: '/s' })
  })
})
