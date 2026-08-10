/**
 * Fencing gate (design §4.8, protocol §4.2).
 *
 * Drives the connection FSM's fencing gate over the `InMemoryDaemonStub` +
 * `FakeClock` (no real socket). An inbound control frame carrying a `ControlExt`
 * block is validated in the order **epoch → launchId**; each rejection is a
 * correlated `error` REP:
 *
 *   - `epoch < current` → `STALE_EPOCH`
 *   - a superseded `launchId` → `STALE_LAUNCH`
 *
 * The pure predicates live in `orchestrator/fencing.ts`
 * (`checkEpoch`/`checkLaunch`); `ws/connection.ts` calls them in order against
 * the connection's fencing baseline (`sessionEpoch` and the agent's current
 * `launchId`).
 */
import { describe, it, expect } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { FakeClock } from '../fakes/fake-clock.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { DaemonConnection } from '../../src/ws/connection.js'
import { FrameRouter } from '../../src/ws/handlers/index.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const LAUNCH = '11111111-1111-4111-8111-111111111111'
const OLD_LAUNCH = '99999999-9999-4999-8999-999999999999'

/** Minimal deps — fencing is pure FSM logic, no DB/auth/registry needed. */
function fencingDeps(clock: FakeClock): DaemonWsDeps {
  const connReg = new ConnectionRegistry()
  return {
    auth: {} as DaemonWsDeps['auth'],
    lifecycleOps: {} as DaemonWsDeps['lifecycleOps'],
    registry: {} as DaemonWsDeps['registry'],
    orchestrator: {} as DaemonWsDeps['orchestrator'],
    connReg,
    agent: {} as DaemonWsDeps['agent'],
    session: {} as DaemonWsDeps['session'],
    events: {} as DaemonWsDeps['events'],
    sessionUsage: {} as DaemonWsDeps['sessionUsage'],
    integration: {} as DaemonWsDeps['integration'],
    integrationChannel: {} as DaemonWsDeps['integrationChannel'],
    agentMutations: new AgentMutationGate(),
    recoverStagedAgent: async () => {},
    collabRoutes: {} as DaemonWsDeps['collabRoutes'],
    cron: {} as DaemonWsDeps['cron'],
    hook: {} as DaemonWsDeps['hook'],
    relayRoster: async () => [],
    clock,
    config: { HEARTBEAT_SEC: 15, ACK_TIMEOUT_MS: 5000 }
  }
}

/**
 * Stand up a READY connection at `sessionEpoch`, with one launched agent whose
 * current launch is `LAUNCH`.
 */
function readyConn(opts: { sessionEpoch: number }) {
  const clock = new FakeClock()
  const deps = fencingDeps(clock)
  const stub = new InMemoryDaemonStub()
  const conn = new DaemonConnection(stub, deps, new FrameRouter())
  conn.start()
  conn.daemonId = DAEMON
  conn.sessionEpoch = opts.sessionEpoch
  conn.state = 'READY'
  // Establish the per-agent fencing baseline the CP holds (current launch).
  conn.fencing.setLaunch(AGENT, LAUNCH)
  return { conn, stub, clock }
}

/** An agent-scoped control frame (carries ControlExt epoch/agentId/launchId). */
function agentActivity() {
  return {
    agentId: AGENT,
    launchId: LAUNCH,
    state: 'thinking' as const,
    ts: new Date().toISOString()
  }
}

describe('fencing gate — epoch → launchId, typed error REPs', () => {
  it('epoch < current → STALE_EPOCH', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    const id = stub.inject('agent/activity', agentActivity(), {
      ext: { epoch: 4, agentId: AGENT, launchId: LAUNCH } // epoch 4 < 5
    })

    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.corr).toBe(id)
    expect(err.payload.code).toBe('STALE_EPOCH')
  })

  it('a superseded launchId → STALE_LAUNCH', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    const id = stub.inject(
      'agent/activity',
      { ...agentActivity(), launchId: OLD_LAUNCH },
      { ext: { epoch: 5, agentId: AGENT, launchId: OLD_LAUNCH } } // dead launch
    )

    const err = stub.lastSent('error')
    if (!err || !isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.corr).toBe(id)
    expect(err.payload.code).toBe('STALE_LAUNCH')
  })

  it('validation order is epoch → launchId (both wrong → STALE_EPOCH wins)', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    // epoch stale AND launch stale — the epoch check must win.
    stub.inject(
      'agent/activity',
      { ...agentActivity(), launchId: OLD_LAUNCH },
      { ext: { epoch: 4, agentId: AGENT, launchId: OLD_LAUNCH } }
    )
    const err1 = stub.lastSent('error')
    if (!err1 || !isFrame('error')(err1)) throw new Error('expected error frame')
    expect(err1.payload.code).toBe('STALE_EPOCH')
  })

  it('a well-fenced frame passes (no error)', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    stub.inject('agent/activity', agentActivity(), {
      ext: { epoch: 5, agentId: AGENT, launchId: LAUNCH }
    })
    // No error REP for a valid frame.
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('a frame with no ControlExt (epoch absent) is not fenced', () => {
    const { stub } = readyConn({ sessionEpoch: 5 })
    // agent/activity carries no ControlExt here — the fencing gate must skip it
    // entirely (no epoch ⇒ not a fenced frame).
    stub.inject('agent/activity', agentActivity())
    expect(stub.lastSent('error')).toBeUndefined()
  })
})
