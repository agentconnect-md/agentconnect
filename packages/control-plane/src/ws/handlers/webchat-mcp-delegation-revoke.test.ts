import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { WebchatMcpDelegationRecord } from '../../persistence/ports.js'
import { DELEGATION_DENIED } from '../../registry/webchatMcpDelegationService.js'
import { FrameRouter } from './index.js'
import { handleWebchatMcpDelegationRevoke } from './webchat-mcp-delegation-revoke.js'

const DAEMON_ID = 'd1111111-1111-4111-8111-111111111111'
const OTHER_DAEMON_ID = 'd2222222-2222-4222-8222-222222222222'
const DELEGATION_ID = 'e1111111-1111-4111-8111-111111111111'

const delegation = {
  id: DELEGATION_ID,
  conversationId: 'c1111111-1111-4111-8111-111111111111',
  generation: 7,
  userId: 'owner@example.test',
  orgId: 'org-1',
  agentId: 'a1111111-1111-4111-8111-111111111111',
  daemonId: DAEMON_ID,
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  expiresAt: new Date('2026-07-30T01:00:00.000Z'),
  revokedAt: null,
  revokedReason: null
} satisfies WebchatMcpDelegationRecord

function revokeFrame(overrides: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: 'f1111111-1111-4111-8111-111111111111',
    ts: '2026-07-30T00:00:00.000Z',
    type: 'webchat/mcp-delegation/revoke',
    payload: {
      delegationId: DELEGATION_ID,
      generation: 7,
      reason: 'session_closed',
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

function depsWith(
  get: NonNullable<DaemonWsDeps['webchatMcpDelegations']>['get'],
  revoke = vi.fn(async () => true)
): DaemonWsDeps {
  return {
    webchatMcpDelegations: { get, revoke },
    clock: { now: () => Date.parse('2026-07-30T00:10:00.000Z') }
  } as unknown as DaemonWsDeps
}

describe('handleWebchatMcpDelegationRevoke', () => {
  it('applies the daemon/id/generation fence and sends a correlated success with no user credential', async () => {
    const revoke = vi.fn(async () => true)
    const deps = depsWith(
      vi.fn(async () => delegation),
      revoke
    )
    const conn = fakeConn()
    const frame = revokeFrame({ reason: 'session_expired' })

    await new FrameRouter().dispatch(frame, conn, deps)

    expect(revoke).toHaveBeenCalledWith({
      delegationId: DELEGATION_ID,
      conversationId: delegation.conversationId,
      generation: 7,
      userId: delegation.userId,
      orgId: delegation.orgId,
      agentId: delegation.agentId,
      daemonId: delegation.daemonId,
      revokedAt: new Date('2026-07-30T00:10:00.000Z'),
      reason: 'session_expired'
    })
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'webchat/mcp-delegation/revoked', {
      delegationId: DELEGATION_ID,
      generation: 7,
      revoked: true
    })
    const replyPayload = conn.replyTo.mock.calls[0]?.[2]
    expect(replyPayload).not.toHaveProperty('userId')
    expect(replyPayload).not.toHaveProperty('orgId')
    expect(replyPayload).not.toHaveProperty('daemonId')
  })

  it('returns one byte-equivalent denial for missing, wrong-daemon, stale-generation, and lost-CAS rows', async () => {
    const cases = [
      { record: null, daemonId: DAEMON_ID, generation: 7, revoke: true },
      { record: delegation, daemonId: OTHER_DAEMON_ID, generation: 7, revoke: true },
      { record: delegation, daemonId: DAEMON_ID, generation: 6, revoke: true },
      { record: delegation, daemonId: DAEMON_ID, generation: 7, revoke: false }
    ] as const
    const serializedErrors: string[] = []

    for (const testCase of cases) {
      const conn = fakeConn(testCase.daemonId)
      await handleWebchatMcpDelegationRevoke(
        revokeFrame({ generation: testCase.generation }),
        conn,
        depsWith(
          vi.fn(async () => testCase.record),
          vi.fn(async () => testCase.revoke)
        )
      )
      expect(conn.replyTo).not.toHaveBeenCalled()
      serializedErrors.push(JSON.stringify(conn.sendError.mock.calls[0]))
    }

    expect(new Set(serializedErrors)).toEqual(
      new Set([[revokeFrame().id, 'DELEGATION_DENIED', DELEGATION_DENIED.message, false]].map(JSON.stringify))
    )
  })

  it('acknowledges an already-revoked exact binding idempotently', async () => {
    const prior = {
      ...delegation,
      revokedAt: new Date('2026-07-30T00:05:00.000Z'),
      revokedReason: 'session_closed'
    }
    const conn = fakeConn()
    await handleWebchatMcpDelegationRevoke(
      revokeFrame(),
      conn,
      depsWith(
        vi.fn(async () => prior),
        vi.fn(async () => true)
      )
    )

    expect(conn.replyTo).toHaveBeenCalledWith(revokeFrame(), 'webchat/mcp-delegation/revoked', {
      delegationId: DELEGATION_ID,
      generation: 7,
      revoked: true
    })
  })

  it('fails closed without exposing persistence details', async () => {
    const conn = fakeConn()
    await handleWebchatMcpDelegationRevoke(
      revokeFrame(),
      conn,
      depsWith(
        vi.fn(async () => {
          throw new Error('database secret')
        })
      )
    )

    expect(conn.sendError).toHaveBeenCalledWith(revokeFrame().id, 'INTERNAL', 'delegated MCP revoke failed', true)
  })
})
