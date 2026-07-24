import { describe, it, expect, vi } from 'vitest'
import { ControlSender } from './outbound.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import type { RelayRosterEntry } from '@agentconnect.md/protocol'
import type { LaunchRepo } from '../persistence/ports.js'

const RELAYS: RelayRosterEntry[] = [{ relayId: 'r1', url: 'wss://relay-0.example.test' }]

function daemon(id: string, epoch: number, reachable: boolean, send: ConnChannel['send']): DaemonConnState {
  const conn: ConnChannel = { daemonId: id, send, request: vi.fn(), close: vi.fn() }
  return {
    daemonId: id,
    conn,
    sessionEpoch: epoch,
    state: 'READY',
    maxAgents: 1,
    load: { cpu: 0, mem: 0, agents: 0 },
    health: 'ok',
    lastBeatAt: 0,
    reachable,
    assignments: new Set(),
    launches: new Map()
  }
}

describe('ControlSender.broadcastRelayRoster', () => {
  it('fans relay/roster to REACHABLE daemons only, epoch-stamped per connection', () => {
    const reg = new ConnectionRegistry()
    const sendA = vi.fn()
    const sendB = vi.fn()
    const sendC = vi.fn()
    reg.add(daemon('a', 5, true, sendA))
    reg.add(daemon('b', 9, true, sendB))
    reg.add(daemon('c', 1, false, sendC)) // unreachable — skipped
    const sender = new ControlSender(reg, {} as LaunchRepo)

    sender.broadcastRelayRoster(RELAYS)

    expect(sendA).toHaveBeenCalledWith('relay/roster', { relays: RELAYS }, { epoch: 5 })
    expect(sendB).toHaveBeenCalledWith('relay/roster', { relays: RELAYS }, { epoch: 9 })
    expect(sendC).not.toHaveBeenCalled()
  })

  it('isolates a per-socket send failure — a dead socket does not abort the fan-out', () => {
    const reg = new ConnectionRegistry()
    const sendA = vi.fn(() => {
      throw new Error('dead socket')
    })
    const sendB = vi.fn()
    reg.add(daemon('a', 5, true, sendA))
    reg.add(daemon('b', 9, true, sendB))
    const sender = new ControlSender(reg, {} as LaunchRepo)

    expect(() => sender.broadcastRelayRoster(RELAYS)).not.toThrow()
    expect(sendB).toHaveBeenCalledOnce() // b still gets it despite a's throw
  })
})
