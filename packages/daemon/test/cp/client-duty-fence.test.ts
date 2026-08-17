// The timing half of the duty self-fence (`T_reassign > T_fence`): when the daemon arms it,
// what it anchors the deadline on, and — just as load-bearing — when it must NOT fire.
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const GROUP = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '11111111-1111-4111-8111-111111111112'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
// The install-wide pool, as `auth/ok` announces it — membership is what puts this daemon in the
// duty ledger at all (daemon-groups.md §3), so a lease can only exist while it carries one.
const POOL_SET = { setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }
const LEASE_MS = 120_000
// The shipped fence: 3/4 of the horizon past the last heartbeat that carried duties.
const FENCE_MS = 90_000
const BEAT_MS = 15_000

const tick = () => new Promise((r) => setImmediate(r))

/** A CP that can be taken away: `up = false` makes every dial fail, like a partition. */
class Link {
  readonly transports: FakeTransport[] = []
  up = true
  connect = async (): Promise<FakeTransport> => {
    if (!this.up) throw new Error('control plane unreachable')
    const t = new FakeTransport()
    this.transports.push(t)
    return t
  }
  get current(): FakeTransport {
    return this.transports[this.transports.length - 1]!
  }
}

async function handshake(t: FakeTransport, epoch: number, dutyLeaseMs?: number): Promise<void> {
  const auth = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        {
          daemonId: DAEMON_ID,
          sessionEpoch: epoch,
          heartbeatSec: BEAT_MS / 1000,
          ...(dutyLeaseMs !== undefined ? { dutyLeaseMs } : {}),
          serverTime: '2026-08-14T00:00:00.000Z',
          organizationMode: 'frame',
          memberSet: POOL_SET
        },
        { corr: auth.id }
      )
    )
  )
  await tick()
  const reg = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'register/ok',
        {
          routingEpoch: 1,
          serverFeatures: [],
          assignments: [],
          crons: [],
          leases: [],
          drop: { assignments: [], crons: [] }
        },
        { corr: reg.id }
      )
    )
  )
  await tick()
}

interface Options {
  /** Answer `auth/ok` without the horizon field, the way a CP older than it does. */
  noHorizon?: boolean
  /** Omit the duty getter (or scope the connection to one org) — then no lease can exist. */
  duties?: boolean
  organizationMode?: 'connection' | 'frame'
  /** The set the re-handshake announces. Membership — NOT the org mode — is what puts a connection
   *  in the ledger, so an org-scoped member reports duties exactly as a pool member does. */
  memberSet?: { setId: string; name: string }
  /** The groups the daemon holds; the digest projects these and a renewal refreshes exactly them. */
  held?: string[]
}

async function ready(opts: Options = {}) {
  const link = new Link()
  const clock = new FakeClock()
  const onDutyFence = vi.fn()
  const warn = vi.fn()
  // The daemon's authoritative held set, which the digest projects and a renewal refreshes.
  const held: string[] = [...(opts.held ?? [GROUP])]
  // Admissions in flight: intended to be held, deliberately absent from the digest until applied.
  const pending: string[] = []
  const deps = {
    url: 'wss://cp.example.test/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: BEAT_MS,
    maxAgents: 4,
    capabilities: () => ({ platforms: [], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    ...(opts.duties === false
      ? {}
      : {
          duties: () => ({ held: held.map((groupId) => ({ groupId, term: '7' })), headroom: 3 }),
          dutyPending: () => [...pending]
        }),
    onDutyFence,
    configApply: {
      applyConfigPush() {},
      applyReconcileSnapshot() {},
      applyDutyGrant() {},
      applyDutyRevoke() {},
      upsertCron() {},
      removeCron() {},
      applyRouteAssign() {},
      applyRouteUpdate() {}
    },
    clock,
    connect: link.connect,
    log: { trace() {}, debug() {}, info() {}, warn, error() {} },
    jitter: () => 0
  } as unknown as CpClientDeps
  const client = new CpClient(deps)
  client.start()
  await tick()
  await handshake(link.current, 1, opts.noHorizon ? undefined : LEASE_MS)
  if (opts.organizationMode === 'connection') {
    // Re-run the handshake as an org-scoped connection: the same client, and a duty exchange only
    // if this one announces a member set.
    link.current.simulateClose(1012, 'rescope')
    clock.advance(1000)
    await tick()
    const t = link.current
    const auth = t.lastSent()
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'auth/ok',
          {
            daemonId: DAEMON_ID,
            sessionEpoch: 2,
            heartbeatSec: BEAT_MS / 1000,
            dutyLeaseMs: LEASE_MS,
            serverTime: '2026-08-14T00:00:00.000Z',
            organizationMode: 'connection',
            ...(opts.memberSet ? { memberSet: opts.memberSet } : {})
          },
          { corr: auth.id }
        )
      )
    )
    await tick()
    const reg = t.lastSent()
    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'register/ok',
          {
            routingEpoch: 1,
            serverFeatures: [],
            assignments: [],
            crons: [],
            leases: [],
            drop: { assignments: [], crons: [] }
          },
          { corr: reg.id }
        )
      )
    )
    await tick()
  }
  return { client, link, clock, onDutyFence, warn, held, pending }
}

/** A `duty/grant` EVT for one group, as the CP emits it when it claims or re-terms a lease. */
function grant(t: FakeTransport, groupId: string): void {
  t.pushInbound(
    JSON.stringify(
      buildEnvelope('duty/grant', {
        grants: [{ groupId, orgId: 'org-1', term: '7', members: [{ kind: 'agent', refId: AGENT }] }]
      })
    )
  )
}

/** The groups each fence call shed, in call order. */
const fenced = (spy: { mock: { calls: unknown[][] } }): unknown[] => spy.mock.calls.map((call) => call[0])

/** Advance the clock, letting each step's async work settle. */
async function advance(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms)
  await tick()
}

const beats = (t: FakeTransport) => t.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === 'heartbeat')

/** The CP's answer to a beat it processed. Anchoring happens HERE, not on the send. */
function confirmRenewal(t: FakeTransport, leaseMs = LEASE_MS): void {
  t.pushInbound(JSON.stringify(buildEnvelope('duty/renewed', { leaseMs })))
}

/** One healthy round trip: the daemon beats, the CP renews and says so. */
async function renewedBeat(clock: FakeClock, t: FakeTransport, leaseMs = LEASE_MS): Promise<void> {
  await advance(clock, BEAT_MS)
  confirmRenewal(t, leaseMs)
  await tick()
}

describe('the duty self-fence deadline', () => {
  it('a control-plane restart moves no duty: the epoch bumps and nothing is fenced', async () => {
    // The #955 acceptance run. A restart reconnects well inside the horizon, so the fence
    // must stay quiet — a fence here would drop live platform connections for a blip.
    const { client, link, clock, onDutyFence } = await ready()
    await renewedBeat(clock, link.current)
    expect(beats(link.current).at(-1).payload.duties.held).toEqual([{ groupId: GROUP, term: '7' }])

    link.current.simulateClose(1012, 'restarting')
    expect(client.state).toBe('DEGRADED')
    await advance(clock, 1000)
    await handshake(link.current, 2, LEASE_MS)

    expect(client.state).toBe('READY')
    expect(client.sessionEpoch).toBe(2) // a fresh fencing token, as the restart mints
    // The reconnect beats at once, reporting the SAME terms it held before, and the CP confirms.
    expect(beats(link.current).at(-1).payload.duties.held).toEqual([{ groupId: GROUP, term: '7' }])
    confirmRenewal(link.current)
    await tick()

    // Keep the restarted CP running well past the deadline the outage had armed: a renewed
    // beat every cadence, so the countdown restarts long before it can expire.
    for (let i = 0; i < 10; i++) await renewedBeat(clock, link.current)
    expect(clock.now()).toBeGreaterThan(FENCE_MS)
    expect(onDutyFence).not.toHaveBeenCalled()
  })

  it('fires once the horizon elapses with the link down', async () => {
    const { link, clock, onDutyFence } = await ready()
    await renewedBeat(clock, link.current)
    link.up = false
    link.current.simulateClose(1006, 'gone')

    await advance(clock, FENCE_MS - 1)
    expect(onDutyFence).not.toHaveBeenCalled()

    await advance(clock, 1)
    expect(onDutyFence).toHaveBeenCalledTimes(1)

    // Reconnect attempts keep failing; the fence stays fired exactly once.
    await advance(clock, 10 * LEASE_MS)
    expect(onDutyFence).toHaveBeenCalledTimes(1)
  })

  it('fires on schedule on a HALF-OPEN socket, where every beat is sent and none arrives', async () => {
    // The failure the anchor exists for: `send()` succeeds locally, the CP never runs
    // `renewHeld`, and no close event ever fires. Sending is not renewing — the deadline set
    // by the last CONFIRMED renewal must not move a millisecond for the beats that follow.
    const { link, clock, onDutyFence } = await ready()
    await renewedBeat(clock, link.current) // last confirmed renewal, at t = 15s
    const sentByThen = beats(link.current).length

    // The socket stays "open" and the daemon keeps beating into it — unanswered.
    for (let i = 0; i < 5; i++) await advance(clock, BEAT_MS)
    expect(beats(link.current).length).toBeGreaterThan(sentByThen) // the sends really happened
    expect(onDutyFence).not.toHaveBeenCalled() // …and moved nothing: t = 90s, deadline 105s

    await advance(clock, FENCE_MS - 5 * BEAT_MS - 1)
    expect(onDutyFence).not.toHaveBeenCalled()
    await advance(clock, 1)
    expect(onDutyFence).toHaveBeenCalledTimes(1)
  })

  it('anchors on the confirmation, not on the disconnect', async () => {
    const { link, clock, onDutyFence } = await ready()
    await renewedBeat(clock, link.current) // renewal confirmed at t = 15s
    await advance(clock, BEAT_MS - 1) // …and the socket dies just before the next beat is due
    link.up = false
    link.current.simulateClose(1006, 'gone')

    // Measured from the disconnect the fence would still be a cadence away.
    await advance(clock, FENCE_MS - (BEAT_MS - 1))
    expect(onDutyFence).toHaveBeenCalledTimes(1)
  })

  it('never arms before a renewal this member can lose', async () => {
    // Beats go out from the first cadence, but nothing is confirmed, so no lease was ever
    // renewed here — there is no countdown to run and nothing for a successor to take.
    const { link, clock, onDutyFence } = await ready()
    await advance(clock, BEAT_MS)
    link.up = false
    link.current.simulateClose(1006, 'gone')

    await advance(clock, 10 * LEASE_MS)
    expect(onDutyFence).not.toHaveBeenCalled()
  })

  it('arms on a won rendezvous claim, which is this member’s first lease', async () => {
    // The claim CREATES a lease (`claimAgentHome` writes `expiresAt = now + leaseMs`) and the
    // member serves it immediately — often before any heartbeat has been confirmed, so without
    // this the rendezvous serves a lease with no countdown running at all.
    const { client, link, clock, onDutyFence } = await ready()
    const claim = client.claimDuty(AGENT)
    await tick()
    const req = link.current.sent.map((raw) => JSON.parse(raw)).find((f) => f.type === 'duty/claim')
    link.current.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'duty/claim/ok',
          { granted: true, grant: { groupId: GROUP, orgId: 'org-1', term: '1', members: [] } },
          { corr: req.id }
        )
      )
    )
    await expect(claim).resolves.toMatchObject({ granted: true })

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, FENCE_MS - 1)
    expect(onDutyFence).not.toHaveBeenCalled()
    await advance(clock, 1)
    expect(onDutyFence).toHaveBeenCalledTimes(1)
  })

  it('a LOST rendezvous claim arms nothing — no lease was created here', async () => {
    const { client, link, clock, onDutyFence } = await ready()
    const claim = client.claimDuty(AGENT)
    await tick()
    const req = link.current.sent.map((raw) => JSON.parse(raw)).find((f) => f.type === 'duty/claim')
    link.current.pushInbound(
      JSON.stringify(buildEnvelope('duty/claim/ok', { granted: false, holder: DAEMON_ID }, { corr: req.id }))
    )
    await expect(claim).resolves.toMatchObject({ granted: false })

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, 10 * LEASE_MS)
    expect(onDutyFence).not.toHaveBeenCalled()
  })

  it('a grant whose renewal confirmation never arrives still fences on time', async () => {
    // The grant's own receipt arms it. Nothing else can: this is the member's FIRST lease, so no
    // confirmation has ever been seen, and the one that would follow this grant is lost.
    const { link, clock, onDutyFence } = await ready()
    grant(link.current, GROUP)
    await tick()

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, FENCE_MS - 1)
    expect(onDutyFence).not.toHaveBeenCalled()
    await advance(clock, 1)
    expect(fenced(onDutyFence)).toEqual([[GROUP]])
  })

  it('a grant after a fence re-arms that group, rather than serving it undeadlined', async () => {
    const { link, clock, onDutyFence } = await ready()
    grant(link.current, GROUP)
    await tick()
    await advance(clock, FENCE_MS)
    expect(fenced(onDutyFence)).toEqual([[GROUP]])

    // The CP hands it back (its missing-regrant, or a fresh claim) — a new lease, a new deadline.
    grant(link.current, GROUP)
    await tick()
    await advance(clock, FENCE_MS - 1)
    expect(onDutyFence).toHaveBeenCalledTimes(1)
    await advance(clock, 1)
    expect(fenced(onDutyFence)).toEqual([[GROUP], [GROUP]])
  })

  it('a claim for another group does not postpone an older group’s deadline', async () => {
    // The one global deadline used to be reset by any lease event; group A's CP expiry never moved,
    // so a claim for B could carry A past it. Per-group deadlines make that unrepresentable.
    const { client, link, clock, onDutyFence } = await ready()
    grant(link.current, GROUP) // A, deadline at t = FENCE_MS
    await tick()
    await advance(clock, BEAT_MS * 2)

    const claim = client.claimDuty(AGENT)
    await tick()
    const req = link.current.sent.map((raw) => JSON.parse(raw)).find((f) => f.type === 'duty/claim')
    link.current.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'duty/claim/ok',
          { granted: true, grant: { groupId: GROUP_B, orgId: 'org-1', term: '1', members: [] } },
          { corr: req.id }
        )
      )
    )
    await expect(claim).resolves.toMatchObject({ granted: true })

    link.up = false
    link.current.simulateClose(1006, 'gone')
    // A fences at its own deadline, untouched by B's arrival…
    await advance(clock, FENCE_MS - BEAT_MS * 2)
    expect(fenced(onDutyFence)).toEqual([[GROUP]])
    // …and B, leased later, fences later — a partial fence, not a teardown of everything.
    await advance(clock, BEAT_MS * 2)
    expect(fenced(onDutyFence)).toEqual([[GROUP], [GROUP_B]])
  })

  it('fences only the expired group and re-arms at the next earliest', async () => {
    const { link, clock, onDutyFence } = await ready({ held: [GROUP, GROUP_B] })
    grant(link.current, GROUP) // deadline FENCE_MS
    await tick()
    await advance(clock, BEAT_MS)
    grant(link.current, GROUP_B) // deadline FENCE_MS + BEAT_MS
    await tick()

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, FENCE_MS - BEAT_MS)
    expect(fenced(onDutyFence)).toEqual([[GROUP]]) // B's lease is still honoured by the CP

    await advance(clock, BEAT_MS)
    expect(fenced(onDutyFence)).toEqual([[GROUP], [GROUP_B]])
  })

  it('one renewal refreshes every held group at once', async () => {
    const { link, clock, onDutyFence } = await ready({ held: [GROUP, GROUP_B] })
    grant(link.current, GROUP)
    await tick()
    await advance(clock, BEAT_MS)
    grant(link.current, GROUP_B)
    await tick()

    // `renewHeld` renews by holder with no id filter, so ONE confirmation restarts both countdowns.
    await advance(clock, BEAT_MS)
    confirmRenewal(link.current)
    await tick()
    const renewedAt = clock.now()

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, FENCE_MS - 1)
    expect(onDutyFence).not.toHaveBeenCalled() // neither group kept its older, earlier deadline
    await advance(clock, 1)
    expect(clock.now()).toBe(renewedAt + FENCE_MS)
    expect(fenced(onDutyFence)).toEqual([[GROUP, GROUP_B]]) // both, in one call, at one deadline
  })

  it('a revoked group stops holding a deadline of its own', async () => {
    const { link, clock, onDutyFence } = await ready({ held: [GROUP, GROUP_B] })
    grant(link.current, GROUP)
    await tick()
    await advance(clock, BEAT_MS)
    grant(link.current, GROUP_B)
    await tick()

    link.current.pushInbound(
      JSON.stringify(buildEnvelope('duty/revoke', { revocations: [{ groupId: GROUP, reason: 'superseded' }] }))
    )
    await tick()

    link.up = false
    link.current.simulateClose(1006, 'gone')
    // The revoked group's earlier deadline is gone with it; only B is left to fence, at its own time.
    await advance(clock, FENCE_MS)
    expect(fenced(onDutyFence)).toEqual([[GROUP_B]])
  })

  it('a confirmation arriving mid-admission keeps the pending group’s deadline', async () => {
    // A group being admitted is absent from the digest by design — it is not servable yet. Pruning
    // its deadline against the digest is what would leave it serving with no fence at all once the
    // admission commits, so "what we intend to hold" includes the admissions in flight.
    const { link, clock, onDutyFence, held, pending } = await ready({ held: [] })
    grant(link.current, GROUP)
    pending.push(GROUP) // admission in flight: marked by the daemon, not yet in the digest
    await tick()

    await advance(clock, BEAT_MS)
    confirmRenewal(link.current)
    await tick()

    // The admission commits: now it is held, and no longer pending.
    const renewedAt = clock.now()
    held.push(GROUP)
    pending.length = 0
    link.up = false
    link.current.simulateClose(1006, 'gone')

    // Its deadline survived the prune and moved with the renewal, so it still fences — on schedule.
    await advance(clock, FENCE_MS - 1)
    expect(onDutyFence).not.toHaveBeenCalled()
    await advance(clock, 1)
    expect(clock.now()).toBe(renewedAt + FENCE_MS)
    expect(fenced(onDutyFence)).toEqual([[GROUP]])
  })

  it('a confirmation still prunes a group that is neither held nor being admitted', async () => {
    const { link, clock, onDutyFence, held } = await ready({ held: [GROUP] })
    grant(link.current, GROUP_B) // never admitted, never held — a refused group
    await tick()

    await advance(clock, BEAT_MS)
    confirmRenewal(link.current)
    await tick()

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, FENCE_MS)
    expect(fenced(onDutyFence)).toEqual([[GROUP]]) // B's stale deadline is gone
    expect(held).toEqual([GROUP])
  })

  it('never arms for a daemon that renews no lease', async () => {
    const { link, clock, onDutyFence } = await ready({ duties: false })
    await advance(clock, BEAT_MS)
    expect(beats(link.current).at(-1).payload).not.toHaveProperty('duties')

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, 10 * LEASE_MS)
    expect(onDutyFence).not.toHaveBeenCalled()
  })

  it('never arms for a connection in NO member set, where the ledger stays dormant', async () => {
    const { link, clock, onDutyFence } = await ready({ organizationMode: 'connection' })
    await advance(clock, BEAT_MS)
    expect(beats(link.current).at(-1).payload).not.toHaveProperty('duties')

    link.up = false
    link.current.simulateClose(1006, 'gone')
    await advance(clock, 10 * LEASE_MS)
    expect(onDutyFence).not.toHaveBeenCalled()
  })

  it('reports duties for an ORG-SCOPED member — membership decides, not the org mode', async () => {
    // The regression this pins: duty reporting used to be gated on `organizationMode === 'frame'`,
    // which was the same answer only while the install-wide pool was the one set that existed. An
    // org's own group member authenticates in `connection` mode, so it went duty-gated and silent
    // — it refused to serve what it held no lease for while never asking the CP for one.
    const orgGroup = { setId: '9f11e5e7-0000-4000-8000-000000000002', name: 'edge' }
    const { link, clock } = await ready({ organizationMode: 'connection', memberSet: orgGroup })
    await advance(clock, BEAT_MS)
    expect(beats(link.current).at(-1).payload).toHaveProperty('duties')
  })

  it('adopts each renewal horizon the CP announces', async () => {
    const { link, clock, onDutyFence } = await ready()
    await renewedBeat(clock, link.current, 40_000) // this CP now leases for 40s
    link.up = false
    link.current.simulateClose(1006, 'gone')

    await advance(clock, 30_000 - 1) // 3/4 of 40s
    expect(onDutyFence).not.toHaveBeenCalled()
    await advance(clock, 1)
    expect(onDutyFence).toHaveBeenCalledTimes(1)
  })

  it('falls back to the built-in horizon and the weaker send anchor when the CP confirms nothing', async () => {
    const { link, clock, onDutyFence, warn } = await ready({ noHorizon: true })
    // A CP too old to announce a horizon is too old to confirm renewals. Anchoring on sends is
    // strictly weaker, and saying so is the point — silently not fencing would be worse.
    expect(warn.mock.calls.flat().join(' ')).toContain('no duty lease horizon')

    await advance(clock, BEAT_MS)
    link.up = false
    link.current.simulateClose(1006, 'gone')

    await advance(clock, FENCE_MS - 1)
    expect(onDutyFence).not.toHaveBeenCalled()
    await advance(clock, 1)
    expect(onDutyFence).toHaveBeenCalledTimes(1)
  })

  it('fences a daemon whose credential died, which can never renew either', async () => {
    const { link, clock, onDutyFence } = await ready()
    await renewedBeat(clock, link.current)
    link.current.simulateClose(4401, 'AUTH_FAILED')

    await advance(clock, FENCE_MS)
    expect(onDutyFence).toHaveBeenCalledTimes(1)
  })

  it('a local shutdown does not fence — the daemon is leaving, not being replaced', async () => {
    const { client, link, clock, onDutyFence } = await ready()
    await renewedBeat(clock, link.current)

    await client.stop()
    link.up = false
    await advance(clock, 10 * LEASE_MS)
    expect(onDutyFence).not.toHaveBeenCalled()
  })
})
