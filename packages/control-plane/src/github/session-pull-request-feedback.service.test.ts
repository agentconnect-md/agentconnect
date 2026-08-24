import { describe, expect, it, vi } from 'vitest'
import { PULL_REQUEST_FEEDBACK_FEATURE } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'
import type {
  AgentRecord,
  GithubInstallationRecord,
  PullRequestFeedbackRecord,
  SessionMetaRecord
} from '../persistence/ports.js'
import {
  SessionPullRequestFeedbackService,
  type SessionPullRequestFeedbackServiceDeps
} from './session-pull-request-feedback.service.js'
import type { SessionPullRequestLink } from './session-pull-request-link.service.js'

const NOW = 1_780_000_000_000
const ORG_ID = OrgId('org-a')
const AGENT_ID = AgentId('11111111-1111-4111-8111-111111111111')
const SESSION_ID = SessionId('22222222-2222-4222-8222-222222222222')
const DAEMON_ID = '33333333-3333-4333-8333-333333333333'
const INSTALLATION_ID = 123n
const REPO_ID = 456n

const AGENT = {
  id: AGENT_ID,
  orgId: ORG_ID,
  placementKind: 'daemon',
  daemonId: DAEMON_ID
} as unknown as AgentRecord

const SESSION = {
  id: SESSION_ID,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  daemonId: DAEMON_ID,
  contentSetId: null,
  contentPurgedAt: null,
  phase: 'end',
  platform: 'hook',
  workspaceIsolation: 'session'
} as unknown as SessionMetaRecord

const INSTALLATION = {
  orgId: ORG_ID,
  installationId: INSTALLATION_ID,
  revokedAt: null,
  suspendedAt: null
} as unknown as GithubInstallationRecord

function feedback(
  id: string,
  kind: PullRequestFeedbackRecord['kind'],
  event: PullRequestFeedbackRecord['event'],
  detail: string | null
): PullRequestFeedbackRecord {
  return {
    id,
    deliveryKey: `delivery-${id}`,
    orgId: ORG_ID,
    installationId: INSTALLATION_ID,
    repoId: REPO_ID,
    repoFullName: 'acme/infra',
    pullNumber: 77,
    event,
    kind,
    detail,
    observedAt: new Date(NOW),
    sessionId: SESSION_ID
  }
}

function harness(over: Partial<SessionPullRequestFeedbackServiceDeps> = {}) {
  const clock = new FakeClock(NOW)
  const feedbackRepo = {
    linkSession: vi.fn(async () => true),
    enqueue: vi.fn(async () => {}),
    unmatchedTargets: vi.fn(async () => []),
    claimPendingBatch: vi.fn(async () => []),
    markDelivered: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    deleteExpired: vi.fn(async () => 0)
  }
  const links = {
    resolve: vi.fn(async (): Promise<SessionPullRequestLink | null> => null)
  }
  const send = vi.fn(async (daemonId, request) => ({
    deliveryKey: request.deliveryKey,
    accepted: daemonId === DAEMON_ID
  }))
  const deps = {
    clock,
    feedback: feedbackRepo,
    sessions: {
      getUnscoped: vi.fn(async () => SESSION),
      recentTerminalForPullRequestDiscovery: vi.fn(async () => [SESSION])
    },
    agents: { getUnscoped: vi.fn(async () => AGENT) },
    installations: { getByInstallationId: vi.fn(async () => INSTALLATION) },
    memberSets: { sharedStoreMemberIdsOf: vi.fn(async () => []) },
    placement: { dispatchDaemon: vi.fn(async () => DAEMON_ID) },
    links,
    daemon: vi.fn(() => ({
      state: 'READY',
      capabilities: { features: [PULL_REQUEST_FEEDBACK_FEATURE] }
    })),
    send,
    log: { debug: vi.fn(), warn: vi.fn() },
    ...over
  } as unknown as SessionPullRequestFeedbackServiceDeps
  return { service: new SessionPullRequestFeedbackService(deps), clock, feedbackRepo, links, send, deps }
}

describe('SessionPullRequestFeedbackService', () => {
  it('coalesces a failed check and reviewer comment into one exact-session continuation', async () => {
    const ci = feedback('ci', 'ci_failure', 'check_suite:completed', 'failure')
    const comment = feedback('comment', 'comment', 'issue_comment:created', null)
    const h = harness()
    vi.mocked(h.deps.feedback.claimPendingBatch).mockResolvedValueOnce([ci, comment]).mockResolvedValueOnce([])

    h.service.start()
    h.clock.advance(0)
    await h.service.settle()
    h.service.stop()

    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith(
      DAEMON_ID,
      expect.objectContaining({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        deliveryKey: comment.deliveryKey,
        kind: 'comment',
        pullNumber: 77
      }),
      ORG_ID
    )
    expect(h.feedbackRepo.markDelivered).toHaveBeenCalledWith(['ci', 'comment'], expect.any(String), new Date(NOW))
  })

  it('reverse-discovers a manually opened PR from a terminal GitHub issue session', async () => {
    const h = harness()
    vi.mocked(h.deps.feedback.unmatchedTargets).mockResolvedValueOnce([
      { orgId: ORG_ID, repoId: REPO_ID, pullNumber: 77 }
    ])
    h.links.resolve.mockResolvedValueOnce({
      repoId: REPO_ID,
      repoFullName: 'acme/infra',
      installationId: INSTALLATION_ID,
      pullNumber: 77,
      branch: 'fix/manual-pr',
      scope: 'session',
      ambiguous: false
    })

    h.service.start()
    h.clock.advance(0)
    await h.service.settle()
    h.service.stop()

    expect(h.deps.sessions.recentTerminalForPullRequestDiscovery).toHaveBeenCalledWith(ORG_ID, 20)
    expect(h.links.resolve).toHaveBeenCalledWith(AGENT, SESSION, true)
  })
})
