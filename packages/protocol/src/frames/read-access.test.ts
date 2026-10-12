import { describe, expect, it } from 'vitest'
import { buildEnvelope, CronUpsert, decodeEnvelope, READ_ACCESS_V1_FEATURE } from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'

describe('agent/read-access frames', () => {
  it('round-trips a console asker, a chat member asker and every reply state', () => {
    for (const asker of [{ consoleUserId: 'user-1' }, { integrationId: INTEGRATION_ID, memberId: 'U0MEMBER' }]) {
      const req = buildEnvelope(
        'agent/read-access',
        { agentId: AGENT_ID, asker, sessionIds: ['ses-1'], ownerOnly: true },
        { orgId: 'org-a' }
      )
      const decoded = decodeEnvelope(JSON.stringify(req))
      expect(decoded.ok && decoded.frame.type).toBe('agent/read-access')
      expect(decoded.ok && (decoded.frame.payload as { ownerOnly?: boolean }).ownerOnly).toBe(true)
    }
    for (const asker of ['linked', 'unlinked', 'unidentifiable'] as const) {
      const rep = buildEnvelope(
        'agent/read-access/ok',
        { asker, visibleSessionIds: asker === 'linked' ? ['ses-1'] : [] },
        { orgId: 'org-a' }
      )
      expect(decodeEnvelope(JSON.stringify(rep)).ok).toBe(true)
    }
    const linked = buildEnvelope(
      'agent/read-access/ok',
      { asker: 'linked', visibleSessionIds: [], consoleUserId: 'user-1' },
      { orgId: 'org-a' }
    )
    const decoded = decodeEnvelope(JSON.stringify(linked))
    expect(decoded.ok && (decoded.frame.payload as { consoleUserId?: string }).consoleUserId).toBe('user-1')
    expect(READ_ACCESS_V1_FEATURE).toBe('read-access-v1')
  })

  it('rejects an asker that names neither form, too many sessions and an unknown state', () => {
    const bad = [
      buildEnvelope('agent/read-access', { agentId: AGENT_ID, asker: {}, sessionIds: [] } as never, { orgId: 'org-a' }),
      buildEnvelope(
        'agent/read-access',
        { agentId: AGENT_ID, asker: { consoleUserId: 'u' }, sessionIds: Array.from({ length: 9 }, (_, i) => `s${i}`) },
        { orgId: 'org-a' }
      ),
      buildEnvelope('agent/read-access/ok', { asker: 'maybe', visibleSessionIds: [] } as never, { orgId: 'org-a' })
    ]
    for (const frame of bad) expect(decodeEnvelope(JSON.stringify(frame)).ok).toBe(false)
  })

  it('carries the person a schedule reads as, and stays optional', () => {
    const base = { cronId: AGENT_ID, agentId: AGENT_ID, schedule: '0 9 * * 1-5', timezone: 'UTC', trigger: 'x' }
    expect(CronUpsert.parse(base).askerUserId).toBeUndefined()
    expect(CronUpsert.parse({ ...base, askerUserId: 'user-1' }).askerUserId).toBe('user-1')
  })
})
