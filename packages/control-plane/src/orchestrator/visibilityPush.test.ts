/**
 * The §5.1 gate-push service: who gets pushed to, what an ack records, and when
 * the §4.3 endpoint may call a tighten `applied`. Pure unit test — the registry,
 * the sender, and the repos are all fakes, so no Docker and no socket.
 */
import { describe, it, expect, vi } from 'vitest'
import { SESSION_VISIBILITY_FEATURE } from '@agentconnect.md/protocol'
import { SessionVisibilityPushService } from './visibilityPush.js'
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

function deps(over: { connReg?: never; sessionVisibility?: unknown; daemonId?: string | null } = {}) {
  const recordVisibilityAck = vi.fn(async () => {})
  const sessionVisibility =
    over.sessionVisibility ??
    vi.fn(async (_d: string, p: { sessionId: string; visibilityRev: number }) => ({
      sessionId: p.sessionId,
      visibilityRev: p.visibilityRev,
      status: 'applied' as const
    }))
  const daemonId = over.daemonId === undefined ? DAEMON : over.daemonId
  return {
    recordVisibilityAck,
    sessionVisibility,
    push: new SessionVisibilityPushService({
      repos: {
        session: {
          recordVisibilityAck,
          visibilitySnapshotForDaemon: vi.fn(async () => []),
          get: vi.fn(async () => null)
        } as never,
        agent: { get: vi.fn(async () => (daemonId ? { id: AGENT, daemonId } : { id: AGENT })) } as never
      },
      control: { sessionVisibility, sessionVisibilitySnapshot: vi.fn(async () => ({ ok: true })) } as never,
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

  it('is vacuously applied when nothing can ever ack (unplaced / offline / pre-upgrade)', async () => {
    for (const d of [
      deps({ daemonId: null }),
      deps({ connReg: connReg({ connected: false }) as never }),
      deps({ connReg: connReg({ feature: false }) as never })
    ]) {
      expect(await d.push.isApplied([session({ visibilityRev: 1, visibilityAckedRev: -1 })])).toBe(true)
    }
  })

  it('is pending if ANY affected session of a cascade is still unacked', async () => {
    const { push } = deps()
    const acked = session({ id: 'acp-1', visibilityRev: 1, visibilityAckedRev: 1 })
    const unacked = session({ id: 'acp-2', visibilityRev: 1, visibilityAckedRev: 0 })
    expect(await push.isApplied([acked, unacked])).toBe(false)
  })
})
