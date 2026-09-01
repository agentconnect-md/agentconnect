import { describe, expect, it } from 'vitest'
import { buildEnvelope, decodeEnvelope } from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'

describe('agent/approval-route frames', () => {
  it('round-trips the route form and its reply', () => {
    const route = buildEnvelope(
      'agent/approval-route',
      {
        agentId: AGENT_ID,
        requestId: REQUEST_ID,
        sessionId: 'sess-1',
        requesterId: 'U0TURNOWNER',
        integrationIds: [INTEGRATION_ID]
      },
      { orgId: 'org-a' }
    )
    const decoded = decodeEnvelope(JSON.stringify(route))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.frame.type).toBe('agent/approval-route')

    const routed = buildEnvelope(
      'agent/approval-routed',
      {
        requestId: REQUEST_ID,
        target: {
          integrationId: INTEGRATION_ID,
          teamId: 'T0WORKSPACE',
          userId: 'U0EDITOR',
          consoleUserId: 'user-1',
          displayName: 'Editor'
        }
      },
      { corr: route.id, orgId: 'org-a' }
    )
    expect(decodeEnvelope(JSON.stringify(routed)).ok).toBe(true)
  })

  it('round-trips the verify form, a no-target reply, and a refusal', () => {
    const verify = buildEnvelope(
      'agent/approval-route',
      {
        agentId: AGENT_ID,
        requestId: REQUEST_ID,
        integrationIds: [INTEGRATION_ID],
        verify: { integrationId: INTEGRATION_ID, teamId: 'T0WORKSPACE', userId: 'U0EDITOR', consoleUserId: 'user-1' }
      },
      { orgId: 'org-a' }
    )
    expect(decodeEnvelope(JSON.stringify(verify)).ok).toBe(true)
    for (const payload of [
      { requestId: REQUEST_ID },
      { requestId: REQUEST_ID, allowed: false },
      { requestId: REQUEST_ID, allowed: true, displayName: 'Editor' }
    ]) {
      const rep = buildEnvelope('agent/approval-routed', payload, { corr: verify.id, orgId: 'org-a' })
      expect(decodeEnvelope(JSON.stringify(rep)).ok).toBe(true)
    }
  })

  it('rejects an empty integration list', () => {
    const bad = buildEnvelope(
      'agent/approval-route',
      { agentId: AGENT_ID, requestId: REQUEST_ID, integrationIds: [] },
      { orgId: 'org-a' }
    )
    expect(decodeEnvelope(JSON.stringify(bad)).ok).toBe(false)
  })
})
