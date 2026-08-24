import { describe, expect, it, vi } from 'vitest'
import type { Ack, AgentActivate, CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import type { LaunchRepo } from '../persistence/ports.js'
import { ConnectionClosed, ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender } from './outbound.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = '11111111-1111-4111-8111-111111111111'
const MOVE = '22222222-2222-4222-8222-222222222222'
const ORG = 'org-1'

function state(conn: ConnChannel, sessionEpoch = 7): DaemonConnState {
  return {
    daemonId: DAEMON,
    conn,
    sessionEpoch,
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

describe('ControlSender agent move controls', () => {
  it('sends acknowledged detach/activate requests with epoch + agent fencing', async () => {
    const request = vi.fn(async () => ({ ok: true }) as Ack)
    const conn = { daemonId: DAEMON, request, send: vi.fn(), close: vi.fn() } as unknown as ConnChannel
    const registry = new ConnectionRegistry()
    registry.add(state(conn))
    const sender = new ControlSender(registry, {} as LaunchRepo)

    await expect(sender.agentDetach(DAEMON, { agentId: AGENT, moveId: MOVE }, ORG)).resolves.toEqual({ ok: true })
    await expect(
      sender.agentActivate(
        DAEMON,
        {
          agentId: AGENT,
          moveId: MOVE,
          spec: { name: 'mover' } as AgentActivate['spec'],
          integrations: [],
          crons: []
        },
        ORG
      )
    ).resolves.toEqual({ ok: true })

    // The org rides as the explicit last argument: an install-wide member's
    // connection carries none, and neither payload names one.
    expect(request).toHaveBeenNthCalledWith(
      1,
      'agent/detach',
      { agentId: AGENT, moveId: MOVE },
      { epoch: 7, agentId: AGENT },
      undefined,
      ORG
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'agent/activate',
      { agentId: AGENT, moveId: MOVE, spec: { name: 'mover' }, integrations: [], crons: [] },
      { epoch: 7, agentId: AGENT },
      { ackTimeoutMs: 60_000, maxTries: 5 },
      ORG
    )
  })

  it('resumes an idempotent activation on the next READY connection', async () => {
    const firstRequest = vi.fn(async () => {
      throw new ConnectionClosed()
    })
    const first = {
      daemonId: DAEMON,
      request: firstRequest,
      send: vi.fn(),
      close: vi.fn()
    } as unknown as ConnChannel
    const registry = new ConnectionRegistry()
    registry.add(state(first))
    const sender = new ControlSender(registry, {} as LaunchRepo)

    const activation = sender.agentActivate(
      DAEMON,
      {
        agentId: AGENT,
        moveId: MOVE,
        spec: { name: 'mover' } as AgentActivate['spec'],
        integrations: [],
        crons: []
      },
      ORG
    )
    await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledOnce())

    const nextRequest = vi.fn(async () => ({ ok: true }) as Ack)
    const next = {
      daemonId: DAEMON,
      request: nextRequest,
      send: vi.fn(),
      close: vi.fn()
    } as unknown as ConnChannel
    registry.add(state(next, 8))

    await expect(activation).resolves.toEqual({ ok: true })
    // The retry on the replacement connection carries the same org.
    expect(nextRequest).toHaveBeenCalledWith(
      'agent/activate',
      { agentId: AGENT, moveId: MOVE, spec: { name: 'mover' }, integrations: [], crons: [] },
      { epoch: 8, agentId: AGENT },
      { ackTimeoutMs: 60_000, maxTries: 5 },
      ORG
    )
  })

  it('sends collaboration routes as an epoch-fenced full replacement', async () => {
    const send = vi.fn()
    const conn = { daemonId: DAEMON, request: vi.fn(), send, close: vi.fn() } as unknown as ConnChannel
    const registry = new ConnectionRegistry()
    registry.add(state(conn))
    const sender = new ControlSender(registry, {} as LaunchRepo)
    const snapshot = { generation: 3, channels: [] } as unknown as CollabRoutesSnapshot

    await sender.collaborationRoutes(DAEMON, snapshot)
    expect(send).toHaveBeenCalledWith('collaboration/routes', snapshot, { epoch: 7 })
  })
})
