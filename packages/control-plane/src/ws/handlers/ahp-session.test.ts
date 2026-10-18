import { describe, expect, it, vi } from 'vitest'
import { handleAhpSession } from './ahp-session.js'

function fixture() {
  const result = { ok: true, sessions: [] }
  const list = vi.fn(async () => result)
  const replyTo = vi.fn()
  const release = vi.fn()
  const deps = {
    agent: {
      get: vi.fn(async () => ({ id: 'agent', orgId: 'org', placementKind: 'daemon', daemonId: 'daemon', setId: null }))
    },
    agentMutations: { tryBeginMutation: () => release },
    ahpSessions: { list }
  }
  const conn = { daemonId: 'daemon', orgId: 'org', replyTo }
  const frame = {
    type: 'ahp/session/list',
    payload: { orgId: 'org', agentId: 'agent', grant: 'opaque-secret', limit: 10 }
  }
  const run = () => handleAhpSession(frame as never, conn as never, deps as never)
  return { conn, deps, frame, list, replyTo, release, run }
}

describe('AHP registry control edge', () => {
  it('admits the serving daemon and replies with metadata only', async () => {
    const f = fixture()
    await f.run()
    expect(f.list).toHaveBeenCalledWith(f.frame.payload)
    expect(f.replyTo).toHaveBeenCalledWith(f.frame, 'ahp/session/list/ok', { ok: true, sessions: [] })
    expect(f.release).toHaveBeenCalledOnce()
  })
  it.each(['org', 'placement'])('refuses an unrelated %s without calling the service', async (fence) => {
    const f = fixture()
    if (fence === 'org') f.conn.orgId = 'foreign'
    else f.conn.daemonId = 'foreign'
    await f.run()
    expect(f.list).not.toHaveBeenCalled()
    expect(f.replyTo).toHaveBeenCalledWith(f.frame, 'ahp/session/list/ok', { ok: false, reason: 'unavailable' })
  })
  it('returns explicit unavailability on store loss and always releases the mutation lease', async () => {
    const f = fixture()
    f.list.mockRejectedValue(new Error('database down'))
    await f.run()
    expect(f.replyTo).toHaveBeenCalledWith(f.frame, 'ahp/session/list/ok', { ok: false, reason: 'unavailable' })
    expect(f.release).toHaveBeenCalledOnce()
  })
})
