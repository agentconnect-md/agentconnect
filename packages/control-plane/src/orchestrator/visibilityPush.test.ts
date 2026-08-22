/**
 * The §5.1 gate-push service: who gets pushed to, what an ack records, and when
 * the §4.3 endpoint may call a tighten `applied`. Pure unit test — the registry,
 * the sender, and the repos are all fakes, so no Docker and no socket.
 */
import { describe, it, expect, vi } from 'vitest'
import { SESSION_VISIBILITY_FEATURE, SLACK_SESSION_AUDIENCE_FEATURE } from '@agentconnect.md/protocol'
import { SessionVisibilityPushService, visibilityStateOf } from './visibilityPush.js'

/** One past the cutover-state read cap (SUBTREE_LIMIT = 500). */
const SUBTREE_OVERFLOW = 501
import { NoConnection } from './outbound.js'
import type { SessionMetaRecord } from '../persistence/ports.js'
import { SessionId } from '../domain/ids.js'

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'org-a'

function session(over: Partial<SessionMetaRecord> = {}): SessionMetaRecord {
  return {
    id: 'acp-1',
    orgId: ORG,
    agentId: AGENT,
    visibility: 'private',
    ownerIdentity: 'user:u1',
    visibilitySource: 'explicit',
    visibilityRev: 2,
    visibilityAckedRev: -1,
    ...over
  } as SessionMetaRecord
}

/** A registry holding one daemon, optionally advertising the feature. */
function connReg(opts: { connected?: boolean; feature?: boolean; externalFeature?: boolean } = {}) {
  const { connected = true, feature = true, externalFeature = true } = opts
  return {
    get: (id: string) =>
      connected && id === DAEMON
        ? {
            capabilities: {
              features: [
                ...(feature ? [SESSION_VISIBILITY_FEATURE] : []),
                ...(externalFeature ? [SLACK_SESSION_AUDIENCE_FEATURE] : [])
              ]
            }
          }
        : undefined
  } as never
}

/**
 * The agent repo as the service reads it from BOTH sides: the live push resolves one agent's
 * serving member, the replay asks which agents the connecting member serves.
 */
function agentRepo(daemonId: string | null | undefined = DAEMON) {
  const agent = daemonId ? { id: AGENT, daemonId } : { id: AGENT }
  return {
    getUnscoped: vi.fn(async () => agent),
    listForDaemon: vi.fn(async () => (daemonId ? [agent] : [])),
    listByIds: vi.fn(async () => [])
  } as never
}

type PrivateRow = { orgId: string; sessionId: string; visibility: 'private'; visibilityRev: number }

function deps(
  over: {
    connReg?: never
    sessionVisibility?: unknown
    daemonId?: string | null
    /** Successive snapshot pages the repo hands back, newest call first. */
    snapshotPages?: Array<
      Array<{ orgId: string; sessionId: string; visibility: 'private' | 'org' | 'external'; visibilityRev: number }>
    >
    unackedAfter?: number[]
    /** Successive PRIVATE pages (phase 2), newest call first. */
    privatePages?: Array<Array<{ orgId: string; sessionId: string; visibility: 'private'; visibilityRev: number }>>
  } = {}
) {
  const recordVisibilityAck = vi.fn(async () => {})
  const sessionVisibility =
    over.sessionVisibility ??
    vi.fn(async (_d: string, _orgId: string, p: { sessionId: string; visibilityRev: number }) => ({
      sessionId: p.sessionId,
      visibilityRev: p.visibilityRev,
      status: 'applied' as const
    }))
  const daemonId = over.daemonId === undefined ? DAEMON : over.daemonId
  const pages = [...(over.snapshotPages ?? [[]])]
  const unacked = [...(over.unackedAfter ?? [0])]
  const privatePages = [...(over.privatePages ?? [[]])]
  const visibilitySnapshotForAgents = vi.fn(async () => pages.shift() ?? [])
  const countUnackedVisibilityForAgents = vi.fn(async () => unacked.shift() ?? 0)
  const privateVisibilityPage = vi.fn<
    (agentIds: string[], limit: number, includeExternal: boolean, afterId?: string) => Promise<PrivateRow[]>
  >(async () => privatePages.shift() ?? [])
  const sessionVisibilitySnapshot = vi.fn<
    (daemonId: string, orgId: string, entries: Array<Omit<PrivateRow, 'orgId'>>) => Promise<{ ok: boolean }>
  >(async () => ({ ok: true }))
  return {
    recordVisibilityAck,
    sessionVisibility,
    visibilitySnapshotForAgents,
    privateVisibilityPage,
    sessionVisibilitySnapshot,
    push: new SessionVisibilityPushService({
      repos: {
        session: {
          recordVisibilityAck,
          visibilitySnapshotForAgents,
          countUnackedVisibilityForAgents,
          privateVisibilityPage,
          get: vi.fn(async () => null)
        } as never,
        agent: agentRepo(daemonId)
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

    // The agent rides along: the daemon keys its gate by (agent, ACP session id).
    expect(sessionVisibility).toHaveBeenCalledWith(DAEMON, ORG, {
      sessionId: 'acp-1',
      agentId: AGENT,
      visibility: 'private',
      sharedMemoryExcluded: true,
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

  it('does not send an external visibility value to a daemon with only the legacy feature', async () => {
    const old = deps({ connReg: connReg({ externalFeature: false }) as never })
    await old.push.notifySessions([session({ visibility: 'external', externalProvider: 'slack', ownerIdentity: null })])
    expect(old.sessionVisibility).not.toHaveBeenCalled()

    const current = deps()
    await current.push.notifySessions([
      session({ visibility: 'external', externalProvider: 'slack', ownerIdentity: null })
    ])
    // External sessions capture like org now — only `private` excludes memory.
    expect(current.sessionVisibility).toHaveBeenCalledWith(
      DAEMON,
      ORG,
      expect.objectContaining({ visibility: 'external', sharedMemoryExcluded: false })
    )
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
    const sessionVisibility = vi.fn(
      async (_d: string, _orgId: string, p: { sessionId: string; visibilityRev: number }) => {
        if (p.sessionId === 'acp-bad') throw new Error('boom')
        return { sessionId: p.sessionId, visibilityRev: p.visibilityRev, status: 'applied' as const }
      }
    )
    const { push, recordVisibilityAck } = deps({ sessionVisibility })
    await push.notifySessions([session({ id: SessionId('acp-bad') }), session({ id: SessionId('acp-good') })])
    expect(recordVisibilityAck).toHaveBeenCalledWith('acp-good', 2)
  })
})

describe('replayTo — register-time convergence', () => {
  const page = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({
      orgId: ORG,
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
    expect(d.visibilitySnapshotForAgents).toHaveBeenCalledTimes(1)
  })

  it('splits a shared daemon snapshot into one organization-scoped request per org', async () => {
    const d = deps({ snapshotPages: [[...page(1), { ...page(1, 1)[0]!, orgId: 'org-b' }]] })
    await d.push.replayTo(DAEMON as never)
    expect(d.sessionVisibilitySnapshot).toHaveBeenNthCalledWith(1, DAEMON, ORG, [
      expect.objectContaining({ sessionId: 'acp-0' })
    ])
    expect(d.sessionVisibilitySnapshot).toHaveBeenNthCalledWith(2, DAEMON, 'org-b', [
      expect.objectContaining({ sessionId: 'acp-1' })
    ])
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
      const visibilitySnapshotForAgents = vi.fn(async () => page(500))
      const countUnackedVisibilityForAgents = vi.fn(async () => 5_000)
      const sessionVisibilitySnapshot = vi.fn(async () => ({ ok: true }))
      const push = new SessionVisibilityPushService({
        repos: {
          session: {
            recordVisibilityAck: vi.fn(async () => {}),
            visibilitySnapshotForAgents,
            countUnackedVisibilityForAgents,
            privateVisibilityPage: vi.fn(async () => []),
            get: vi.fn(async () => null)
          } as never,
          agent: agentRepo(DAEMON)
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

  it('resumes after a repo failure instead of abandoning the stale tail', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      // A repo read rejects OUTSIDE sendSnapshotChunk's catch. Left unhandled it
      // would both surface as an unhandled rejection and strand the gates we
      // already know are stale.
      const visibilitySnapshotForAgents = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(page(2))
      const sessionVisibilitySnapshot = vi.fn(async () => ({ ok: true }))
      const push = new SessionVisibilityPushService({
        repos: {
          session: {
            recordVisibilityAck: vi.fn(async () => {}),
            visibilitySnapshotForAgents,
            countUnackedVisibilityForAgents: vi.fn(async () => 0),
            privateVisibilityPage: vi.fn(async () => []),
            get: vi.fn(async () => null)
          } as never,
          agent: agentRepo(DAEMON)
        },
        control: { sessionVisibility: vi.fn(), sessionVisibilitySnapshot } as never,
        connReg: connReg(),
        log: { warn }
      })

      await expect(push.replayTo(DAEMON as never)).resolves.toBeUndefined()
      expect(sessionVisibilitySnapshot).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(30_000)
      await push.settle()
      expect(sessionVisibilitySnapshot).toHaveBeenCalledTimes(1) // the tail went out
      push.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops scheduling once shut down, and settles a resume that already fired', async () => {
    vi.useFakeTimers()
    try {
      const visibilitySnapshotForAgents = vi.fn(async () => page(500))
      const push = new SessionVisibilityPushService({
        repos: {
          session: {
            recordVisibilityAck: vi.fn(async () => {}),
            visibilitySnapshotForAgents,
            countUnackedVisibilityForAgents: vi.fn(async () => 5_000),
            privateVisibilityPage: vi.fn(async () => []),
            get: vi.fn(async () => null)
          } as never,
          agent: agentRepo(DAEMON)
        },
        control: { sessionVisibility: vi.fn(), sessionVisibilitySnapshot: vi.fn(async () => ({ ok: true })) } as never,
        connReg: connReg(),
        log: { warn: vi.fn() }
      })

      await push.replayTo(DAEMON as never) // stalls, arms a resume
      push.stop()
      const callsAtShutdown = visibilitySnapshotForAgents.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      await push.settle()
      // Nothing re-armed and nothing touched the database after shutdown.
      expect(visibilitySnapshotForAgents.mock.calls.length).toBe(callsAtShutdown)
      await expect(push.replayTo(DAEMON as never)).resolves.toBeUndefined()
      expect(visibilitySnapshotForAgents.mock.calls.length).toBe(callsAtShutdown)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes after a retryable send failure — the daemon is still connected', async () => {
    vi.useFakeTimers()
    try {
      // A correlator timeout surfaces as an ordinary rejection, NOT NoConnection:
      // the daemon is still there, so no register is coming to converge the tail.
      const sessionVisibilitySnapshot = vi
        .fn()
        .mockRejectedValueOnce(new Error('INTERNAL: ack timeout'))
        .mockResolvedValue({ ok: true })
      const push = new SessionVisibilityPushService({
        repos: {
          session: {
            recordVisibilityAck: vi.fn(async () => {}),
            visibilitySnapshotForAgents: vi.fn(async () => page(2)),
            countUnackedVisibilityForAgents: vi.fn(async () => 0),
            privateVisibilityPage: vi.fn(async () => []),
            get: vi.fn(async () => null)
          } as never,
          agent: agentRepo(DAEMON)
        },
        control: { sessionVisibility: vi.fn(), sessionVisibilitySnapshot } as never,
        connReg: connReg(),
        log: { warn: vi.fn() }
      })

      await push.replayTo(DAEMON as never)
      await vi.advanceTimersByTimeAsync(30_000)
      await push.settle()
      expect(sessionVisibilitySnapshot).toHaveBeenCalledTimes(2) // it came back
      push.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes when recording the acks fails, so the CP does not lose the tail', async () => {
    vi.useFakeTimers()
    try {
      const recordVisibilityAck = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined)
      const sessionVisibilitySnapshot = vi.fn(async () => ({ ok: true }))
      const push = new SessionVisibilityPushService({
        repos: {
          session: {
            recordVisibilityAck,
            visibilitySnapshotForAgents: vi.fn(async () => page(2)),
            countUnackedVisibilityForAgents: vi.fn(async () => 0),
            privateVisibilityPage: vi.fn(async () => []),
            get: vi.fn(async () => null)
          } as never,
          agent: agentRepo(DAEMON)
        },
        control: { sessionVisibility: vi.fn(), sessionVisibilitySnapshot } as never,
        connReg: connReg(),
        log: { warn: vi.fn() }
      })

      await push.replayTo(DAEMON as never)
      await vi.advanceTimersByTimeAsync(30_000)
      await push.settle()
      // Re-sent and recorded: the daemon answers `superseded`, nothing double-applies.
      expect(sessionVisibilitySnapshot).toHaveBeenCalledTimes(2)
      push.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT arm a timer when the daemon simply disconnected — register converges', async () => {
    vi.useFakeTimers()
    try {
      const sessionVisibilitySnapshot = vi.fn(async () => {
        throw new NoConnection(DAEMON)
      })
      const visibilitySnapshotForAgents = vi.fn(async () => page(500))
      const push = new SessionVisibilityPushService({
        repos: {
          session: {
            recordVisibilityAck: vi.fn(async () => {}),
            visibilitySnapshotForAgents,
            countUnackedVisibilityForAgents: vi.fn(async () => 10),
            privateVisibilityPage: vi.fn(async () => []),
            get: vi.fn(async () => null)
          } as never,
          agent: agentRepo(DAEMON)
        },
        control: { sessionVisibility: vi.fn(), sessionVisibilitySnapshot } as never,
        connReg: connReg(),
        log: { warn: vi.fn() }
      })

      await push.replayTo(DAEMON as never)
      await vi.advanceTimersByTimeAsync(60_000)
      await push.settle()
      expect(visibilitySnapshotForAgents).toHaveBeenCalledTimes(1)
      push.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // The ACK watermark is per SESSION, not per daemon: once duty can move a session's server, a
  // previous holder's ack marks a gate "delivered" to a member that never saw it. Phase 1 then
  // stops on `unacked === 0` and the older private gates are never sent. Phase 2 is what covers
  // them, so it must run even when phase 1 reports full convergence.
  it('re-sends the private gates after the unacked phase reports nothing outstanding', async () => {
    const priv = [{ orgId: ORG, sessionId: 'acp-old-private', visibility: 'private' as const, visibilityRev: 3 }]
    const d = deps({ snapshotPages: [page(500)], unackedAfter: [0], privatePages: [priv] })
    await d.push.replayTo(DAEMON as never)

    expect(d.privateVisibilityPage).toHaveBeenCalledTimes(1)
    const sent = d.sessionVisibilitySnapshot.mock.calls.at(-1)!
    expect((sent[2] as Array<{ sessionId: string }>).map((e) => e.sessionId)).toEqual(['acp-old-private'])
  })

  it('cursors the private phase on the last id of a full page', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      orgId: ORG,
      sessionId: `acp-p-${String(i).padStart(3, '0')}`,
      visibility: 'private' as const,
      visibilityRev: 1
    }))
    const tail = [{ orgId: ORG, sessionId: 'acp-p-500', visibility: 'private' as const, visibilityRev: 1 }]
    const d = deps({ privatePages: [full, tail] })
    await d.push.replayTo(DAEMON as never)

    expect(d.privateVisibilityPage).toHaveBeenCalledTimes(2)
    // Blind to the watermark, so the cursor is the ONLY thing that ends the walk.
    expect(d.privateVisibilityPage.mock.calls[1]![3]).toBe('acp-p-499')
  })

  it('does not start the private phase when the unacked phase aborted', async () => {
    const d = deps({ snapshotPages: [page(500), page(500, 500)], unackedAfter: [500, 0] })
    d.sessionVisibilitySnapshot.mockImplementationOnce(async () => {
      throw new NoConnection(DAEMON)
    })
    await d.push.replayTo(DAEMON as never)

    // The daemon is gone; its next register redoes both phases from scratch.
    expect(d.privateVisibilityPage).not.toHaveBeenCalled()
  })

  it('sends nothing to a daemon that does not advertise the feature', async () => {
    const d = deps({ snapshotPages: [page(3)], connReg: connReg({ feature: false }) as never })
    await d.push.replayTo(DAEMON as never)
    expect(d.visibilitySnapshotForAgents).not.toHaveBeenCalled()
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
      session({ id: SessionId('root'), visibilityRev: 1, visibilityAckedRev: 1 }),
      session({ id: SessionId('child'), visibilityRev: 1, visibilityAckedRev: -1 })
    ])
    expect(await visibilityStateOf(push, repos as never, ['root' as never])).toBe('pending')
  })

  it('reports pending when the subtree is larger than one read evaluates', async () => {
    // All 501 rows are fully acked: the ONLY reason to report pending is that we
    // could not see the whole subtree, and claiming a verified cutover from a
    // partial read would be a false promise.
    const rows = Array.from({ length: SUBTREE_OVERFLOW }, (_, i) =>
      session({ id: SessionId(`s-${i}`), visibilityRev: 1, visibilityAckedRev: 1 })
    )
    const { push, repos } = subtreeDeps(rows)
    expect(await visibilityStateOf(push, repos as never, ['root' as never])).toBe('pending')
  })

  it('reports applied for a fully acked subtree within the cap', async () => {
    const { push, repos } = subtreeDeps([session({ id: SessionId('root'), visibilityRev: 1, visibilityAckedRev: 1 })])
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
    // Rev 0 rows that ARE pushed at ingest (A2A children: inherited /
    // inherited_pending) genuinely wait for their daemon's confirmation.
    const { push } = deps()
    expect(
      await push.isApplied([session({ visibilitySource: 'inherited', visibilityRev: 0, visibilityAckedRev: -1 })])
    ).toBe(false)
    expect(
      await push.isApplied([session({ visibilitySource: 'inherited', visibilityRev: 0, visibilityAckedRev: 0 })])
    ).toBe(true)
  })

  it('is vacuously applied for an initial §4.2 classification — nothing was pushed', async () => {
    // A default-classified row is never pushed at ingest (the daemon holds the
    // layer-1 local state already), so its -1 watermark is not a pending
    // cutover. Without this, every fresh webchat/DM session shows "Applying…"
    // until its daemon happens to re-register.
    const { push } = deps()
    expect(
      await push.isApplied([session({ visibilitySource: 'default', visibilityRev: 0, visibilityAckedRev: -1 })])
    ).toBe(true)
  })

  it('waits for an ack after a policy cutover bumps a default-classified row', async () => {
    const { push } = deps()
    expect(
      await push.isApplied([session({ visibilitySource: 'default', visibilityRev: 1, visibilityAckedRev: 0 })])
    ).toBe(false)
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
    const acked = session({ id: SessionId('acp-1'), visibilityRev: 1, visibilityAckedRev: 1 })
    const unacked = session({ id: SessionId('acp-2'), visibilityRev: 1, visibilityAckedRev: 0 })
    expect(await push.isApplied([acked, unacked])).toBe(false)
  })
})
