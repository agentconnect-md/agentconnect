// Connect with Microsoft primitives (azure-devops-integration.md §3.2): the state, the ticket, consent classification, and the entitlement answer.
import { describe, it, expect } from 'vitest'
import type { Clock } from '../domain/clock.js'
import { AzureDevOpsApiClient } from './api.js'
import { addServicePrincipalEntitlement, raiseServicePrincipalToBasic, reachesRepositories } from './admin-api.js'
import {
  FLOW_TICKET_TTL_MS,
  azureDevOpsConnectKeys,
  flowTicketExpiry,
  isConsentError,
  mintAzureDevOpsConnectState,
  openAzureDevOpsFlowTicket,
  sealAzureDevOpsFlowTicket,
  verifyAzureDevOpsConnectState
} from './connect.js'

const keys = azureDevOpsConnectKeys('example-pepper-example-pepper-example-pepper')
const clockAt = (ms: number): Clock => ({ now: () => ms, setTimeout: () => 0 as never, clearTimeout: () => {} })
const TENANT = '00000000-0000-4000-8000-0000000000a1'

describe('the signed state', () => {
  it('round-trips, and refuses another key, a changed payload, or expiry', () => {
    const state = mintAzureDevOpsConnectState(keys, { orgId: 'org', userId: 'user', tenantId: TENANT }, clockAt(1000))
    expect(verifyAzureDevOpsConnectState(keys, state, clockAt(1000))).toEqual({
      orgId: 'org',
      userId: 'user',
      tenantId: TENANT
    })
    expect(verifyAzureDevOpsConnectState(azureDevOpsConnectKeys('another-pepper'), state, clockAt(1000))).toBeNull()
    expect(verifyAzureDevOpsConnectState(keys, `x${state}`, clockAt(1000))).toBeNull()
    expect(verifyAzureDevOpsConnectState(keys, state, clockAt(1000 + 10 * 60_000))).toBeNull()
  })
})

describe('the flow ticket', () => {
  it('is sealed, and expires at thirty minutes or before the token does', () => {
    expect(flowTicketExpiry(clockAt(0), 3600)).toBe(FLOW_TICKET_TTL_MS)
    expect(flowTicketExpiry(clockAt(0), 600)).toBe(540_000)
    const ticket = {
      flowId: 'flow',
      orgId: 'org',
      userId: 'user',
      tenantId: TENANT,
      accessToken: 'example-delegated-token',
      expiresAt: 5000
    }
    const sealed = sealAzureDevOpsFlowTicket(keys, ticket)
    expect(sealed).not.toContain('example-delegated-token')
    expect(openAzureDevOpsFlowTicket(keys, sealed, clockAt(4999))).toEqual(ticket)
    expect(openAzureDevOpsFlowTicket(keys, sealed, clockAt(5000))).toBeNull()
    expect(openAzureDevOpsFlowTicket(azureDevOpsConnectKeys('another-pepper'), sealed, clockAt(0))).toBeNull()
  })
})

describe('consent errors', () => {
  it('reads consent_required, access_denied, and the AADSTS codes as missing consent', () => {
    expect(isConsentError('consent_required')).toBe(true)
    expect(isConsentError('access_denied')).toBe(true)
    expect(isConsentError('invalid_grant', 'AADSTS65001: not consented')).toBe(true)
    expect(isConsentError('invalid_grant', undefined, [90094])).toBe(true)
    expect(isConsentError('invalid_request', 'AADSTS50011: redirect mismatch', [50011])).toBe(false)
  })
})

describe('the entitlement answer', () => {
  const answering = (body: unknown) =>
    new AzureDevOpsApiClient({ fetch: async () => new Response(JSON.stringify(body), { status: 200 }) })

  it('reads isSuccess and the errors, not the status code', async () => {
    const refused = await addServicePrincipalEntitlement(
      answering({
        isSuccess: false,
        operationResult: { isSuccess: false, errors: [{ key: 5032, value: 'Add Users' }] }
      }),
      'token',
      'example-org',
      'oid'
    )
    expect(refused).toEqual({ outcome: 'refused', errorCodes: [5032], subjectDescriptor: null })
    const stakeholder = await addServicePrincipalEntitlement(
      answering({
        operationResult: { isSuccess: true, result: { accessLevel: { accountLicenseType: 'stakeholder' } } }
      }),
      'token',
      'example-org',
      'oid'
    )
    expect(stakeholder.outcome).toBe('refused')
    const added = await addServicePrincipalEntitlement(
      answering({
        operationResult: {
          isSuccess: true,
          result: { accessLevel: { accountLicenseType: 'express' }, servicePrincipal: { descriptor: 'aadsp.example' } }
        }
      }),
      'token',
      'example-org',
      'oid'
    )
    expect(added).toEqual({ outcome: 'added', subjectDescriptor: 'aadsp.example' })
  })

  it('counts Basic and every level above it as enough, and only Stakeholder or none as not', () => {
    for (const level of ['express', 'advanced', 'professional', 'earlyAdopter']) {
      expect(reachesRepositories(level)).toBe(true)
    }
    for (const level of ['stakeholder', 'none', null, undefined, '']) expect(reachesRepositories(level)).toBe(false)
  })

  it('reads the patch answer’s operationResults', async () => {
    const refused = await raiseServicePrincipalToBasic(
      answering({
        isSuccess: false,
        operationResults: [{ isSuccess: false, errors: [{ key: 5032, value: 'Add Users' }] }]
      }),
      'token',
      'example-org',
      'id'
    )
    expect(refused).toEqual({ outcome: 'refused', errorCodes: [5032] })
    const raised = await raiseServicePrincipalToBasic(
      answering({
        isSuccess: true,
        operationResults: [{ isSuccess: true, result: { accessLevel: { accountLicenseType: 'express' } } }]
      }),
      'token',
      'example-org',
      'id'
    )
    expect(raised).toEqual({ outcome: 'raised' })
  })
})
