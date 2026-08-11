import { describe, expect, it, vi } from 'vitest'
import type { LaunchRepo } from '../persistence/ports.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender } from './outbound.js'
import { ProtocolError } from '../domain/errors.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function state(conn: ConnChannel): DaemonConnState {
  return {
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
}

function senderWith(request: ConnChannel['request']) {
  const conn = { daemonId: DAEMON, request, send: vi.fn(), close: vi.fn() } as unknown as ConnChannel
  const registry = new ConnectionRegistry()
  registry.add(state(conn))
  return new ControlSender(registry, {} as LaunchRepo)
}

describe('ControlSender daemon restart/upgrade — send outcome classification', () => {
  it('sends the lifecycle REQ with maxTries:1 (non-idempotent — never retransmit)', async () => {
    const request = vi.fn(async () => ({ accepted: true }))
    await senderWith(request as unknown as ConnChannel['request']).daemonRestart(DAEMON, {
      reason: 'x',
      drainFirst: true
    })
    expect(request).toHaveBeenCalledWith(
      'daemon/restart',
      { reason: 'x', drainFirst: true },
      { epoch: 7 },
      { maxTries: 1, ackTimeoutMs: 15_000 }
    )
  })

  it('classifies a reply as `acked` with the sent epoch', async () => {
    const request = vi.fn(async () => ({ accepted: true, willDrainUntil: '2026-01-01T00:00:00.000Z' }))
    const r = await senderWith(request as unknown as ConnChannel['request']).daemonUpgrade(DAEMON, {
      targetVersion: '1.2.3',
      drainFirst: true
    })
    expect(r).toEqual({ kind: 'acked', epoch: 7, ack: { accepted: true, willDrainUntil: '2026-01-01T00:00:00.000Z' } })
  })

  it('classifies a correlated protocol error (code ≠ INTERNAL) as `rejected` — a definite negative', async () => {
    const request = vi.fn(async () => {
      throw new ProtocolError('PROTOCOL_STATE', 'daemon is not READY')
    })
    const r = await senderWith(request as unknown as ConnChannel['request']).daemonRestart(DAEMON, {
      reason: 'x',
      drainFirst: true
    })
    expect(r).toEqual({ kind: 'rejected', epoch: 7, code: 'PROTOCOL_STATE', message: 'daemon is not READY' })
  })

  it('classifies an INTERNAL timeout as `ambiguous` (delivery uncertain, keep resolvable)', async () => {
    const request = vi.fn(async () => {
      throw new ProtocolError('INTERNAL', 'no ack after 1 tries')
    })
    const r = await senderWith(request as unknown as ConnChannel['request']).daemonRestart(DAEMON, {
      reason: 'x',
      drainFirst: true
    })
    expect(r).toMatchObject({ kind: 'ambiguous', epoch: 7 })
  })

  it('classifies a missing connection as `unsent` (definitely not delivered)', async () => {
    const registry = new ConnectionRegistry() // no daemon added
    const sender = new ControlSender(registry, {} as LaunchRepo)
    const r = await sender.daemonRestart(DAEMON, { reason: 'x', drainFirst: true })
    expect(r).toEqual({ kind: 'unsent' })
  })
})

describe('ConnectionRegistry bootstrap reconnect', () => {
  it('closes only the matching reachable pre-READY epoch', () => {
    const close = vi.fn()
    const conn = { daemonId: DAEMON, request: vi.fn(), send: vi.fn(), close } as unknown as ConnChannel
    const registry = new ConnectionRegistry()
    const registering: DaemonConnState = { ...state(conn), state: 'REGISTERING' }
    registry.add(registering)

    expect(registry.reconnectForBootstrap(DAEMON, 6)).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(registry.reconnectForBootstrap(DAEMON, 7)).toBe(true)
    expect(close).toHaveBeenCalledWith(1012, 'bootstrap upgrade queued')

    registering.state = 'READY'
    expect(registry.reconnectForBootstrap(DAEMON, 7)).toBe(false)
    expect(close).toHaveBeenCalledOnce()
  })
})
