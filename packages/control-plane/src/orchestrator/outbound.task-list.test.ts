/**
 * The console's background-task read over the WS edge (unit, no socket): it must issue its own
 * frame type, stamp the live connection's fencing epoch, keep the DEFAULT request budget (the
 * daemon answers from memory, so no in-flight pass can be duplicated by a retransmit), and
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
  sent: Array<{ type: string; payload: unknown; ext: unknown; budget: unknown }>
} {
  const sent: Array<{ type: string; payload: unknown; ext: unknown; budget: unknown }> = []
  const request = vi.fn(async (type: string, payload: unknown, ext?: unknown, budget?: unknown) => {
    sent.push({ type, payload, ext, budget })
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

describe('ControlSender.taskList', () => {
  it('issues task/list under the connection’s epoch fence on the default budget', async () => {
    const { sender, sent } = senderWith()

    await sender.taskList(DAEMON, { agentId: 'a1', sessionId: 'acp-1' })

    expect(sent).toEqual([
      { type: 'task/list', payload: { agentId: 'a1', sessionId: 'acp-1' }, ext: { epoch: 7 }, budget: undefined }
    ])
  })

  it('throws NoConnection for a daemon that is not connected — nothing reaches a socket', async () => {
    const { sender, sent } = senderWith()

    await expect(sender.taskList(OFFLINE, { agentId: 'a1', sessionId: 'acp-1' })).rejects.toBeInstanceOf(NoConnection)
    expect(sent).toEqual([])
  })
})
