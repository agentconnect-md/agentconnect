import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleApprovalRoute } from './approval-route.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'

function fakeConn() {
  return {
    daemonId: 'daemon-1',
    orgId: 'org-a',
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

function routeFrame(): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type: 'agent/approval-route',
    orgId: 'org-a',
    payload: { agentId: AGENT_ID, requestId: REQUEST_ID, integrationIds: [INTEGRATION_ID] }
  } as AnyFrame
}

const baseDeps = (over: Partial<DaemonWsDeps>) => ({ log: { error: vi.fn() }, ...over }) as unknown as DaemonWsDeps

describe('handleApprovalRoute', () => {
  it('replies agent/approval-routed with the resolver answer', async () => {
    const frame = routeFrame()
    const conn = fakeConn()
    const approvalRoute = vi.fn().mockResolvedValue({ requestId: REQUEST_ID })
    await handleApprovalRoute(frame, conn, baseDeps({ approvalRoute }))
    expect(approvalRoute).toHaveBeenCalledWith(frame.payload, 'org-a')
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'agent/approval-routed', { requestId: REQUEST_ID })
  })

  it('fails closed when the resolver is absent', async () => {
    const frame = routeFrame()
    const conn = fakeConn()
    await handleApprovalRoute(frame, conn, baseDeps({}))
    expect(conn.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)
    expect(conn.replyTo).not.toHaveBeenCalled()
  })

  it('maps a resolver throw to a retryable INTERNAL error', async () => {
    const frame = routeFrame()
    const conn = fakeConn()
    const approvalRoute = vi.fn().mockRejectedValue(new Error('boom'))
    await handleApprovalRoute(frame, conn, baseDeps({ approvalRoute }))
    expect(conn.sendError).toHaveBeenCalledWith(frame.id, 'INTERNAL', expect.any(String), true)
  })
})
