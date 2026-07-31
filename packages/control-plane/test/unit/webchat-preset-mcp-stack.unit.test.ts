import { describe, expect, it } from 'vitest'
import * as stackHarness from '../harness/webchat-preset-mcp-stack.js'

type ReadinessApi = {
  daemonControlPlaneReady?: (daemon: unknown) => boolean
  daemonDelegatedMcpReady?: (daemon: unknown) => boolean
}

const readiness = stackHarness as ReadinessApi

describe('preset webchat MCP daemon readiness contract', () => {
  it('uses CpClient.state and broker presence instead of a RelayClient-style isReady method', () => {
    expect(readiness.daemonControlPlaneReady).toBeTypeOf('function')
    expect(readiness.daemonDelegatedMcpReady).toBeTypeOf('function')
    if (!readiness.daemonControlPlaneReady || !readiness.daemonDelegatedMcpReady) return

    const readyDaemon = {
      cpClient: { state: 'READY' },
      delegatedMcpBroker: {}
    }
    expect(readiness.daemonControlPlaneReady(readyDaemon)).toBe(true)
    expect(readiness.daemonDelegatedMcpReady(readyDaemon)).toBe(true)
    expect(readiness.daemonControlPlaneReady({ cpClient: { state: 'DEGRADED' } })).toBe(false)
    expect(readiness.daemonDelegatedMcpReady({ cpClient: { state: 'READY' } })).toBe(false)
    expect(
      readiness.daemonDelegatedMcpReady({
        cpClient: { isReady: () => true },
        delegatedMcpBroker: {}
      })
    ).toBe(false)
  })
})
