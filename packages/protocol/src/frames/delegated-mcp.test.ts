import { describe, expect, it } from 'vitest'
import {
  DELEGATED_MCP_ASSERTION_FEATURE,
  FRAME_SCHEMAS,
  McpInvocationMint,
  McpInvocationMinted,
  WebchatMcpDelegationReference,
  WebchatMcpDelegationRevoke,
  WebchatMcpDelegationRevoked,
  buildEnvelope,
  decodeEnvelope,
  encode,
  isFrame
} from '../index.js'

const DELEGATION_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const INVOCATION_ID = '44444444-4444-4444-8444-444444444444'
const DAEMON_ID = '55555555-5555-4555-8555-555555555555'
const EXPIRES_AT = '2026-07-30T12:00:00.000Z'
const REQUEST_HASH = 'a'.repeat(64)

const mint = {
  delegationId: DELEGATION_ID,
  generation: 1,
  agentId: AGENT_ID,
  conversationId: CONVERSATION_ID,
  invocationId: INVOCATION_ID,
  requestHash: REQUEST_HASH,
  method: 'tools/list' as const
}

describe('delegated MCP contracts', () => {
  it.each(['DELEGATION_DENIED', 'INVOCATION_CONFLICT'] as const)(
    'round-trips the exact %s correlated error code',
    (code) => {
      const request = buildEnvelope('mcp/invocation/mint', mint)
      const reply = buildEnvelope(
        'error',
        {
          code,
          message: code === 'DELEGATION_DENIED' ? 'Delegated MCP invocation is not authorized.' : 'conflict',
          retryable: false
        },
        { corr: request.id }
      )

      const decoded = decodeEnvelope(encode(reply))
      expect(decoded.ok).toBe(true)
      if (!decoded.ok || !isFrame('error')(decoded.frame)) throw new Error('expected error frame')
      expect(decoded.frame.payload.code).toBe(code)
      expect(decoded.frame.corr).toBe(request.id)
    }
  )

  it('publishes the daemon capability feature name', () => {
    expect(DELEGATED_MCP_ASSERTION_FEATURE).toBe('delegated_mcp_assertion_v1')
  })

  it('validates a strict delegation reference', () => {
    const reference = { id: DELEGATION_ID, generation: 1, expiresAt: EXPIRES_AT }
    expect(WebchatMcpDelegationReference.safeParse(reference).success).toBe(true)
    expect(WebchatMcpDelegationReference.safeParse({ ...reference, id: 'not-a-uuid' }).success).toBe(false)
    expect(WebchatMcpDelegationReference.safeParse({ ...reference, generation: 0 }).success).toBe(false)
    expect(WebchatMcpDelegationReference.safeParse({ ...reference, generation: 1.5 }).success).toBe(false)
    expect(WebchatMcpDelegationReference.safeParse({ ...reference, expiresAt: 'tomorrow' }).success).toBe(false)
    expect(WebchatMcpDelegationReference.safeParse({ ...reference, credential: 'secret' }).success).toBe(false)
  })

  it('validates UUIDs, generations, and lowercase SHA-256 hashes on mint requests', () => {
    expect(McpInvocationMint.safeParse(mint).success).toBe(true)

    for (const field of ['delegationId', 'agentId', 'conversationId', 'invocationId'] as const) {
      expect(McpInvocationMint.safeParse({ ...mint, [field]: 'not-a-uuid' }).success).toBe(false)
    }
    expect(McpInvocationMint.safeParse({ ...mint, generation: 0 }).success).toBe(false)
    expect(McpInvocationMint.safeParse({ ...mint, generation: 1.5 }).success).toBe(false)
    expect(McpInvocationMint.safeParse({ ...mint, requestHash: 'A'.repeat(64) }).success).toBe(false)
    expect(McpInvocationMint.safeParse({ ...mint, requestHash: 'a'.repeat(63) }).success).toBe(false)
  })

  it('requires toolName only for tools/call', () => {
    expect(McpInvocationMint.safeParse({ ...mint, method: 'tools/call', toolName: 'listAgents' }).success).toBe(true)
    expect(McpInvocationMint.safeParse({ ...mint, method: 'tools/call' }).success).toBe(false)
    expect(McpInvocationMint.safeParse({ ...mint, toolName: 'listAgents' }).success).toBe(false)
  })

  it('keeps the authenticated daemon identity out of both mint payloads', () => {
    expect(McpInvocationMint.safeParse({ ...mint, daemonId: DAEMON_ID }).success).toBe(false)
    expect(
      McpInvocationMinted.safeParse({
        invocationId: INVOCATION_ID,
        assertion: 'one-time-assertion',
        expiresAt: EXPIRES_AT,
        daemonId: DAEMON_ID
      }).success
    ).toBe(false)
  })

  it('round-trips the mint request and correlated reply through the frame registry', () => {
    expect(FRAME_SCHEMAS['mcp/invocation/mint']).toBe(McpInvocationMint)
    expect(FRAME_SCHEMAS['mcp/invocation/minted']).toBe(McpInvocationMinted)

    const request = buildEnvelope('mcp/invocation/mint', mint)
    const decodedRequest = decodeEnvelope(JSON.stringify(request))
    expect(decodedRequest.ok).toBe(true)
    if (!decodedRequest.ok || !isFrame('mcp/invocation/mint')(decodedRequest.frame)) {
      throw new Error('expected mcp/invocation/mint')
    }
    expect(decodedRequest.frame.payload).toEqual(mint)

    const reply = buildEnvelope(
      'mcp/invocation/minted',
      { invocationId: INVOCATION_ID, assertion: 'one-time-assertion', expiresAt: EXPIRES_AT },
      { corr: request.id }
    )
    const decodedReply = decodeEnvelope(JSON.stringify(reply))
    expect(decodedReply.ok).toBe(true)
    if (!decodedReply.ok || !isFrame('mcp/invocation/minted')(decodedReply.frame)) {
      throw new Error('expected mcp/invocation/minted')
    }
    expect(decodedReply.frame.corr).toBe(request.id)
  })

  it('accepts only enumerated revocation reasons', () => {
    for (const reason of ['session_closed', 'session_expired', 'agent_detached'] as const) {
      expect(WebchatMcpDelegationRevoke.safeParse({ delegationId: DELEGATION_ID, generation: 1, reason }).success).toBe(
        true
      )
    }
    expect(
      WebchatMcpDelegationRevoke.safeParse({
        delegationId: DELEGATION_ID,
        generation: 1,
        reason: 'daemon_shutdown'
      }).success
    ).toBe(false)
  })

  it('validates and round-trips strict generation-fenced revocation frames', () => {
    const revoke = {
      delegationId: DELEGATION_ID,
      generation: 1,
      reason: 'session_closed' as const
    }
    const revoked = { delegationId: DELEGATION_ID, generation: 1, revoked: true }

    expect(WebchatMcpDelegationRevoke.safeParse({ ...revoke, daemonId: DAEMON_ID }).success).toBe(false)
    expect(WebchatMcpDelegationRevoked.safeParse(revoked).success).toBe(true)
    expect(WebchatMcpDelegationRevoked.safeParse({ ...revoked, generation: 0 }).success).toBe(false)
    expect(WebchatMcpDelegationRevoked.safeParse({ ...revoked, extra: true }).success).toBe(false)
    expect(FRAME_SCHEMAS['webchat/mcp-delegation/revoke']).toBe(WebchatMcpDelegationRevoke)
    expect(FRAME_SCHEMAS['webchat/mcp-delegation/revoked']).toBe(WebchatMcpDelegationRevoked)

    const request = buildEnvelope('webchat/mcp-delegation/revoke', revoke)
    const decodedRequest = decodeEnvelope(JSON.stringify(request))
    expect(decodedRequest.ok).toBe(true)
    if (!decodedRequest.ok || !isFrame('webchat/mcp-delegation/revoke')(decodedRequest.frame)) {
      throw new Error('expected webchat/mcp-delegation/revoke')
    }

    const reply = buildEnvelope('webchat/mcp-delegation/revoked', revoked, { corr: request.id })
    const decodedReply = decodeEnvelope(JSON.stringify(reply))
    expect(decodedReply.ok).toBe(true)
    if (!decodedReply.ok || !isFrame('webchat/mcp-delegation/revoked')(decodedReply.frame)) {
      throw new Error('expected webchat/mcp-delegation/revoked')
    }
    expect(decodedReply.frame.corr).toBe(request.id)
  })
})
