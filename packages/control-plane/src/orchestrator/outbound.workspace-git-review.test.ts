/**
 * The console's git review reads over the WS edge (unit, no socket): each wrapper
 * must issue its OWN frame type, stamp the live connection's fencing epoch, and
 * refuse to invent an answer when the daemon is not connected.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LaunchRepo } from '../persistence/ports.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender, NoConnection } from './outbound.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OFFLINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** A sender over one READY connection at epoch 7, recording every issued REQ. */
function senderWith(): {
  sender: ControlSender
  sent: Array<{ type: string; payload: unknown; ext: unknown }>
} {
  const sent: Array<{ type: string; payload: unknown; ext: unknown }> = []
  const request = vi.fn(async (type: string, payload: unknown, ext?: unknown) => {
    sent.push({ type, payload, ext })
    return {}
  })
  const conn = { daemonId: DAEMON, request, send: vi.fn(), close: vi.fn() } as unknown as ConnChannel
  const registry = new ConnectionRegistry()
  const state: DaemonConnState = {
    daemonId: DAEMON,
    conn,
    sessionEpoch: 7,
    state: 'READY',
    maxAgents: 2,
    load: { cpu: 0, mem: 0, agents: 1 },
    health: 'ok',
    lastBeatAt: 0,
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  }
  registry.add(state)
  return { sender: new ControlSender(registry, {} as LaunchRepo), sent }
}

describe('ControlSender workspace git review reads', () => {
  it('issues workspace/gitdiff and workspace/gitlog under the connection’s epoch fence', async () => {
    const { sender, sent } = senderWith()

    await sender.workspaceGitDiff(DAEMON, { agentId: 'a1', sessionId: 's1', path: 'src/app.ts', staged: true })
    await sender.workspaceGitLog(DAEMON, { agentId: 'a1', limit: 20 })

    expect(sent).toEqual([
      {
        type: 'workspace/gitdiff',
        payload: { agentId: 'a1', sessionId: 's1', path: 'src/app.ts', staged: true },
        ext: { epoch: 7 }
      },
      { type: 'workspace/gitlog', payload: { agentId: 'a1', limit: 20 }, ext: { epoch: 7 } }
    ])
  })

  it('throws NoConnection for a daemon that is not connected — nothing reaches a socket', async () => {
    const { sender, sent } = senderWith()

    await expect(sender.workspaceGitDiff(OFFLINE, { agentId: 'a1', path: 'x', staged: false })).rejects.toBeInstanceOf(
      NoConnection
    )
    await expect(sender.workspaceGitLog(OFFLINE, { agentId: 'a1', limit: 20 })).rejects.toBeInstanceOf(NoConnection)
    expect(sent).toEqual([])
  })
})
