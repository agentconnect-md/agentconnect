import {
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED,
  type AnyFrame
} from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleGithubReviewResult } from './github-review-result.js'
import { handleHookReport } from './hook-report.js'
import { handleHookStart } from './hook-start.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333'
const snapshot = {
  configRevision: '1',
  dispatchRevision: '2',
  dispatchDaemonId: DAEMON_ID,
  reviewPolicy: 'full' as const,
  reportingMode: 'check' as const,
  gateMode: 'informational' as const
}

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    orgId: 'org-a',
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => (resolve = done)), resolve }
}

describe('GitHub projection request barriers', () => {
  it('does not ACK hook/start until the durable projection converges', async () => {
    const barrier = deferred()
    const conn = fakeConn()
    const frame = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: 'hook/start',
      payload: {
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-1',
        event: 'pull_request:synchronize',
        github: {
          repoId: '42',
          repoFullName: 'acme/repo',
          sourceInstallationId: '77',
          subjectKind: 'pull_request',
          pullNumber: 9,
          headSha: 'head',
          baseSha: 'base',
          reportSha: 'head',
          isDraft: false,
          baseChanged: false
        },
        ...snapshot
      }
    } as AnyFrame
    const deps = {
      githubReviewBroker: { start: vi.fn(async () => {}) },
      githubRunCoordinator: { afterStart: vi.fn(() => barrier.promise) }
    } as unknown as DaemonWsDeps

    const handling = handleHookStart(frame, conn, deps)
    await vi.waitFor(() => expect(deps.githubRunCoordinator!.afterStart).toHaveBeenCalledOnce())
    expect(conn.replyTo).not.toHaveBeenCalled()

    barrier.resolve()
    await handling
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'hook/start/ok', { accepted: true })
  })

  it('does not ACK a submitted review result until its terminal projection converges', async () => {
    const barrier = deferred()
    const conn = fakeConn()
    const frame = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: 'github/review-result',
      payload: {
        hookId: HOOK_ID,
        deliveryKey: 'delivery-1',
        attemptId: ATTEMPT_ID,
        snapshot,
        result: {
          state: 'submitted',
          reviewId: '9007199254740993',
          event: 'APPROVE',
          verdict: 'pass',
          commitId: 'head'
        }
      }
    } as AnyFrame
    const deps = {
      githubReviewBroker: { recordResult: vi.fn(async () => {}) },
      githubRunCoordinator: { afterReviewResult: vi.fn(() => barrier.promise) }
    } as unknown as DaemonWsDeps

    const handling = handleGithubReviewResult(frame, conn, deps)
    await vi.waitFor(() => expect(deps.githubRunCoordinator!.afterReviewResult).toHaveBeenCalledOnce())
    expect(conn.replyTo).not.toHaveBeenCalled()

    barrier.resolve()
    await handling
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'github/review-result/ok', { accepted: true })
  })

  it('recovers a completion-first target-branch change as a revision projection', async () => {
    const recordReport = vi.fn(async () => true)
    const barrier = deferred()
    const afterReport = vi.fn(() => barrier.promise)
    const conn = fakeConn()
    const frame = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: 'hook/report',
      payload: {
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-lost-before-cp',
        event: 'pull_request:edited',
        github: {
          repoId: '42',
          repoFullName: 'acme/repo',
          sourceInstallationId: '77',
          subjectKind: 'pull_request',
          pullNumber: 9,
          headSha: 'head',
          baseSha: 'base',
          reportSha: 'head',
          isDraft: false,
          baseChanged: true
        },
        ...snapshot,
        status: 'success'
      }
    } as AnyFrame
    const deps = {
      hook: { recordReport, get: async () => ({ id: HOOK_ID }) },
      githubRunCoordinator: { afterReport },
      clock: { now: () => 1_700_000_000_000 }
    } as unknown as DaemonWsDeps

    const handling = handleHookReport(frame, conn, deps)
    await vi.waitFor(() => expect(afterReport).toHaveBeenCalledOnce())
    expect(conn.replyTo).not.toHaveBeenCalled()
    barrier.resolve()
    await handling

    expect(recordReport).toHaveBeenCalledWith(
      HOOK_ID,
      DAEMON_ID,
      expect.objectContaining({
        event: 'pull_request:edited',
        projectionIntent: 'revision_event',
        repoId: 42n,
        reportSha: 'head'
      }),
      new Date(1_700_000_000_000)
    )
    expect(afterReport).toHaveBeenCalledWith(HOOK_ID, 'delivery-lost-before-cp')
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'ack', { ok: true })
  })

  it('keeps provider quota exhaustion operationally failed while projecting it as skipped', async () => {
    const recordReport = vi.fn(async () => true)
    const afterReport = vi.fn(async () => {})
    const conn = fakeConn()
    const frame = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: 'hook/report',
      payload: {
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-provider-quota',
        event: 'pull_request:opened',
        ...snapshot,
        status: 'failed',
        reason: HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
      }
    } as AnyFrame
    const deps = {
      hook: { recordReport, get: async () => ({ id: HOOK_ID }) },
      githubRunCoordinator: { afterReport },
      clock: { now: () => 1_700_000_000_000 }
    } as unknown as DaemonWsDeps

    await handleHookReport(frame, conn, deps)

    expect(recordReport).toHaveBeenCalledWith(
      HOOK_ID,
      DAEMON_ID,
      expect.objectContaining({
        status: 'failed',
        reason: HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED,
        projectionDesiredState: 'skipped'
      }),
      new Date(1_700_000_000_000)
    )
    expect(afterReport).toHaveBeenCalledWith(HOOK_ID, 'delivery-provider-quota')
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'ack', { ok: true })
  })

  it('keeps provider authentication failures operationally failed while projecting them as skipped', async () => {
    const recordReport = vi.fn(async () => true)
    const afterReport = vi.fn(async () => {})
    const conn = fakeConn()
    const frame = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: 'hook/report',
      payload: {
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-provider-auth',
        event: 'pull_request:opened',
        ...snapshot,
        status: 'failed',
        reason: HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
      }
    } as AnyFrame
    const deps = {
      hook: { recordReport, get: async () => ({ id: HOOK_ID }) },
      githubRunCoordinator: { afterReport },
      clock: { now: () => 1_700_000_000_000 }
    } as unknown as DaemonWsDeps

    await handleHookReport(frame, conn, deps)

    expect(recordReport).toHaveBeenCalledWith(
      HOOK_ID,
      DAEMON_ID,
      expect.objectContaining({
        status: 'failed',
        reason: HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
        projectionDesiredState: 'skipped'
      }),
      new Date(1_700_000_000_000)
    )
    expect(afterReport).toHaveBeenCalledWith(HOOK_ID, 'delivery-provider-auth')
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'ack', { ok: true })
  })
})
