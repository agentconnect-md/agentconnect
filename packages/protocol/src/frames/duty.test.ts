import { describe, expect, it } from 'vitest'
import { HeartbeatDuties, DutyGrant, DutyRevoke, DutyRelease } from './duty.js'
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

  it('duty/revoke carries only the closed reason vocabulary', () => {
    expect(DutyRevoke.safeParse({ revocations: [{ groupId: GROUP, reason: 'superseded' }] }).success).toBe(true)
    expect(DutyRevoke.safeParse({ revocations: [{ groupId: GROUP, reason: 'evicted' }] }).success).toBe(false)
    expect(DutyRevoke.safeParse({ revocations: [] }).success).toBe(false)
  })

  it('duty/release requires at least one group', () => {
    expect(DutyRelease.safeParse({ groupIds: [GROUP] }).success).toBe(true)
    expect(DutyRelease.safeParse({ groupIds: [] }).success).toBe(false)
  })
})
