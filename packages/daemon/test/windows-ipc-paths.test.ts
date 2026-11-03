import { describe, expect, it } from 'vitest'
import { gitcredSocketPath } from '../src/cp/gitcred-server.js'
import { isWindowsNamedPipe, localIpcPath, mcpSocketPath } from '../src/paths.js'

describe('local IPC paths', () => {
  it('uses stable, distinct Windows named pipes per root and channel', () => {
    const first = mcpSocketPath('C:\\agents\\one', 'win32')
    expect(first.startsWith('\\\\.\\pipe\\agentconnect-')).toBe(true)
    expect(first).toMatch(/[0-9a-f]{16}-mcp$/)
    expect(isWindowsNamedPipe(first)).toBe(true)
    expect(mcpSocketPath('C:\\agents\\one', 'win32')).toBe(first)
    expect(mcpSocketPath('C:\\agents\\two', 'win32')).not.toBe(first)
    expect(gitcredSocketPath('C:\\agents\\one', 'win32')).not.toBe(first)
    expect(localIpcPath('C:\\agents\\one', 'local', 'win32')).toMatch(/[0-9a-f]{16}-local$/)
  })

  it('keeps filesystem sockets on POSIX', () => {
    expect(mcpSocketPath('/srv/agentconnect', 'linux')).toBe('/srv/agentconnect/run/mcp.sock')
    expect(gitcredSocketPath('/srv/agentconnect', 'darwin')).toBe('/srv/agentconnect/run/gitcred.sock')
    expect(localIpcPath('/srv/agentconnect', 'local', 'linux')).toBe('/srv/agentconnect/run/local.sock')
  })
})
