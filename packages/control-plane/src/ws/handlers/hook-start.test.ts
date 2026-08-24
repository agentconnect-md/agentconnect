import type { AnyFrame } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleHookStart } from './hook-start.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const NOW = 1_700_000_000_000
const snapshot = {
  configRevision: '1',
  dispatchRevision: '2',
  dispatchDaemonId: DAEMON_ID,
  reviewPolicy: 'full' as const,
  reportingMode: 'off' as const,
  gateMode: 'informational' as const
}
const gitlab = {
  projectId: '4455667',
  projectPath: 'example-group/example-project',
  target: { kind: 'merge_request' as const, iid: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }
}

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    orgId: 'org-a',
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

function startFrame(payload: Record<string, unknown>): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type: 'hook/start',
    payload: {
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      deliveryKey: 'delivery-1',
      sessionId: 'acp-gitlab-1',
      event: 'merge_request:update',
      ...snapshot,
      ...payload
    }
  } as AnyFrame
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => (resolve = done)), resolve }
}

function gitlabDeps(over: Partial<Record<string, unknown>> = {}) {
  return {
    hook: { get: vi.fn(async () => ({ id: HOOK_ID, kind: 'gitlab', projectionEpoch: 3n })) },
    codeHostReviewBroker: { start: vi.fn(async () => {}) },
    codeHostNoteProjection: { afterStart: vi.fn(async () => {}) },
    githubReviewBroker: { start: vi.fn(async () => {}) },
    githubRunCoordinator: { afterStart: vi.fn(async () => {}) },
    clock: { now: () => NOW },
    ...over
  } as unknown as DaemonWsDeps
}

describe('hook/start provider one-of (gitlab-com-integration.md §17.2)', () => {
  it('records the gitlab start and opens the running projection before it ACKs', async () => {
    const barrier = deferred()
    const conn = fakeConn()
    const frame = startFrame({ gitlab })
    const deps = gitlabDeps({ codeHostNoteProjection: { afterStart: vi.fn(() => barrier.promise) } })

    const handling = handleHookStart(frame, conn, deps)
    await vi.waitFor(() => expect(deps.codeHostNoteProjection!.afterStart).toHaveBeenCalledOnce())
    expect(conn.replyTo).not.toHaveBeenCalled()

    barrier.resolve()
    await handling

    expect(deps.codeHostReviewBroker!.start).toHaveBeenCalledWith(frame.payload, DAEMON_ID, 'org-a')
    expect(deps.codeHostNoteProjection!.afterStart).toHaveBeenCalledWith({
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      deliveryKey: 'delivery-1',
      orgId: 'org-a',
      state: 'running',
      sessionId: 'acp-gitlab-1',
      gitlab,
      snapshot: frame.payload,
      at: new Date(NOW)
    })
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'hook/start/ok', { accepted: true })
  })

  it('never routes a gitlab start through the github review broker', async () => {
    const conn = fakeConn()
    const deps = gitlabDeps()

    await handleHookStart(startFrame({ gitlab }), conn, deps)

    expect(deps.githubReviewBroker!.start).not.toHaveBeenCalled()
    expect(deps.githubRunCoordinator!.afterStart).not.toHaveBeenCalled()
  })

  it('still records the start when the hook subject has no revision to project', async () => {
    const conn = fakeConn()
    const deps = gitlabDeps()
    const issue = { ...gitlab, target: { kind: 'issue' as const, iid: 7 } }

    await handleHookStart(startFrame({ gitlab: issue }), conn, deps)

    expect(deps.codeHostReviewBroker!.start).toHaveBeenCalledOnce()
    // The ledger drops a subject with nothing to project; the edge is still offered to it.
    expect(deps.codeHostNoteProjection!.afterStart).toHaveBeenCalledWith(expect.objectContaining({ gitlab: issue }))
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'hook/start/ok', { accepted: true })
  })

  it('refuses a gitlab start whose hook is not a gitlab hook in this organization', async () => {
    const conn = fakeConn()
    const deps = gitlabDeps({ hook: { get: vi.fn(async () => null) } })

    await handleHookStart(startFrame({ gitlab }), conn, deps)

    expect(deps.codeHostReviewBroker!.start).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'hook is not a gitlab hook in this organization',
      false
    )
  })

  it('leaves the github arm on the github broker and its check coordinator', async () => {
    const conn = fakeConn()
    const deps = gitlabDeps()
    const github = {
      repoId: '42',
      repoFullName: 'acme/repo',
      sourceInstallationId: '77',
      subjectKind: 'pull_request',
      pullNumber: 9,
      headSha: 'head',
      baseSha: 'base',
      reportSha: 'head'
    }

    await handleHookStart(startFrame({ event: 'pull_request:synchronize', github }), conn, deps)

    expect(deps.githubReviewBroker!.start).toHaveBeenCalledOnce()
    expect(deps.githubRunCoordinator!.afterStart).toHaveBeenCalledWith(HOOK_ID, 'delivery-1')
    expect(deps.codeHostReviewBroker!.start).not.toHaveBeenCalled()
    expect(deps.codeHostNoteProjection!.afterStart).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'hook/start/ok', { accepted: true })
  })
})
