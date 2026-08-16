/**
 * Session content reads must carry an explicit org on the wire.
 *
 * A pool member's connection is install-wide (`conn.orgId` undefined), and
 * `DaemonConnection.organizationFor` resolves one from `orgByAgent` — a map holding only the
 * agents that connection has been told about. A peer answering for a RETIRED member was told
 * about none of them, so a frame without an explicit org is SCOPE_DENIED before it leaves the
 * CP. These pin the argument that prevents that.
 */
import { describe, it, expect } from 'vitest'
import { ControlSender } from './outbound.js'
import type { ConnectionRegistry } from '../ws/registry.js'
import type { LaunchRepo } from '../persistence/ports.js'

function senderWithSpyConn() {
  const calls: Array<{ type: string; orgId: string | undefined }> = []
  const conn = {
    request: async (type: string, _payload: unknown, _ext?: unknown, _opts?: unknown, orgId?: string) => {
      calls.push({ type, orgId })
      return {}
    }
  }
  const registry = { get: () => ({ conn, sessionEpoch: 7 }) } as unknown as ConnectionRegistry
  return { calls, sender: new ControlSender(registry, {} as LaunchRepo) }
}

describe('ControlSender session content reads', () => {
  it('scopes session/history to the org that authorized the read', async () => {
    const { calls, sender } = senderWithSpyConn()
    await sender.sessionHistory('pool-member', 'org-7', { agentId: 'a1', sessionId: 's1', limit: 50 })
    expect(calls).toEqual([{ type: 'session/history', orgId: 'org-7' }])
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
