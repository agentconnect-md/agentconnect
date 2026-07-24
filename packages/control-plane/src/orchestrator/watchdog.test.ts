/**
 * Unit tests for `Watchdog` (design §5.3 — Clock-driven policy in the no-Docker
 * `unit` project). A fake orchestrator records the freeze/rebalance calls so the
 * two-phase timing (freeze at 3×heartbeat, rebalance only after the grace) is
 * pinned by advancing the `FakeClock` — no DB, no socket.
 */
import { describe, it, expect } from 'vitest'
import { Watchdog, type WatchdogOrchestrator } from './watchdog.js'
import { ConnectionRegistry, type DaemonConnState, ConnChannel } from '../ws/registry.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import type { DaemonId } from '../domain/ids.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const HEARTBEAT_SEC = 15
const MISSED_BEATS = 3
const REASSIGN_GRACE_SEC = 60

class FakeOrch implements WatchdogOrchestrator {
  frozen: string[] = []
  rebalanced: string[] = []
  onDaemonUnreachable(daemonId: DaemonId): void {
    this.frozen.push(daemonId)
  }
  async rebalanceFrom(daemonId: DaemonId): Promise<void> {
    this.rebalanced.push(daemonId)
  }
}

const noopChannel: ConnChannel = {
  daemonId: DAEMON,
  request: <TReply = unknown>() => Promise.resolve(undefined as TReply),
  send: () => {},
  close: () => {}
}

function setup() {
  const clock = new FakeClock(0)
  const reg = new ConnectionRegistry()
  const state: DaemonConnState = {
    daemonId: DAEMON,
    conn: noopChannel,
    sessionEpoch: 1,
    state: 'READY',
    maxAgents: 4,
    load: { cpu: 0, mem: 0, agents: 0 },
    health: 'ok',
    lastBeatAt: clock.now(),
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  }
  reg.add(state)
  const orch = new FakeOrch()
  const wd = new Watchdog(reg, clock, orch, { HEARTBEAT_SEC, MISSED_BEATS, REASSIGN_GRACE_SEC })
  return { clock, reg, orch, wd, state }
}

const MISS_MS = HEARTBEAT_SEC * MISSED_BEATS * 1000
const GRACE_MS = REASSIGN_GRACE_SEC * 1000

describe('Watchdog', () => {
  it('freezes after 3×heartbeat and rebalances only after the reassign grace', () => {
    const { clock, reg, orch, wd } = setup()
    wd.track(DAEMON)

    // Just before the miss deadline — nothing yet.
    clock.advance(MISS_MS - 1)
    expect(orch.frozen).toEqual([])

    // Crossing the miss deadline → freeze (reachable=false), but NOT reassigned.
    clock.advance(1)
    expect(orch.frozen).toEqual([DAEMON])
    expect(orch.rebalanced).toEqual([])
    expect(reg.get(DAEMON)?.reachable).toBe(false)

    // Within the grace — still no rebalance.
    clock.advance(GRACE_MS - 1)
    expect(orch.rebalanced).toEqual([])

    // Crossing the grace, still gone → rebalance.
    clock.advance(1)
    expect(orch.rebalanced).toEqual([DAEMON])
  })

  it('a heartbeat before the miss deadline re-arms and prevents the freeze', () => {
    const { clock, orch, wd } = setup()
    wd.track(DAEMON)

    clock.advance(MISS_MS - 1)
    wd.beat(DAEMON) // re-arms; deadline pushed out
    clock.advance(MISS_MS - 1)
    expect(orch.frozen).toEqual([]) // never frozen

    clock.advance(1) // now cross the (new) deadline
    expect(orch.frozen).toEqual([DAEMON])
  })

  it('a heartbeat during the grace cancels the pending rebalance', () => {
    const { clock, reg, orch, wd } = setup()
    wd.track(DAEMON)

    clock.advance(MISS_MS) // freeze
    expect(orch.frozen).toEqual([DAEMON])

    // The daemon comes back during the grace window.
    clock.advance(GRACE_MS - 1)
    wd.beat(DAEMON)
    expect(reg.get(DAEMON)?.reachable).toBe(true)

    clock.advance(GRACE_MS + 10) // past where the original grace would have fired
    expect(orch.rebalanced).toEqual([]) // rebalance was cancelled
  })

  it('untrack cancels all timers', () => {
    const { clock, orch, wd } = setup()
    wd.track(DAEMON)
    wd.untrack(DAEMON)
    clock.advance(MISS_MS + GRACE_MS + 10)
    expect(orch.frozen).toEqual([])
    expect(orch.rebalanced).toEqual([])
  })
})
