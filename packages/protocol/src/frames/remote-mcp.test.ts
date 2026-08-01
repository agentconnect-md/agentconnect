import { describe, expect, it } from 'vitest'
import {
  FRAME_SCHEMAS,
  WEBCHAT_REMOTE_MCP_FEATURE,
  WebchatMcpGrantAccept,
  WebchatMcpGrantActivate,
  WebchatMcpGrantIssue,
  WebchatMcpGrantIssued,
  WebchatMcpGrantRevoke,
  WebchatMcpGrantRevoked,
  WebchatRemoteMcpEntitlement,
  buildEnvelope,
  decodeEnvelope,
  isFrame
} from '../index.js'

const AUTHORITY_ID = '11111111-1111-4111-8111-111111111111'
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222'
const DESCRIPTOR_ID = '33333333-3333-4333-8333-333333333333'
const GRANT_ID = '44444444-4444-4444-8444-444444444444'
const EXPIRES_AT = '2026-08-01T00:00:00.000Z'

const fence = {
  authorityId: AUTHORITY_ID,
  authorityGeneration: 2,
  conversationId: CONVERSATION_ID,
  descriptorInstanceId: DESCRIPTOR_ID,
  grantRevision: 7
}

describe('webchat remote MCP protocol', () => {
  it('advertises the runtime capability explicitly', () => {
    expect(WEBCHAT_REMOTE_MCP_FEATURE).toBe('webchat_remote_mcp_v1')
  })

  it('validates the non-secret relay entitlement', () => {
    expect(
      WebchatRemoteMcpEntitlement.parse({
        authorityId: AUTHORITY_ID,
        authorityGeneration: 2,
        expiresAt: EXPIRES_AT
      })
    ).toEqual({
      authorityId: AUTHORITY_ID,
      authorityGeneration: 2,
      expiresAt: EXPIRES_AT
    })
  })

  it('validates issue, issued, accept, and activate payloads', () => {
    expect(
      WebchatMcpGrantIssue.safeParse({
        authorityId: AUTHORITY_ID,
        authorityGeneration: 2,
        conversationId: CONVERSATION_ID,
        descriptorInstanceId: DESCRIPTOR_ID
      }).success
    ).toBe(true)
    expect(
      WebchatMcpGrantIssued.safeParse({
        ...fence,
        grantId: GRANT_ID,
        token: 'secret-'.repeat(8),
        expiresAt: EXPIRES_AT,
        mcpUrl: 'https://cp.example/api/v1/mcp'
      }).success
    ).toBe(true)
    expect(WebchatMcpGrantAccept.safeParse({ ...fence, grantId: GRANT_ID }).success).toBe(true)
    expect(WebchatMcpGrantActivate.safeParse({ ...fence, grantId: GRANT_ID, activated: true }).success).toBe(true)
  })

  it('requires positive monotonic fences and never accepts a token in the entitlement', () => {
    expect(WebchatMcpGrantAccept.safeParse({ ...fence, grantRevision: 0, grantId: GRANT_ID }).success).toBe(false)
    expect(
      WebchatRemoteMcpEntitlement.safeParse({
        authorityId: AUTHORITY_ID,
        authorityGeneration: 2,
        expiresAt: EXPIRES_AT,
        token: 'must-not-cross-the-relay'
      }).success
    ).toBe(false)
  })

  it('round-trips all grant lifecycle frames', () => {
    const payloads = {
      'webchat/mcp-grant/issue': {
        authorityId: AUTHORITY_ID,
        authorityGeneration: 2,
        conversationId: CONVERSATION_ID,
        descriptorInstanceId: DESCRIPTOR_ID
      },
      'webchat/mcp-grant/issued': {
        ...fence,
        grantId: GRANT_ID,
        token: 'secret-'.repeat(8),
        expiresAt: EXPIRES_AT,
        mcpUrl: 'https://cp.example/api/v1/mcp'
      },
      'webchat/mcp-grant/accept': { ...fence, grantId: GRANT_ID },
      'webchat/mcp-grant/activate': { ...fence, grantId: GRANT_ID, activated: true },
      'webchat/mcp-grant/revoke': {
        authorityId: AUTHORITY_ID,
        authorityGeneration: 2,
        conversationId: CONVERSATION_ID,
        reason: 'session_closed' as const
      },
      'webchat/mcp-grant/revoked': {
        authorityId: AUTHORITY_ID,
        authorityGeneration: 2,
        conversationId: CONVERSATION_ID,
        revoked: true
      }
    }

    for (const [type, payload] of Object.entries(payloads)) {
      expect(FRAME_SCHEMAS[type as keyof typeof FRAME_SCHEMAS]).toBeDefined()
      const decoded = decodeEnvelope(JSON.stringify(buildEnvelope(type as keyof typeof FRAME_SCHEMAS, payload)))
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) throw new Error(`expected ${type}`)
      expect(isFrame(type as keyof typeof FRAME_SCHEMAS)(decoded.frame)).toBe(true)
    }
  })

  it('validates revocation reasons and acknowledgement', () => {
    for (const reason of [
      'session_closed',
      'session_expired',
      'agent_detached',
      'feature_disabled',
      'security'
    ] as const) {
      expect(
        WebchatMcpGrantRevoke.safeParse({
          authorityId: AUTHORITY_ID,
          authorityGeneration: 2,
          conversationId: CONVERSATION_ID,
          reason
        }).success
      ).toBe(true)
    }
    expect(
      WebchatMcpGrantRevoked.safeParse({
        authorityId: AUTHORITY_ID,
        authorityGeneration: 2,
        conversationId: CONVERSATION_ID,
        revoked: true
      }).success
    ).toBe(true)
  })
})
