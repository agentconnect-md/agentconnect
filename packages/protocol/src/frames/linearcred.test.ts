import { describe, expect, it } from 'vitest'
import {
  INSTALL_WIDE_FRAME_TYPES,
  IntegrationLinearConfig,
  LinearCredGrant,
  LinearCredRequest,
  buildEnvelope,
  decodeEnvelope,
  encode,
  isFrame,
  isFrameType
} from '../index.js'

const INTEGRATION_ID = '11111111-1111-4111-8111-111111111111'
const CORR_ID = '22222222-2222-4222-8222-222222222222'
const EXPIRES_AT = '2026-07-07T00:00:00.000Z'

const request = { integrationId: INTEGRATION_ID }
const grant = { accessToken: 'lin_oauth_example', expiresAt: EXPIRES_AT }

describe('linearcred frames (linear-integration.md §7.3)', () => {
  it('validates the broker request and grant payloads', () => {
    expect(LinearCredRequest.parse(request)).toEqual(request)
    expect(LinearCredGrant.parse(grant)).toEqual(grant)
  })

  it('requires a uuid integration id and an ISO expiry', () => {
    expect(LinearCredRequest.safeParse({ integrationId: 'not-a-uuid' }).success).toBe(false)
    expect(LinearCredRequest.safeParse({}).success).toBe(false)
    expect(LinearCredGrant.safeParse({ ...grant, expiresAt: '2026-07-07' }).success).toBe(false)
    expect(LinearCredGrant.safeParse({ accessToken: 'lin_oauth_example' }).success).toBe(false)
  })

  it('round-trips a linearcred/request through build → encode → decode and narrows', () => {
    const decoded = decodeEnvelope(encode(buildEnvelope('linearcred/request', request)))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    if (!isFrame('linearcred/request')(decoded.frame)) throw new Error('expected a linearcred/request frame')
    expect(decoded.frame.payload.integrationId).toBe(INTEGRATION_ID)
  })

  it('round-trips a correlated linearcred/grant and preserves a long token verbatim', () => {
    const accessToken = `lin_oauth_${'a'.repeat(400)}`
    const f = buildEnvelope('linearcred/grant', { accessToken, expiresAt: EXPIRES_AT }, { corr: CORR_ID })
    const decoded = decodeEnvelope(encode(f))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    if (!isFrame('linearcred/grant')(decoded.frame)) throw new Error('expected a linearcred/grant frame')
    expect(decoded.frame.payload.accessToken).toBe(accessToken)
    expect(decoded.frame.payload.expiresAt).toBe(EXPIRES_AT)
    expect(decoded.frame.corr).toBe(CORR_ID)
  })

  it('rejects a grant whose expiry is not an ISO datetime at the envelope edge', () => {
    const f = buildEnvelope('linearcred/grant', grant, { corr: CORR_ID })
    const raw = JSON.parse(encode(f)) as Record<string, unknown>
    ;(raw.payload as Record<string, unknown>).expiresAt = 'tomorrow'
    expect(decodeEnvelope(JSON.stringify(raw)).ok).toBe(false)
  })

  it('registers both frames as org-scoped envelope members, like gitcred', () => {
    expect(isFrameType('linearcred/request')).toBe(true)
    expect(isFrameType('linearcred/grant')).toBe(true)
    expect(INSTALL_WIDE_FRAME_TYPES.has('linearcred/request')).toBe(false)
    expect(INSTALL_WIDE_FRAME_TYPES.has('linearcred/grant')).toBe(false)
  })
})

describe('linear integration config payload (linear-integration.md §7.2)', () => {
  it('accepts the projected spec payload and keeps the display fields optional', () => {
    const full = {
      workspaceId: 'org-linear-1',
      workspaceName: 'Example Workspace',
      appUserId: 'user-app-1',
      accessToken: 'lin_oauth_example',
      accessTokenExpiresAt: EXPIRES_AT
    }
    expect(IntegrationLinearConfig.parse(full)).toEqual(full)
    const minimal = { workspaceId: 'org-linear-1', accessToken: 'lin_oauth_example', accessTokenExpiresAt: EXPIRES_AT }
    expect(IntegrationLinearConfig.parse(minimal)).toEqual(minimal)
  })

  it('refuses a payload without the short-lived token or its expiry', () => {
    expect(IntegrationLinearConfig.safeParse({ workspaceId: 'org-linear-1' }).success).toBe(false)
    expect(
      IntegrationLinearConfig.safeParse({
        workspaceId: 'org-linear-1',
        accessToken: 'lin_oauth_example',
        accessTokenExpiresAt: 'tomorrow'
      }).success
    ).toBe(false)
  })
})
