import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { DELEGATION_DENIED, INVOCATION_CONFLICT } from '../../registry/webchatMcpDelegationService.js'
import { FrameRouter } from './index.js'
import { handleMcpInvocationMint } from './mcp-invocation-mint.js'

const DAEMON_ID = 'd1111111-1111-4111-8111-111111111111'
const OTHER_DAEMON_ID = 'd2222222-2222-4222-8222-222222222222'
const DELEGATION_ID = 'e1111111-1111-4111-8111-111111111111'
const AGENT_ID = 'a1111111-1111-4111-8111-111111111111'
const CONVERSATION_ID = 'c1111111-1111-4111-8111-111111111111'
const INVOCATION_ID = '11111111-1111-4111-8111-111111111111'

function mintFrame(overrides: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: 'f1111111-1111-4111-8111-111111111111',
    ts: '2026-07-30T00:00:00.000Z',
    type: 'mcp/invocation/mint',
    payload: {
      delegationId: DELEGATION_ID,
      generation: 7,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      invocationId: INVOCATION_ID,
      requestHash: 'a'.repeat(64),
      method: 'tools/list',
      ...overrides
    }
  } as AnyFrame
}

function fakeConn(daemonId = DAEMON_ID) {
  return {
    daemonId,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
    sendError: ReturnType<typeof vi.fn>
  }
}

function depsWith(mintInvocation: NonNullable<DaemonWsDeps['webchatMcpDelegation']>['mintInvocation']): DaemonWsDeps {
  return {
    webchatMcpDelegation: { mintInvocation }
  } as unknown as DaemonWsDeps
}

describe('handleMcpInvocationMint', () => {
  it('derives daemon identity only from the authenticated connection and correlates the minted reply', async () => {
    const mintInvocation = vi.fn(async () => ({
      kind: 'minted' as const,
      invocationId: INVOCATION_ID,
      assertion: 'ac_mcp_assertion_secret',
      expiresAt: '2026-07-30T00:00:30.000Z'
    }))
    const deps = depsWith(mintInvocation)
    const conn = fakeConn()
    const frame = mintFrame()

    await new FrameRouter().dispatch(frame, conn, deps)

    expect(mintInvocation).toHaveBeenCalledWith({
      ...frame.payload,
      authenticatedDaemonId: DAEMON_ID
    })
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'mcp/invocation/minted', {
      invocationId: INVOCATION_ID,
      assertion: 'ac_mcp_assertion_secret',
      expiresAt: '2026-07-30T00:00:30.000Z'
    })
    const replyPayload = conn.replyTo.mock.calls[0]?.[2]
    expect(replyPayload).not.toHaveProperty('userId')
    expect(replyPayload).not.toHaveProperty('orgId')
    expect(replyPayload).not.toHaveProperty('daemonId')
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('returns the exact generic denial for wrong-daemon, stale-generation, and hidden authority failures', async () => {
    const serializedErrors: string[] = []
    for (const testCase of [
      { daemonId: OTHER_DAEMON_ID, generation: 7 },
      { daemonId: DAEMON_ID, generation: 6 },
      { daemonId: DAEMON_ID, generation: 7 }
    ]) {
      const mintInvocation = vi.fn(async (input: { authenticatedDaemonId: string; generation: number }) =>
        input.authenticatedDaemonId === DAEMON_ID && input.generation === 7 ? DELEGATION_DENIED : DELEGATION_DENIED
      )
      const deps = depsWith(mintInvocation)
      const conn = fakeConn(testCase.daemonId)
      await handleMcpInvocationMint(mintFrame({ generation: testCase.generation }), conn, deps)
      expect(conn.replyTo).not.toHaveBeenCalled()
      expect(conn.sendError).toHaveBeenCalledWith(mintFrame().id, 'DELEGATION_DENIED', DELEGATION_DENIED.message, false)
      serializedErrors.push(JSON.stringify(conn.sendError.mock.calls[0]))
    }

    expect(new Set(serializedErrors)).toEqual(
      new Set([[mintFrame().id, 'DELEGATION_DENIED', DELEGATION_DENIED.message, false]].map(JSON.stringify))
    )
  })

  it('uses INVOCATION_CONFLICT only for a known invocation id rebound by its caller', async () => {
    const conn = fakeConn()
    await handleMcpInvocationMint(mintFrame(), conn, depsWith(vi.fn(async () => INVOCATION_CONFLICT)))

    expect(conn.sendError).toHaveBeenCalledWith(
      mintFrame().id,
      'INVOCATION_CONFLICT',
      INVOCATION_CONFLICT.message,
      false
    )
  })

  it('does not turn a same-binding running or terminal retry into an invocation conflict', async () => {
    for (const status of ['running', 'succeeded', 'failed', 'ambiguous'] as const) {
      const conn = fakeConn()
      await handleMcpInvocationMint(
        mintFrame(),
        conn,
        depsWith(vi.fn(async () => ({ kind: 'existing' as const, invocationId: INVOCATION_ID, status })))
      )
      expect(conn.sendError).toHaveBeenCalledWith(mintFrame().id, 'DELEGATION_DENIED', DELEGATION_DENIED.message, false)
    }
  })

  it('fails closed with a correlated retryable internal error when minting throws', async () => {
    const conn = fakeConn()
    await handleMcpInvocationMint(
      mintFrame(),
      conn,
      depsWith(
        vi.fn(async () => {
          throw new Error('database secret')
        })
      )
    )

    expect(conn.sendError).toHaveBeenCalledWith(mintFrame().id, 'INTERNAL', 'delegated MCP mint failed', true)
  })
})
