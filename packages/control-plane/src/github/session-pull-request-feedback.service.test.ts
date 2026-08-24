import { describe, expect, it, vi } from 'vitest'
import { PULL_REQUEST_FEEDBACK_FEATURE } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'
import type {
  AgentRecord,
  GithubInstallationRecord,
  PullRequestWakeRecord,
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

function wake(id: string, repoId = REPO_ID, sessionId: SessionId | null = SESSION_ID): PullRequestWakeRecord {
  return {
    deliveryKey: `delivery-${id}`,
    orgId: ORG_ID,
    installationId: INSTALLATION_ID,
    repoId,
    repoFullName: 'acme/infra',
    pullNumber: Number(repoId),
    sessionId
  }
}

function harness(over: Partial<SessionPullRequestFeedbackServiceDeps> = {}) {
  const clock = new FakeClock(NOW)
  const feedbackRepo = {
    linkSession: vi.fn(async () => true),
    enqueue: vi.fn(async () => {}),
    claimNext: vi.fn<SessionPullRequestFeedbackServiceDeps['feedback']['claimNext']>(async () => null),
    complete: vi.fn(async () => {}),
    defer: vi.fn(async () => {}),
    deleteExpired: vi.fn(async () => 0)
  }
  const links = { resolve: vi.fn(async (): Promise<SessionPullRequestLink | null> => null) }
  const send = vi.fn<SessionPullRequestFeedbackServiceDeps['send']>(async (_daemonId, request) => ({
    deliveryKey: request.deliveryKey,
    accepted: true
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
    daemon: vi.fn(() => ({ state: 'READY', capabilities: { features: [PULL_REQUEST_FEEDBACK_FEATURE] } })),
    send,
    log: { debug: vi.fn(), warn: vi.fn() },
    ...over
  } as unknown as SessionPullRequestFeedbackServiceDeps
  return { service: new SessionPullRequestFeedbackService(deps), clock, feedbackRepo, links, send, deps }
}

async function runOnce(h: ReturnType<typeof harness>): Promise<void> {
  h.service.start()
  h.clock.advance(0)
  await h.service.settle()
  h.service.stop()
}

describe('SessionPullRequestFeedbackService', () => {
  it('wakes immediately for older due work without globally extending the new PR debounce', async () => {
    const due = wake('already-due')
    const h = harness()
    h.service.start()
    h.clock.advance(0)
    await h.service.settle()
    h.clock.advance(5_000)
    h.feedbackRepo.claimNext.mockResolvedValueOnce(due).mockResolvedValueOnce(null)

    const signal = {
      deliveryKey: 'delivery-new',
      installationId: INSTALLATION_ID.toString(),
      repoId: '999',
      repoFullName: 'acme/infra',
      pullNumber: 999
    }
    await h.service.enqueue(signal)
    h.clock.advance(0)
    await h.service.settle()
    h.service.stop()

    expect(h.feedbackRepo.enqueue).toHaveBeenCalledWith(ORG_ID, signal, new Date(NOW + 15_000))
    expect(h.feedbackRepo.complete).toHaveBeenCalledWith(due, expect.any(String))
  })

  it('delivers one dirty PR generation to the exact linked session', async () => {
    const item = wake('review')
    const h = harness()
    h.feedbackRepo.claimNext.mockResolvedValueOnce(item).mockResolvedValueOnce(null)

    await runOnce(h)

    expect(h.send).toHaveBeenCalledWith(
      DAEMON_ID,
      expect.objectContaining({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        deliveryKey: item.deliveryKey,
        pullNumber: Number(REPO_ID)
      }),
      ORG_ID
    )
    expect(h.feedbackRepo.complete).toHaveBeenCalledWith(item, expect.any(String))
  })

  it('defers an unavailable session and continues to a healthy PR in the same pass', async () => {
    const blocked = wake('blocked')
    const healthy = wake('healthy', 457n)
    const h = harness()
    h.feedbackRepo.claimNext.mockResolvedValueOnce(blocked).mockResolvedValueOnce(healthy).mockResolvedValueOnce(null)
    h.send
      .mockResolvedValueOnce({ deliveryKey: blocked.deliveryKey, accepted: false, reason: 'busy' })
      .mockResolvedValueOnce({ deliveryKey: healthy.deliveryKey, accepted: true })

    await runOnce(h)

    expect(h.feedbackRepo.defer).toHaveBeenCalledWith(blocked, expect.any(String), new Date(NOW + 10_000))
    expect(h.feedbackRepo.complete).toHaveBeenCalledWith(healthy, expect.any(String))
  })

  it('defers one unmatched PR and still reverse-discovers the next manual PR', async () => {
    const unrelated = wake('unrelated', 455n, null)
    const manual = wake('manual', REPO_ID, null)
    const h = harness()
    h.feedbackRepo.claimNext.mockResolvedValueOnce(unrelated).mockResolvedValueOnce(manual).mockResolvedValueOnce(null)
    h.links.resolve.mockResolvedValueOnce(null).mockResolvedValueOnce({
      repoId: REPO_ID,
      repoFullName: 'acme/infra',
      installationId: INSTALLATION_ID,
      pullNumber: Number(REPO_ID),
      branch: 'fix/manual-pr',
      scope: 'session',
      ambiguous: false
    })

    await runOnce(h)

    expect(h.feedbackRepo.defer).toHaveBeenCalledWith(unrelated, expect.any(String), new Date(NOW + 60_000))
    expect(h.feedbackRepo.linkSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, repoId: REPO_ID, pullNumber: Number(REPO_ID) })
    )
  })
})
