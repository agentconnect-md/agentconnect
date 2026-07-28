import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame, ChildSessionStatus } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleChildSessionStatus } from './child-session-status.js'

const ASKING_DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OWNING_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const CHILD_AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'org-a'

const PARENT_SESSION = 'acp-parent-1'
const CHILD_SESSION = 'slack:C1:100.1:peer'

const ANSWER: ChildSessionStatus = {
  found: true,
  agentId: CHILD_AGENT,
  status: 'in-progress',
  state: 'prompting',
  updatedAt: 42
}

function frame(payload: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-28T00:00:00.000Z',
    type: 'session/child-status',
    payload: {
      parentSessionId: PARENT_SESSION,
      childSessionId: CHILD_SESSION,
      childAgentId: CHILD_AGENT,
      ...payload
    }
  } as AnyFrame
}

function fakeConn() {
  return {
    daemonId: ASKING_DAEMON,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

/** Deps with every check passing; each test overrides exactly the one it exercises. */
function fakeDeps(
  over: {
    parent?: unknown
    childAgent?: unknown
    ownerConn?: unknown
    request?: ReturnType<typeof vi.fn>
  } = {}
) {
  const request = over.request ?? vi.fn(async () => ANSWER)
  const owner =
    'ownerConn' in over
      ? over.ownerConn
      : { daemonId: OWNING_DAEMON, reachable: true, sessionEpoch: 7, conn: { request } }
  return {
    deps: {
      registry: { get: async () => ({ id: ASKING_DAEMON, orgId: ORG }) },
      session: {
        get: async () =>
          'parent' in over ? over.parent : { id: PARENT_SESSION, daemonId: ASKING_DAEMON, agentId: CHILD_AGENT }
      },
      agent: {
        get: async () =>
          'childAgent' in over ? over.childAgent : { id: CHILD_AGENT, orgId: ORG, daemonId: OWNING_DAEMON }
      },
      connReg: { get: () => owner }
    } as unknown as DaemonWsDeps,
    request
  }
}

const replied = (conn: ReturnType<typeof fakeConn>): ChildSessionStatus =>
  conn.replyTo.mock.calls[0]![2] as ChildSessionStatus

describe('handleChildSessionStatus — cross-daemon child status (session-concept §5.4)', () => {
  it('forwards the lineage pair to the owning daemon and returns its answer verbatim', async () => {
    const { deps, request } = fakeDeps()
    const conn = fakeConn()
    await handleChildSessionStatus(frame(), conn, deps)

    expect(conn.replyTo.mock.calls[0]![1]).toBe('session/child-status/ok')
    expect(replied(conn)).toEqual(ANSWER)
    // childAgentId is dropped — placement is resolved — and the epoch fence is stamped.
    expect(request).toHaveBeenCalledWith(
      'session/child-status/probe',
      { parentSessionId: PARENT_SESSION, childSessionId: CHILD_SESSION },
      { epoch: 7 }
    )
  })

  // (a) The parent-session claim is untrusted: without this check any daemon could name someone
  // else's parent session and read its children.
  it('refuses when the claimed parent session was reported by a DIFFERENT daemon', async () => {
    const { deps, request } = fakeDeps({ parent: { id: PARENT_SESSION, daemonId: OWNING_DAEMON } })
    const conn = fakeConn()
    await handleChildSessionStatus(frame(), conn, deps)

    expect(replied(conn)).toEqual({ found: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses when the claimed parent session is unknown to the CP', async () => {
    const { deps, request } = fakeDeps({ parent: null })
    const conn = fakeConn()
    await handleChildSessionStatus(frame(), conn, deps)

    expect(replied(conn)).toEqual({ found: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a child agent in another org even when both daemons are reachable', async () => {
    const { deps, request } = fakeDeps({ childAgent: { id: CHILD_AGENT, orgId: 'org-b', daemonId: OWNING_DAEMON } })
    const conn = fakeConn()
    await handleChildSessionStatus(frame(), conn, deps)

    expect(replied(conn)).toEqual({ found: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses an unknown or unplaced child agent', async () => {
    for (const childAgent of [null, { id: CHILD_AGENT, orgId: ORG, daemonId: null }]) {
      const { deps, request } = fakeDeps({ childAgent })
      const conn = fakeConn()
      await handleChildSessionStatus(frame(), conn, deps)
      expect(replied(conn)).toEqual({ found: false })
      expect(request).not.toHaveBeenCalled()
    }
  })

  // Forwarding a child that lives on the ASKING daemon would deadlock its own in-flight request.
  it('does not forward back to the asking daemon when placement says the child is local', async () => {
    const { deps, request } = fakeDeps({ childAgent: { id: CHILD_AGENT, orgId: ORG, daemonId: ASKING_DAEMON } })
    const conn = fakeConn()
    await handleChildSessionStatus(frame(), conn, deps)

    expect(replied(conn)).toEqual({ found: false })
    expect(request).not.toHaveBeenCalled()
  })

  // Transport failure must stay distinguishable from a lineage denial, so the asking agent is told
  // to retry instead of that its child does not exist.
  it('reports reason:offline when the owning daemon has no connection or is unreachable', async () => {
    for (const ownerConn of [undefined, { daemonId: OWNING_DAEMON, reachable: false, sessionEpoch: 7, conn: {} }]) {
      const { deps } = fakeDeps({ ownerConn })
      const conn = fakeConn()
      await handleChildSessionStatus(frame(), conn, deps)
      expect(replied(conn)).toEqual({ found: false, reason: 'offline' })
    }
  })

  it('reports reason:offline when the forwarded probe throws (timeout / socket drop)', async () => {
    const { deps } = fakeDeps({
      request: vi.fn(async () => {
        throw new Error('ack timeout')
      })
    })
    const conn = fakeConn()
    await handleChildSessionStatus(frame(), conn, deps)

    expect(replied(conn)).toEqual({ found: false, reason: 'offline' })
  })

  // The CP never asserts "this is your child" — it relays whatever the owning daemon decided.
  it('passes through a found:false verdict from the owning daemon unchanged', async () => {
    const { deps } = fakeDeps({ request: vi.fn(async () => ({ found: false }) as ChildSessionStatus) })
    const conn = fakeConn()
    await handleChildSessionStatus(frame(), conn, deps)

    expect(replied(conn)).toEqual({ found: false })
  })
})
