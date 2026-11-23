/**
 * Session content reads must carry an explicit org on the wire.
 *
 * A pool member's connection is install-wide (`conn.orgId` undefined), and
 * `DaemonConnection.organizationFor` resolves one from `orgByAgent` — a map holding only the
 * agents that connection has been told about. A peer answering for a RETIRED member was told
 * about none of them, so a frame without an explicit org is SCOPE_DENIED before it leaves the
 * CP. These pin the argument that prevents that.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { ControlSender, NoConnection } from './outbound.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import type { LaunchRepo } from '../persistence/ports.js'

function senderWithSpyConn() {
  const calls: Array<{ type: string; orgId: string | undefined }> = []
  const conn = {
    request: async (type: string, _payload: unknown, _ext?: unknown, _opts?: unknown, orgId?: string) => {
      calls.push({ type, orgId })
      return {}
    }
  }
  const registry = { get: () => ({ conn, sessionEpoch: 7, state: 'READY' }) } as unknown as ConnectionRegistry
  return { calls, sender: new ControlSender(registry, {} as LaunchRepo) }
}

describe('ControlSender session content reads', () => {
  it('scopes session/history to the org that authorized the read', async () => {
    const { calls, sender } = senderWithSpyConn()
    await sender.sessionHistory('pool-member', 'org-7', { agentId: 'a1', sessionId: 's1', limit: 50 })
    expect(calls).toEqual([{ type: 'session/history', orgId: 'org-7' }])
  })

  it('scopes session/thread the same way', async () => {
    const { calls, sender } = senderWithSpyConn()
    await sender.sessionThread('pool-member', 'org-7', { agentId: 'a1', sessionId: 's1', rootId: 'r1', limit: 50 })
    expect(calls).toEqual([{ type: 'session/thread', orgId: 'org-7' }])
  })

  it('scopes session/tool-body the same way', async () => {
    const { calls, sender } = senderWithSpyConn()
    await sender.sessionToolBody('pool-member', 'org-7', {
      agentId: 'a1',
      sessionId: 's1',
      toolCallId: 't1',
      offset: 0
    })
    expect(calls).toEqual([{ type: 'session/tool-body', orgId: 'org-7' }])
  })
})

function registering(daemonId: string, sessionEpoch: number, request: ConnChannel['request']): DaemonConnState {
  const conn: ConnChannel = { daemonId, request, send: vi.fn(), close: vi.fn() }
  return {
    daemonId,
    conn,
    sessionEpoch,
    state: 'REGISTERING',
    maxAgents: 1,
    load: { cpu: 0, mem: 0, agents: 0 },
    health: 'ok',
    lastBeatAt: 0,
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  }
}

describe('ControlSender reads from a daemon that is still registering', () => {
  afterEach(() => vi.useRealTimers())
  const READ = { agentId: 'a1', sessionId: 's1', limit: 50 }

  it('holds the read until the connection reaches READY, then sends it on that connection', async () => {
    const registry = new ConnectionRegistry()
    const request = vi.fn(async () => ({ messages: [] }))
    const state = registering('d1', 4, request as ConnChannel['request'])
    registry.add(state)
    const pending = new ControlSender(registry, {} as LaunchRepo).sessionHistory('d1', 'org-7', READ)
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
    registry.markReady('d1', state.conn)
    await expect(pending).resolves.toEqual({ messages: [] })
    expect(request).toHaveBeenCalledWith('session/history', READ, { epoch: 4 }, undefined, 'org-7')
  })

  it('counts a daemon that never finishes registering as offline, sending nothing', async () => {
    vi.useFakeTimers()
    const registry = new ConnectionRegistry()
    const request = vi.fn()
    registry.add(registering('d1', 4, request))
    const pending = new ControlSender(registry, {} as LaunchRepo).sessionHistory('d1', 'org-7', READ)
    const outcome = expect(pending).rejects.toBeInstanceOf(NoConnection)
    await vi.advanceTimersByTimeAsync(5_000)
    await outcome
    expect(request).not.toHaveBeenCalled()
  })
})
