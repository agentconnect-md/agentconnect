// The draining predicate of the duty lease exchange (frames/duty.ts `draining`): a member that
// declared it claims nothing — no vacancy grant, no rendezvous home, no re-issue of a group it
// stopped reporting — until it registers afresh. Pure, over a fake repo: the SQL half of the
// predicate lives in the repo tests; this pins what the service does with the bit.
import { describe, it, expect, vi } from 'vitest'
import { DutyLeaseService, DUTY_LEASE_DEFAULTS } from './dutyLease.js'
import type {
  AgentHomeClaim,
  CapabilityBlockedVacancy,
  DutyGrantRecord,
  DutyGroupRecord,
  DutyGroupRepo
} from '../persistence/ports.js'
import { AgentId, DaemonId, OrgId } from '../domain/ids.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const ORG = OrgId('org-1')
const MEMBER = DaemonId('d1111111-1111-4111-8111-111111111111')
const AGENT = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
const GROUP = '00000000-0000-4000-8000-000000000001'

/** A ledger with one vacant group covering one agent, and every claim path instrumented. */
function fakeRepo(
  opts: {
    heldByMember?: DutyGroupRecord[]
    heldBack?: (holder: string) => boolean
    capabilityBlocked?: CapabilityBlockedVacancy[]
  } = {}
) {
  const vacant: DutyGrantRecord = {
    groupId: GROUP,
    orgId: ORG,
    term: 1n,
    members: [{ kind: 'agent', refId: AGENT }]
  }
  const claimVacant = vi.fn(async (): Promise<DutyGrantRecord[]> => [vacant])
  const claimAgentHome = vi.fn(async (): Promise<AgentHomeClaim> => ({
    granted: true,
    groupId: GROUP,
    term: 1n,
    holder: MEMBER
  }))
  const release = vi.fn(async () => undefined)
  const newerGenerationLive = vi.fn(async (holder: string) => opts.heldBack?.(holder) ?? false)
  const capabilityBlockedVacancies = vi.fn(
    async (): Promise<CapabilityBlockedVacancy[]> => opts.capabilityBlocked ?? []
  )
  const repo = {
    newerGenerationLive,
    capabilityBlockedVacancies,
    renewHeld: async () => [],
    listHeldBy: async () => opts.heldByMember ?? [],
    confirmHeld: async () => [],
    getByIds: async (ids: string[]) =>
      ids.includes(GROUP)
        ? [{ groupId: GROUP, orgId: ORG, holder: MEMBER, term: 1n, expiresAt: null, members: vacant.members }]
        : [],
    claimVacant,
    claimAgentHome,
    release
  } as unknown as DutyGroupRepo
  return { repo, claimVacant, claimAgentHome, release, newerGenerationLive, capabilityBlockedVacancies }
}

function service(repo: DutyGroupRepo, clock = new FakeClock(0), warn = vi.fn()) {
  return new DutyLeaseService(repo, clock, { ...DUTY_LEASE_DEFAULTS, recoveryGraceMs: 0 }, { warn })
}

/** One beat, fully settled: the lane frees a tick after the exchange resolves, and a beat that
 *  arrives while it is still busy is dropped by design. */
async function beat(
  svc: DutyLeaseService,
  member: DaemonId,
  duties: Parameters<DutyLeaseService['onHeartbeat']>[1],
  send = vi.fn()
) {
  await svc.onHeartbeat(member, duties, send)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return send
}

describe('DutyLeaseService — draining members', () => {
  it('a beat with draining:true is granted no vacancy even with headroom', async () => {
    const { repo, claimVacant } = fakeRepo()
    const svc = service(repo)
    const send = vi.fn()

    await beat(svc, MEMBER, { held: [], headroom: 4, draining: true }, send)

    expect(claimVacant).not.toHaveBeenCalled()
    expect(send.mock.calls.map(([type]) => type)).toEqual(['duty/renewed'])
    expect(svc.isDraining(MEMBER)).toBe(true)
  })

  it('the bit is sticky: a later beat without it still claims nothing, and the rendezvous refuses', async () => {
    const { repo, claimVacant, claimAgentHome } = fakeRepo()
    const svc = service(repo)

    await beat(svc, MEMBER, { held: [], headroom: 4, draining: true })
    await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(claimVacant).not.toHaveBeenCalled()

    expect(await svc.claimAgentHome(ORG, AGENT, MEMBER)).toEqual({ granted: false })
    expect(claimAgentHome).not.toHaveBeenCalled()
  })

  it('a held group missing from a draining digest is not re-issued — it is on its way out', async () => {
    const held: DutyGroupRecord = {
      groupId: GROUP,
      orgId: ORG,
      holder: MEMBER,
      term: 3n,
      expiresAt: null,
      members: [{ kind: 'agent', refId: AGENT }]
    }
    const { repo, release } = fakeRepo({ heldByMember: [held] })
    const svc = service(repo)
    const send = vi.fn()

    await beat(svc, MEMBER, { held: [], headroom: 0, draining: true }, send)

    expect(send.mock.calls.map(([type]) => type)).toEqual(['duty/renewed'])
    // Not vacated by the CP either: the member's own `duty/release` (or the refusal count) does that.
    expect(release).not.toHaveBeenCalled()
  })

  it('a fresh registration clears the bit; the member claims again unless it re-declares', async () => {
    const { repo, claimVacant, claimAgentHome } = fakeRepo()
    const svc = service(repo)
    await beat(svc, MEMBER, { held: [], headroom: 4, draining: true })

    svc.onRegister(MEMBER)
    expect(svc.isDraining(MEMBER)).toBe(false)

    await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(claimVacant).toHaveBeenCalledTimes(1)
    const claim = await svc.claimAgentHome(ORG, AGENT, MEMBER)
    expect(claim.granted).toBe(true)
    expect(claimAgentHome).toHaveBeenCalledTimes(1)
  })

  it('a member that is not draining claims as before', async () => {
    const { repo, claimVacant } = fakeRepo()
    const svc = service(repo)
    const send = vi.fn()

    await beat(svc, MEMBER, { held: [], headroom: 4 }, send)

    expect(claimVacant).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.map(([type]) => type)).toEqual(['duty/grant', 'duty/renewed'])
  })
})

describe('DutyLeaseService — the rollout barrier', () => {
  it('a member of an older generation is granted no vacancy and no home while a newer live peer exists', async () => {
    const warn = vi.fn()
    const { repo, claimVacant, claimAgentHome, newerGenerationLive } = fakeRepo({ heldBack: (h) => h === MEMBER })
    const svc = service(repo, new FakeClock(0), warn)

    const send = await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(claimVacant).not.toHaveBeenCalled()
    // Renewal still confirmed: it keeps serving what it holds.
    expect(send.mock.calls.map(([type]) => type)).toEqual(['duty/renewed'])
    expect(await svc.claimAgentHome(ORG, AGENT, MEMBER)).toEqual({ granted: false })
    expect(claimAgentHome).not.toHaveBeenCalled()
    // Logged once, not per beat.
    await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(warn.mock.calls.filter(([, m]) => /older generation/.test(String(m)))).toHaveLength(1)
    // The predicate is read against the lease horizon — the ledger's one notion of "live".
    expect(newerGenerationLive).toHaveBeenCalledWith(MEMBER, expect.any(Date), DUTY_LEASE_DEFAULTS.leaseMs)
  })

  it('a member the repo does not hold back claims as before, and one released from the barrier resumes', async () => {
    let heldBack = true
    const { repo, claimVacant } = fakeRepo({ heldBack: () => heldBack })
    const svc = service(repo)
    await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(claimVacant).not.toHaveBeenCalled()
    heldBack = false
    await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(claimVacant).toHaveBeenCalledTimes(1)
  })
})

describe('DutyLeaseService — the double-move line', () => {
  it('warns when a group is granted at a new term twice inside the window, and not for a re-claim at the same term', async () => {
    const { repo, claimVacant, claimAgentHome } = fakeRepo()
    const clock = new FakeClock(0)
    const warn = vi.fn()
    const svc = service(repo, clock, warn)
    const other = DaemonId('d2222222-2222-4222-8222-222222222222')

    // First move: term 1 to MEMBER.
    await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(warn).not.toHaveBeenCalled()
    // Second move one minute later: term 2 to another member.
    claimVacant.mockResolvedValueOnce([
      { groupId: GROUP, orgId: ORG, term: 2n, members: [{ kind: 'agent', refId: AGENT }] }
    ])
    clock.advance(60_000)
    await beat(svc, other, { held: [], headroom: 4 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatch(/moved more than once/)
    // The incumbent re-claiming its own home at the same term is not a move.
    warn.mockClear()
    claimAgentHome.mockResolvedValueOnce({ granted: true, groupId: GROUP, term: 2n, holder: other })
    await svc.claimAgentHome(ORG, AGENT, other)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('DutyLeaseService — the capability-gap line', () => {
  // A capability refusal is silent on the wire: the claim statement simply matches fewer rows, so
  // an agent stops placing mid-rollout with nothing anywhere naming the platform that is missing.
  it('names every passed-over agent and the platforms the member lacks, once per pass', async () => {
    const warn = vi.fn()
    const { repo, capabilityBlockedVacancies } = fakeRepo({
      capabilityBlocked: [{ groupId: GROUP, agentId: AGENT, missingPlatforms: ['linear'] }]
    })
    const svc = service(repo, new FakeClock(0), warn)

    await beat(svc, MEMBER, { held: [], headroom: 4 })
    const lines = warn.mock.calls.filter(([, m]) => /advertises no module/.test(String(m)))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[0]).toMatchObject({ daemonId: MEMBER, agentId: AGENT, missingPlatforms: ['linear'] })
    // Read under the same deliverability cap the claim carries, so it can only report what claim saw.
    expect(capabilityBlockedVacancies).toHaveBeenCalledWith(
      MEMBER,
      expect.any(Date),
      expect.objectContaining({ maxMembers: expect.any(Number) })
    )
  })

  // The diagnostic costs a read, so it must not run on a claim that already spent its whole budget.
  it('is not read when the claim filled the budget it asked for', async () => {
    const { repo, capabilityBlockedVacancies } = fakeRepo()
    const svc = service(repo)
    await beat(svc, MEMBER, { held: [], headroom: 1 })
    expect(capabilityBlockedVacancies).not.toHaveBeenCalled()
  })

  // Diagnostics for a claim that already happened: a failure here must never fail the exchange.
  it('a failing diagnostic read still lets the beat confirm renewal', async () => {
    const warn = vi.fn()
    const { repo, capabilityBlockedVacancies } = fakeRepo()
    capabilityBlockedVacancies.mockRejectedValueOnce(new Error('connection terminated'))
    const svc = service(repo, new FakeClock(0), warn)

    const send = await beat(svc, MEMBER, { held: [], headroom: 4 })
    expect(send.mock.calls.map(([type]) => type)).toContain('duty/renewed')
    expect(warn.mock.calls.filter(([, m]) => /diagnostics failed/.test(String(m)))).toHaveLength(1)
  })
})
