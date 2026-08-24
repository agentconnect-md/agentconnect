/**
 * `visibleToRequester` — the ONE authorization predicate behind both `channel/agents`
 * scopes (org-wide directory and channel-filtered). Tested directly because it is the
 * discovery-IS-authorization surface: anything it leaks is callable.
 *
 * Plus the handler-level DAEMON-OWNERSHIP BIND that runs before it: `requesterAgentId` is
 * the daemon's word, so a daemon must not be able to read the directory of an agent placed
 * on someone else (the read-side twin of the relay's `claimedFromAgentId` check).
 */
import { describe, it, expect, vi } from 'vitest'
import { handleChannelAgents, visibleToRequester } from './channel-agents.js'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ChannelAgentRecord, OrgAgentRecord } from '../../persistence/ports.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { AgentId, type DaemonId } from '../../domain/ids.js'
import { PlacementResolver } from '../../orchestrator/placementResolver.js'
import { systemClock } from '../../domain/clock.js'

const CALLER = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const PEER = AgentId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const OTHER = AgentId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
const ASKING_DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const ORG = 'org-a'
const SET = 'set-pool'

function rec(over: Partial<ChannelAgentRecord> & { agentId: ChannelAgentRecord['agentId'] }): ChannelAgentRecord {
  return {
    name: 'agent',
    displayName: null,
    description: null,
    status: 'active',
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: [],
    ...over
  }
}

const ids = (roster: ChannelAgentRecord[]): string[] => roster.map((a) => a.agentId).sort()

describe('visibleToRequester (agent-collaboration discovery predicate)', () => {
  it('reveals every peer when both policies are open', () => {
    const visible = visibleToRequester([rec({ agentId: CALLER }), rec({ agentId: PEER })], CALLER)
    expect(ids(visible)).toEqual([CALLER, PEER].sort())
  })

  it('hides a peer whose INBOUND policy does not admit the caller', () => {
    const visible = visibleToRequester(
      [
        rec({ agentId: CALLER }),
        rec({ agentId: PEER, callPolicy: 'selected', allowedCallerAgentIds: [OTHER] }),
        rec({ agentId: OTHER, callPolicy: 'selected', allowedCallerAgentIds: [CALLER] })
      ],
      CALLER
    )
    expect(ids(visible)).toEqual([CALLER, OTHER].sort())
  })

  it("hides a peer outside the caller's OUTBOUND allow-list", () => {
    const visible = visibleToRequester(
      [
        rec({ agentId: CALLER, outboundPolicy: 'selected', allowedTargetAgentIds: [PEER] }),
        rec({ agentId: PEER }),
        rec({ agentId: OTHER })
      ],
      CALLER
    )
    expect(ids(visible)).toEqual([CALLER, PEER].sort())
  })

  it('requires BOTH directions — an outbound-allowed peer that refuses the caller stays hidden', () => {
    const visible = visibleToRequester(
      [
        rec({ agentId: CALLER, outboundPolicy: 'selected', allowedTargetAgentIds: [PEER] }),
        rec({ agentId: PEER, callPolicy: 'selected', allowedCallerAgentIds: [OTHER] })
      ],
      CALLER
    )
    expect(ids(visible)).toEqual([CALLER])
  })

  it('always shows the caller itself, even under a selected outbound policy that omits it', () => {
    // An agent does not list itself in its own allow-list, yet must see itself.
    const visible = visibleToRequester(
      [rec({ agentId: CALLER, outboundPolicy: 'selected', allowedTargetAgentIds: [] })],
      CALLER
    )
    expect(ids(visible)).toEqual([CALLER])
  })

  it('fails CLOSED when the requester is not in the roster', () => {
    // The roster is always already org-scoped, so this is also how a CROSS-ORG
    // requester is rejected: it simply is not in the target org's directory. A
    // deleted/unknown requesterAgentId lands here too — empty, never open.
    expect(visibleToRequester([rec({ agentId: PEER }), rec({ agentId: OTHER })], CALLER)).toEqual([])
  })

  it('never materializes a cross-org peer just because an allow-list names it', () => {
    // OTHER lives in another org, so it is absent from this org-scoped roster;
    // naming it on both sides cannot conjure an entry.
    const visible = visibleToRequester(
      [rec({ agentId: CALLER, outboundPolicy: 'selected', allowedTargetAgentIds: [OTHER] })],
      CALLER
    )
    expect(ids(visible)).toEqual([CALLER])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The daemon-ownership bind (§2.2/§6.1)
// ───────────────────────────────────────────────────────────────────────────

function frame(payload: Record<string, unknown>): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-29T00:00:00.000Z',
    type: 'channel/agents',
    payload: { platform: 'slack', requesterAgentId: CALLER, ...payload }
  } as AnyFrame
}

function fakeConn() {
  return { daemonId: ASKING_DAEMON, replyTo: vi.fn() } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
  }
}

/**
 * Deps whose whole org roster is callable; `placedOn` is where the CP says the CALLER runs.
 * `channelExtra` is an agent the CHANNEL query returns that the org directory does not — the
 * unplaced-but-still-integrated shape (`agentsInChannel` joins integrations, not placements).
 */
function fakeDeps(placedOn: string | null, channelExtra?: ChannelAgentRecord) {
  const orgRoster: OrgAgentRecord[] = [
    { ...rec({ agentId: CALLER }), placementKind: 'daemon', daemonId: placedOn, setId: null },
    { ...rec({ agentId: PEER }), placementKind: 'daemon', daemonId: ASKING_DAEMON, setId: null }
  ]
  const agentsInChannel = vi.fn(async (): Promise<ChannelAgentRecord[]> => [
    rec({ agentId: CALLER }),
    rec({ agentId: PEER }),
    ...(channelExtra ? [channelExtra] : [])
  ])
  return {
    deps: {
      registry: { getUnscoped: async () => ({ id: ASKING_DAEMON, orgId: ORG }) },
      agent: {
        // `orgDirectory` never returns an unplaced row (see PgAgentRepo), so a
        // `placedOn: null` caller is simply absent from it.
        orgDirectory: async () => orgRoster.filter((a) => a.daemonId !== null)
      },
      integration: { agentsInChannel }
    } as unknown as DaemonWsDeps,
    agentsInChannel
  }
}

/**
 * The pool shape: CALLER is placed on a SET (so its row names no machine) and its duty is held by
 * `holders`; only `confirmed` may be addressed for ingress. PEER stays machine-placed on the asking
 * daemon, so the reply has something routable in it either way.
 */
function fakePoolDeps(duty: { holders: string[]; confirmed: string[] }) {
  const orgRoster: OrgAgentRecord[] = [
    { ...rec({ agentId: CALLER }), placementKind: 'set', daemonId: null, setId: SET },
    { ...rec({ agentId: PEER }), placementKind: 'daemon', daemonId: ASKING_DAEMON, setId: null }
  ]
  const forCaller = (agentId: string, ids: string[]) => (agentId === CALLER ? ids : [])
  const placementResolver = new PlacementResolver({
    clock: systemClock,
    duties: {
      holdersOf: async (agentId) => forCaller(agentId, duty.holders) as DaemonId[],
      confirmedHoldersOf: async (agentId) => forCaller(agentId, duty.confirmed) as DaemonId[]
    }
  })
  return {
    deps: {
      registry: { getUnscoped: async () => ({ id: ASKING_DAEMON, orgId: ORG }) },
      agent: { orgDirectory: async () => orgRoster },
      integration: { agentsInChannel: async () => [] },
      placementResolver
    } as unknown as DaemonWsDeps
  }
}

const rosterNames = (conn: ReturnType<typeof fakeConn>): string[] =>
  ((conn.replyTo.mock.calls[0]![2] as { agents: Array<{ agentId: string }> }).agents ?? []).map((a) => a.agentId)

describe('handleChannelAgents — daemon-ownership bind on requesterAgentId', () => {
  it('serves the roster when the CP agrees the requester is placed on the asking daemon', async () => {
    for (const channel of [undefined, 'C1']) {
      const { deps } = fakeDeps(ASKING_DAEMON)
      const conn = fakeConn()
      await handleChannelAgents(frame({ ...(channel !== undefined ? { channel } : {}) }), conn, deps)
      expect(conn.replyTo.mock.calls[0]![1]).toBe('channel/agents/ok')
      expect(rosterNames(conn).sort()).toEqual([CALLER, PEER].sort())
    }
  })

  // The forgery this bind exists to stop: daemon D1 asserts an agent that the CP has
  // placed on D2 and reads its policy-filtered peer directory. Both scopes must refuse.
  it('fails CLOSED in BOTH scopes when the requester is placed on ANOTHER daemon', async () => {
    for (const channel of [undefined, 'C1']) {
      const { deps, agentsInChannel } = fakeDeps(OTHER_DAEMON)
      const conn = fakeConn()
      await handleChannelAgents(frame({ ...(channel !== undefined ? { channel } : {}) }), conn, deps)
      // A reply, not an error: a forged id looks exactly like "nobody is callable".
      expect(conn.replyTo.mock.calls[0]![1]).toBe('channel/agents/ok')
      expect(rosterNames(conn)).toEqual([])
      // The channel scope must not even read the membership it was asked about.
      expect(agentsInChannel).not.toHaveBeenCalled()
    }
  })

  it('fails CLOSED in BOTH scopes for an UNPLACED requester', async () => {
    // No owning daemon ⇒ no daemon may speak for it, including the brief window while an
    // agent MOVE is in flight (the CP row is the authority on ownership).
    for (const channel of [undefined, 'C1']) {
      const { deps } = fakeDeps(null)
      const conn = fakeConn()
      await handleChannelAgents(frame({ ...(channel !== undefined ? { channel } : {}) }), conn, deps)
      expect(rosterNames(conn)).toEqual([])
    }
  })

  it('fails CLOSED when the asserted requester is unknown to the CP', async () => {
    // Unknown, or in ANOTHER ORG: the bind reads the org-scoped directory, so a foreign
    // requester is refused HERE rather than by the downstream visibility filter — and the
    // channel membership it asked about is never even read.
    for (const channel of [undefined, 'C1']) {
      const { deps, agentsInChannel } = fakeDeps(ASKING_DAEMON)
      const conn = fakeConn()
      await handleChannelAgents(frame({ ...(channel !== undefined ? { channel } : {}) }), conn, {
        ...deps,
        agent: { orgDirectory: async () => [] }
      } as unknown as DaemonWsDeps)
      expect(rosterNames(conn)).toEqual([])
      expect(agentsInChannel).not.toHaveBeenCalled()
    }
  })

  // F3, the half that survived the `orgDirectory` fix: `agentsInChannel` joins INTEGRATIONS,
  // so an unplaced agent whose bot still sits in the channel comes back from it — while
  // `buildCollabSnapshot` drops daemonId-less rows from the `agents[]` wakes are authorized
  // against. Listing it would advertise a peer that cannot be called (the model gets a bare
  // 'not_allowed' and retries). The channel scope is an INTERSECTION for exactly this reason.
  it('omits a channel member the org directory does not place (listed-but-uncallable)', async () => {
    const { deps } = fakeDeps(ASKING_DAEMON, rec({ agentId: OTHER }))
    const conn = fakeConn()
    await handleChannelAgents(frame({ channel: 'C1' }), conn, deps)
    expect(rosterNames(conn).sort()).toEqual([CALLER, PEER].sort())
  })

  // The pool window this bind used to close over the wrong predicate. A grant makes a member a
  // HOLDER at once; it becomes a CONFIRMED holder only from its first reporting digest, and
  // `resolveDirectory` deliberately names confirmed holders because it addresses ingress. Binding
  // the ownership question on that projection refused a member that genuinely held the agent.
  it('serves a member that HOLDS the requester but has not yet confirmed the grant', async () => {
    const { deps } = fakePoolDeps({ holders: [ASKING_DAEMON], confirmed: [] })
    const conn = fakeConn()
    await handleChannelAgents(frame({}), conn, deps)
    expect(conn.replyTo.mock.calls[0]![1]).toBe('channel/agents/ok')
    // PEER is confirmed elsewhere, so it is routable and listed; the requester always sees itself.
    expect(rosterNames(conn).sort()).toEqual([CALLER, PEER].sort())
  })

  it('still refuses a member that holds NOTHING for the requester', async () => {
    // The integrity control is unchanged: may-act widens the bind from confirmed holders to
    // holders, never to "any member of the set".
    const { deps } = fakePoolDeps({ holders: [OTHER_DAEMON], confirmed: [OTHER_DAEMON] })
    const conn = fakeConn()
    await handleChannelAgents(frame({}), conn, deps)
    expect(rosterNames(conn)).toEqual([])
  })
})
