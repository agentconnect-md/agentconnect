/**
 * The §5.1 gate-push service: who gets pushed to, what an ack records, and when
 * the §4.3 endpoint may call a tighten `applied`. Pure unit test — the registry,
 * the sender, and the repos are all fakes, so no Docker and no socket.
 */
import { describe, it, expect, vi } from 'vitest'
import { SESSION_VISIBILITY_FEATURE } from '@agentconnect.md/protocol'
import { SessionVisibilityPushService, visibilityStateOf } from './visibilityPush.js'

/** One past the cutover-state read cap (SUBTREE_LIMIT = 500). */
const SUBTREE_OVERFLOW = 501
import { NoConnection } from './outbound.js'
import type { SessionMetaRecord } from '../persistence/ports.js'

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function session(over: Partial<SessionMetaRecord> = {}): SessionMetaRecord {
  return {
    id: 'acp-1',
    agentId: AGENT,
    visibility: 'private',
    ownerIdentity: 'user:u1',
    visibilityRev: 2,
    visibilityAckedRev: -1,
    ...over
  } as SessionMetaRecord
}

/** A registry holding one daemon, optionally advertising the feature. */
function connReg(opts: { connected?: boolean; feature?: boolean } = {}) {
  const { connected = true, feature = true } = opts
  return {
    get: (id: string) =>
      connected && id === DAEMON
        ? { capabilities: { features: feature ? [SESSION_VISIBILITY_FEATURE] : [] } }
        : undefined
  } as never
}

function deps(
  over: {
    connReg?: never
    sessionVisibility?: unknown
    daemonId?: string | null
    /** Successive snapshot pages the repo hands back, newest call first. */
    snapshotPages?: Array<Array<{ sessionId: string; visibility: 'private' | 'org'; visibilityRev: number }>>
    unackedAfter?: number[]
  } = {}
) {
  const recordVisibilityAck = vi.fn(async () => {})
  const sessionVisibility =
    over.sessionVisibility ??
    vi.fn(async (_d: string, p: { sessionId: string; visibilityRev: number }) => ({
      sessionId: p.sessionId,
      visibilityRev: p.visibilityRev,
      status: 'applied' as const
    }))
  const daemonId = over.daemonId === undefined ? DAEMON : over.daemonId
  const pages = [...(over.snapshotPages ?? [[]])]
  const unacked = [...(over.unackedAfter ?? [0])]
  const visibilitySnapshotForDaemon = vi.fn(async () => pages.shift() ?? [])
  const countUnackedVisibility = vi.fn(async () => unacked.shift() ?? 0)
  const sessionVisibilitySnapshot = vi.fn(async () => ({ ok: true }))
  return {
    recordVisibilityAck,
    sessionVisibility,
    visibilitySnapshotForDaemon,
    sessionVisibilitySnapshot,
    push: new SessionVisibilityPushService({
      repos: {
        session: {
          recordVisibilityAck,
          visibilitySnapshotForDaemon,
          countUnackedVisibility,
          get: vi.fn(async () => null)
        } as never,
        agent: { get: vi.fn(async () => (daemonId ? { id: AGENT, daemonId } : { id: AGENT })) } as never
      },
      control: { sessionVisibility, sessionVisibilitySnapshot } as never,
      connReg: over.connReg ?? connReg(),
      log: { warn: vi.fn() }
    })
  }
}

describe('notifySessions', () => {
  it('pushes the current gate state and records the daemon’s ack', async () => {
    const { push, sessionVisibility, recordVisibilityAck } = deps()
    await push.notifySessions([session()])

    expect(sessionVisibility).toHaveBeenCalledWith(DAEMON, {
      sessionId: 'acp-1',
      visibility: 'private',
      visibilityRev: 2
    })
    expect(recordVisibilityAck).toHaveBeenCalledWith('acp-1', 2)
  })

  it('records the ack for a `superseded` reply too — the daemon already holds it', async () => {
    const sessionVisibility = vi.fn(async () => ({ sessionId: 'acp-1', visibilityRev: 2, status: 'superseded' }))
    const { push, recordVisibilityAck } = deps({ sessionVisibility })
    await push.notifySessions([session()])
    expect(recordVisibilityAck).toHaveBeenCalledWith('acp-1', 2)
  })

  it('skips an unplaced agent, an offline daemon, and one too old to know the frame', async () => {
    const unplaced = deps({ daemonId: null })
    await unplaced.push.notifySessions([session()])
    expect(unplaced.sessionVisibility).not.toHaveBeenCalled()

    const offline = deps({ connReg: connReg({ connected: false }) as never })
    await offline.push.notifySessions([session()])
    expect(offline.sessionVisibility).not.toHaveBeenCalled()

    const old = deps({ connReg: connReg({ feature: false }) as never })
    await old.push.notifySessions([session()])
    expect(old.sessionVisibility).not.toHaveBeenCalled()
  })

  it('swallows a mid-flight disconnect — the register snapshot carries it', async () => {
    const sessionVisibility = vi.fn(async () => {
      throw new NoConnection(DAEMON)
    })
    const { push, recordVisibilityAck } = deps({ sessionVisibility })
    await expect(push.notifySessions([session()])).resolves.toBeUndefined()
    expect(recordVisibilityAck).not.toHaveBeenCalled()
  })

  it('keeps going after one session fails, so a cascade is not truncated', async () => {
    const sessionVisibility = vi.fn(async (_d: string, p: { sessionId: string; visibilityRev: number }) => {
      if (p.sessionId === 'acp-bad') throw new Error('boom')
      return { sessionId: p.sessionId, visibilityRev: p.visibilityRev, status: 'applied' as const }
    })
    const { push, recordVisibilityAck } = deps({ sessionVisibility })
    await push.notifySessions([session({ id: 'acp-bad' }), session({ id: 'acp-good' })])
    expect(recordVisibilityAck).toHaveBeenCalledWith('acp-good', 2)
  })
})

describe('replayTo — register-time convergence', () => {
  const page = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `acp-${from + i}`,
      visibility: 'private' as const,
      visibilityRev: 1
    }))

  it('keeps paging until nothing is left unacknowledged', async () => {
    // A full page means there may be more behind it; ordering alone would ack
    // the first page and leave the rest carrying a stale gate until some later
    // register — which for a daemon that stays connected may never come.
    const d = deps({ snapshotPages: [page(500), page(2, 500), []], unackedAfter: [2, 0] })
    await d.push.replayTo(DAEMON as never)
    expect(d.sessionVisibilitySnapshot).toHaveBeenCalledTimes(2)
    expect(d.recordVisibilityAck).toHaveBeenCalledTimes(502)
  })

  it('stops after a partial page — nothing is behind it', async () => {
    const d = deps({ snapshotPages: [page(3)] })
    await d.push.replayTo(DAEMON as never)
    expect(d.sessionVisibilitySnapshot).toHaveBeenCalledTimes(1)
    expect(d.visibilitySnapshotForDaemon).toHaveBeenCalledTimes(1)
  })

  it('stops paging when the daemon drops mid-replay — the next register retries', async () => {
    const d = deps({ snapshotPages: [page(500), page(500, 500)], unackedAfter: [500, 0] })
    d.sessionVisibilitySnapshot.mockImplementationOnce(async () => {
      throw new NoConnection(DAEMON)
    })
    await d.push.replayTo(DAEMON as never)
    expect(d.sessionVisibilitySnapshot).toHaveBeenCalledTimes(1)
    expect(d.recordVisibilityAck).not.toHaveBeenCalled()
  })

  it('pauses and resumes instead of abandoning a set it knows is stale', async () => {
    vi.useFakeTimers()
    try {
      // Pages stay full and the unacked count never drops: changes are landing
      // as fast as we ack. A round cap would walk away from gates we KNOW are
      // stale; the loop must yield and come back instead.
      const warn = vi.fn()
      const visibilitySnapshotForDaemon = vi.fn(async () => page(500))
      const countUnackedVisibility = vi.fn(async () => 5_000)
      const sessionVisibilitySnapshot = vi.fn(async () => ({ ok: true }))
      const push = new SessionVisibilityPushService({
        repos: {
          session: {
            recordVisibilityAck: vi.fn(async () => {}),
            visibilitySnapshotForDaemon,
            countUnackedVisibility,
            get: vi.fn(async () => null)
          } as never,
          agent: { get: vi.fn(async () => ({ id: AGENT, daemonId: DAEMON })) } as never
        },
        control: { sessionVisibility: vi.fn(), sessionVisibilitySnapshot } as never,
        connReg: connReg(),
        log: { warn }
      })

      await push.replayTo(DAEMON as never)
      // It stopped (no spin) …
      expect(sessionVisibilitySnapshot).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ unacked: 5_000 }),
        expect.stringContaining('resuming')
      )

      // … and it comes back on its own, rather than waiting for a register that
      // a still-connected daemon may never perform again.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sessionVisibilitySnapshot.mock.calls.length).toBeGreaterThan(2)
      push.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing to a daemon that does not advertise the feature', async () => {
    const d = deps({ snapshotPages: [page(3)], connReg: connReg({ feature: false }) as never })
    await d.push.replayTo(DAEMON as never)
    expect(d.visibilitySnapshotForDaemon).not.toHaveBeenCalled()
  })
})

describe('visibilityStateOf — subtree scope', () => {
  const subtreeDeps = (rows: SessionMetaRecord[]) => {
    const d = deps()
    return {
      push: d.push,
      repos: { session: { visibilitySubtree: vi.fn(async (_id: string, limit: number) => rows.slice(0, limit)) } }
    }
  }

  it('covers descendants, so an acked root with a behind child is still pending', async () => {
    const { push, repos } = subtreeDeps([
      session({ id: 'root', visibilityRev: 1, visibilityAckedRev: 1 }),
      session({ id: 'child', visibilityRev: 1, visibilityAckedRev: -1 })
    ])
    expect(await visibilityStateOf(push, repos as never, ['root' as never])).toBe('pending')
  })

  it('reports pending when the subtree is larger than one read evaluates', async () => {
    // All 501 rows are fully acked: the ONLY reason to report pending is that we
    // could not see the whole subtree, and claiming a verified cutover from a
    // partial read would be a false promise.
    const rows = Array.from({ length: SUBTREE_OVERFLOW }, (_, i) =>
      session({ id: `s-${i}`, visibilityRev: 1, visibilityAckedRev: 1 })
    )
    const { push, repos } = subtreeDeps(rows)
    expect(await visibilityStateOf(push, repos as never, ['root' as never])).toBe('pending')
  })

  it('reports applied for a fully acked subtree within the cap', async () => {
    const { push, repos } = subtreeDeps([session({ id: 'root', visibilityRev: 1, visibilityAckedRev: 1 })])
    expect(await visibilityStateOf(push, repos as never, ['root' as never])).toBe('applied')
  })
})

describe('isApplied — the §4.3 cutover state', () => {
  it('is pending while a reachable daemon has not acked the current revision', async () => {
    const { push } = deps()
    expect(await push.isApplied([session({ visibilityRev: 3, visibilityAckedRev: 2 })])).toBe(false)
  })

  it('is applied once the ack watermark reaches the revision', async () => {
    const { push } = deps()
    expect(await push.isApplied([session({ visibilityRev: 3, visibilityAckedRev: 3 })])).toBe(true)
  })

  it('treats revision 0 as needing an ack — -1 means never acknowledged', async () => {
    const { push } = deps()
    expect(await push.isApplied([session({ visibilityRev: 0, visibilityAckedRev: -1 })])).toBe(false)
    expect(await push.isApplied([session({ visibilityRev: 0, visibilityAckedRev: 0 })])).toBe(true)
  })

  it('is vacuously applied ONLY for an unplaced agent — nothing runs it, nothing captures', async () => {
    const unplaced = deps({ daemonId: null })
    expect(await unplaced.push.isApplied([session({ visibilityRev: 1, visibilityAckedRev: -1 })])).toBe(true)
  })

  it('stays pending for a placed daemon that is merely offline or pre-upgrade', async () => {
    // A daemon keeps serving established sessions while the CP is down, so its
    // gate may genuinely still be `org`. Claiming `applied` would promise a
    // memory boundary that is not in force.
    for (const d of [
      deps({ connReg: connReg({ connected: false }) as never }),
      deps({ connReg: connReg({ feature: false }) as never })
    ]) {
      expect(await d.push.isApplied([session({ visibilityRev: 1, visibilityAckedRev: -1 })])).toBe(false)
    }
  })

  it('is pending if ANY affected session of a cascade is still unacked', async () => {
    const { push } = deps()
    const acked = session({ id: 'acp-1', visibilityRev: 1, visibilityAckedRev: 1 })
    const unacked = session({ id: 'acp-2', visibilityRev: 1, visibilityAckedRev: 0 })
    expect(await push.isApplied([acked, unacked])).toBe(false)
  })
})
