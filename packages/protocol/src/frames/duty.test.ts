import { describe, expect, it } from 'vitest'
import {
  HeartbeatDuties,
  DutyGrant,
  DutyGrantEntry,
  DutyRenewed,
  DutyRevoke,
  DutyRelease,
  DutyClaim,
  DutyClaimOk,
  DutyFetch,
  DutyFetchOk
} from './duty.js'
import { Heartbeat } from './telemetry.js'
import { decodeEnvelope, encode, buildEnvelope } from '../index.js'

const GROUP = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const BOT = '33333333-3333-4333-8333-333333333333'

describe('HeartbeatDuties', () => {
  it('rides the heartbeat as an optional field — absent keeps old daemons parsing clean', () => {
    const base = { load: { cpu: 0.1, mem: 0.2, agents: 1 }, health: 'ok', activeSessions: 0 }
    expect(Heartbeat.parse(base).duties).toBeUndefined()

    const withDuties = Heartbeat.parse({
      ...base,
      duties: { held: [{ groupId: GROUP, term: '3' }], headroom: 2 }
    })
    expect(withDuties.duties?.held[0]?.term).toBe('3')
    expect(withDuties.duties?.headroom).toBe(2)
  })

  it('terms are decimal strings, never numbers', () => {
    expect(HeartbeatDuties.safeParse({ held: [{ groupId: GROUP, term: 3 }], headroom: 0 }).success).toBe(false)
    expect(HeartbeatDuties.safeParse({ held: [{ groupId: GROUP, term: '-1' }], headroom: 0 }).success).toBe(false)
    expect(HeartbeatDuties.safeParse({ held: [], headroom: 0 }).success).toBe(true)
  })
})

describe('duty frames', () => {
  it('duty/grant round-trips through the envelope codec', () => {
    const payload: DutyGrant = {
      grants: [
        {
          groupId: GROUP,
          orgId: 'org-1',
          term: '4',
          members: [
            { kind: 'agent', refId: AGENT },
            { kind: 'bot', refId: BOT }
          ]
        }
      ]
    }
    const decoded = decodeEnvelope(encode(buildEnvelope('duty/grant', payload)))
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
    expect(decoded.frame.type).toBe('duty/grant')
    expect(decoded.frame.payload).toEqual(payload)
  })

  it("an agent member may carry the CP's current configRevision — the freshness signal", () => {
    const stamped: DutyGrant = {
      grants: [
        {
          groupId: GROUP,
          orgId: 'org-1',
          term: '4',
          members: [
            { kind: 'agent', refId: AGENT, configRevision: '12' },
            { kind: 'bot', refId: BOT }
          ]
        }
      ]
    }
    const decoded = decodeEnvelope(encode(buildEnvelope('duty/grant', stamped)))
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
    expect(decoded.frame.payload).toEqual(stamped)
    // Optional (an older CP omits it) but never a free-form string: it is compared
    // as a bigint against the applied revision.
    expect(DutyGrantEntry.safeParse({ ...stamped.grants[0], members: [{ kind: 'agent', refId: AGENT }] }).success).toBe(
      true
    )
    expect(
      DutyGrantEntry.safeParse({
        ...stamped.grants[0],
        members: [{ kind: 'agent', refId: AGENT, configRevision: 'v12' }]
      }).success
    ).toBe(false)
  })

  it('duty/revoke carries only the closed reason vocabulary', () => {
    expect(DutyRevoke.safeParse({ revocations: [{ groupId: GROUP, reason: 'superseded' }] }).success).toBe(true)
    expect(DutyRevoke.safeParse({ revocations: [{ groupId: GROUP, reason: 'evicted' }] }).success).toBe(false)
    expect(DutyRevoke.safeParse({ revocations: [] }).success).toBe(false)
  })

  it('duty/renewed carries a RELATIVE horizon and round-trips through the codec', () => {
    const decoded = decodeEnvelope(encode(buildEnvelope('duty/renewed', { leaseMs: 120_000 })))
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
    expect(decoded.frame.payload).toEqual({ leaseMs: 120_000 })
    // A duration, so the member measures from receipt on its own clock — never a shared wall clock,
    // and never zero or negative, which would make a fence deadline meaningless.
    expect(DutyRenewed.safeParse({ leaseMs: 0 }).success).toBe(false)
    expect(DutyRenewed.safeParse({ leaseMs: -1 }).success).toBe(false)
    expect(DutyRenewed.safeParse({ renewedAt: '2026-08-14T00:00:00.000Z' }).success).toBe(false)
  })

  it('duty/release requires at least one group', () => {
    expect(DutyRelease.safeParse({ groupIds: [GROUP] }).success).toBe(true)
    expect(DutyRelease.safeParse({ groupIds: [] }).success).toBe(false)
  })
})

describe('duty/claim — the activation rendezvous', () => {
  it('the claim names only the agent; the CP resolves its org', () => {
    expect(DutyClaim.safeParse({ agentId: AGENT }).success).toBe(true)
    expect(DutyClaim.safeParse({ agentId: AGENT, orgId: 'org-1' }).success).toBe(true)
    expect(DutyClaim.safeParse({}).success).toBe(false)
  })

  it('a won claim carries the grant to install verbatim', () => {
    const ok = DutyClaimOk.parse({
      granted: true,
      grant: { groupId: GROUP, orgId: 'org-1', term: '1', members: [{ kind: 'agent', refId: AGENT }] }
    })
    expect(ok.grant?.term).toBe('1')
    expect(ok.holder).toBeUndefined()
  })

  it('a lost claim names the incumbent, and may name nobody', () => {
    expect(DutyClaimOk.parse({ granted: false, holder: BOT }).holder).toBe(BOT)
    expect(DutyClaimOk.parse({ granted: false }).holder).toBeUndefined()
  })
})

const INTEGRATION = '44444444-4444-4444-8444-444444444444'
const CRON = '55555555-5555-4555-8555-555555555555'

describe('duty/fetch — installing an agent a duty was won for', () => {
  it('the request names only the agent; the CP resolves everything else', () => {
    expect(DutyFetch.safeParse({ agentId: AGENT }).success).toBe(true)
    expect(DutyFetch.safeParse({}).success).toBe(false)
    expect(DutyFetch.safeParse({ agentId: 'not-a-uuid' }).success).toBe(false)
  })

  it('duty/fetch round-trips through the envelope codec', () => {
    const payload = { agentId: AGENT }
    const decoded = decodeEnvelope(encode(buildEnvelope('duty/fetch', payload)))
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
    expect(decoded.frame.type).toBe('duty/fetch')
    expect(decoded.frame.payload).toEqual(payload)
  })

  it('an empty reply is the "you do not hold it, or it is gone" answer', () => {
    expect(DutyFetchOk.parse({}).bundle).toBeUndefined()
    const decoded = decodeEnvelope(encode(buildEnvelope('duty/fetch/ok', {})))
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
    expect(decoded.frame.payload).toEqual({})
  })

  it('the bundle carries the same spec/integrations/crons trio as an activation', () => {
    // Input shape: AgentSpec's list fields default on parse, so this is z.input, not z.output.
    const payload = {
      bundle: {
        agentId: AGENT,
        spec: { orgId: 'org-1', name: 'scout', runtime: 'claude' },
        integrations: [
          {
            integrationId: INTEGRATION,
            agentId: AGENT,
            platform: 'slack',
            core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
            config: { botToken: 'xoxb-test' }
          }
        ],
        crons: [
          {
            cronId: CRON,
            agentId: AGENT,
            schedule: '0 9 * * *',
            timezone: 'UTC',
            trigger: 'daily standup',
            enabled: true
          }
        ]
      }
    }
    const decoded = decodeEnvelope(encode(buildEnvelope('duty/fetch/ok', payload)))
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
    expect(decoded.frame.type).toBe('duty/fetch/ok')
    // toMatchObject, not toEqual: AgentSpec's zod defaults materialize on decode.
    expect(decoded.frame.payload).toMatchObject(payload)
  })
})
