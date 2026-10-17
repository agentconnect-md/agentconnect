import { describe, expect, it, vi } from 'vitest'
import { CODEHOST_FEEDBACK_FEATURE, type RcCodeHostFeedback } from '@agentconnect.md/protocol'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'
import type { AgentRecord, PullRequestWakeRecord, SessionMetaRecord } from '../persistence/ports.js'
import { CodeHostFeedbackService, type FeedbackPull, type FeedbackRepository } from './feedback.service.js'
import type { SessionPullRequestFeedbackService } from './session-pull-request-feedback.service.js'

const ORG = OrgId('example-org')
const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const SESSION = SessionId('22222222-2222-4222-8222-222222222222')
const BINDING = '33333333-3333-4333-8333-333333333333'
const SHA = 'a'.repeat(40)
const pull: FeedbackPull = { number: 12, branch: 'feature', headSha: SHA, sourceRepoId: 123n }

describe.each(['gitlab', 'gitea'] as const)('%s author feedback', (provider) => {
  function harness() {
    const agent = {
      id: AGENT,
      orgId: ORG,
      workspaceRepoId: 123n,
      workspace: {
        mode: 'git',
        isolation: 'session',
        credential: { provider, access: 'write' }
      }
    } as AgentRecord
    const session = { id: SESSION } as SessionMetaRecord
    const repo: FeedbackRepository = {
      bindingId: BINDING,
      orgId: ORG,
      repoId: 123n,
      repoFullName: 'example-org/example-repo',
      host: `https://${provider}.example.test`,
      signingKey: 'example-key',
      pulls: vi.fn(async () => [pull]),
      admits: vi.fn(async () => true)
    }
    const repository = vi.fn(async (): Promise<FeedbackRepository | null> => repo)
    const readBranch = vi.fn(async () => 'feature')
    const enqueue = vi.fn(async () => AGENT)
    const service = new CodeHostFeedbackService({
      providers: [
        { provider, pullNumber: () => 12, repositories: async () => [{ orgId: ORG, repoId: 123n }], repository }
      ],
      agents: { list: async () => [agent] },
      readBranch,
      queue: { enqueueForOrg: enqueue } as unknown as SessionPullRequestFeedbackService,
      broadcast: vi.fn()
    })
    const signal: RcCodeHostFeedback = {
      provider,
      orgId: ORG,
      bindingId: BINDING,
      host: repo.host,
      repoId: '123',
      deliveryKey: 'delivery',
      kind: 'comment',
      actorId: '7',
      pullNumber: 12
    }
    return { service, repo, repository, agent, session, signal, readBranch, enqueue }
  }

  it('links an isolated CLI-created branch only when exactly one same-repository PR matches', async () => {
    const h = harness()
    expect(await h.service.capture(h.agent, h.session)).toMatchObject({
      status: 'resolved',
      link: {
        provider,
        bindingId: BINDING,
        pullNumber: 12,
        branch: 'feature',
        scope: 'session'
      }
    })
    vi.mocked(h.repo.pulls).mockResolvedValue([{ ...pull, sourceRepoId: 999n }])
    expect(await h.service.capture(h.agent, h.session)).toEqual({ status: 'absent' })
    vi.mocked(h.repo.pulls).mockResolvedValue([pull, { ...pull, number: 13 }])
    expect(await h.service.capture(h.agent, h.session)).toEqual({ status: 'absent' })
  })

  it('subscribes a writable workspace without a trigger, only on capable relays', async () => {
    const h = harness()
    const send = vi.fn()
    await h.service.replayTo({ features: [], send } as never)
    expect(send).not.toHaveBeenCalled()
    await h.service.replayTo({ features: [CODEHOST_FEEDBACK_FEATURE], send } as never)
    expect(send).toHaveBeenCalledWith(
      'rc/codehost-feedback-watch',
      expect.objectContaining({ provider, repoId: '123', watch: expect.objectContaining({ bindingId: BINDING }) })
    )
  })

  it('ignores replaced bindings, untrusted commenters and obsolete CI revisions', async () => {
    const h = harness()
    await h.service.receive({ ...h.signal, bindingId: '44444444-4444-4444-8444-444444444444' })
    vi.mocked(h.repo.admits).mockResolvedValue(false)
    await h.service.receive(h.signal)
    await h.service.receive({ ...h.signal, kind: 'ci', headSha: 'b'.repeat(40) })
    expect(h.enqueue).not.toHaveBeenCalled()
    await h.service.receive({ ...h.signal, kind: 'ci', headSha: SHA })
    expect(h.enqueue).toHaveBeenCalledWith(ORG, expect.objectContaining({ provider, headSha: SHA, pullNumber: 12 }))
  })

  it('rechecks current authorization and open PR state before dispatch', async () => {
    const h = harness()
    const wake = {
      provider,
      orgId: ORG,
      bindingId: BINDING,
      host: h.repo.host,
      repoId: 123n,
      pullNumber: 12,
      headSha: SHA
    } as PullRequestWakeRecord
    expect(await h.service.validate(wake, h.agent)).toBe(true)
    vi.mocked(h.repo.pulls).mockResolvedValue([])
    expect(await h.service.validate(wake, h.agent)).toBe(false)
    h.repository.mockResolvedValue(null)
    expect(await h.service.validate(wake, h.agent)).toBe(false)
  })

  it('uses the authenticated publication result for a reviewer sharing the bot identity', async () => {
    const h = harness()
    vi.mocked(h.repo.admits).mockResolvedValue(false)
    const result = {
      provider,
      projectId: '123',
      mergeRequestIid: 12,
      attemptId: BINDING,
      headSha: SHA,
      state: 'submitted',
      event: 'REQUEST_CHANGES',
      verdict: 'fail'
    } as const
    await h.service.reviewPublished(ORG, AGENT, result as never, 'review-session')
    expect(h.repo.admits).not.toHaveBeenCalled()
    expect(h.enqueue).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        deliveryKey: `review:${BINDING}`,
        sourceAgentId: AGENT,
        sourceSessionId: 'review-session'
      })
    )
    h.enqueue.mockClear()
    await h.service.reviewPublished(ORG, AGENT, { ...result, state: 'not_submitted' } as never)
    expect(h.enqueue).not.toHaveBeenCalled()
  })
})

describe('a watched project’s events reach its follow-ups (assistant-mode.md §5.14)', () => {
  function harness(opts: { workspace?: boolean } = {}) {
    const agent = {
      id: AGENT,
      orgId: ORG,
      workspaceRepoId: opts.workspace === false ? 999n : 123n,
      workspace: { mode: 'git', isolation: 'session', credential: { provider: 'gitlab', access: 'write' } }
    } as AgentRecord
    const repo: FeedbackRepository = {
      bindingId: BINDING,
      orgId: ORG,
      repoId: 123n,
      repoFullName: 'example-org/example-repo',
      host: 'https://gitlab.example.test',
      signingKey: 'example-key',
      pulls: vi.fn(async () => [pull]),
      admits: vi.fn(async () => true)
    }
    const received: unknown[] = []
    const broadcast = vi.fn()
    const enqueue = vi.fn(async () => null)
    const service = new CodeHostFeedbackService({
      providers: [
        {
          provider: 'gitlab',
          pullNumber: () => 12,
          repositories: async () => [{ orgId: ORG, repoId: 123n }],
          repository: async () => repo
        }
      ],
      agents: { list: async () => [agent] },
      readBranch: async () => null,
      queue: { enqueueForOrg: enqueue } as unknown as SessionPullRequestFeedbackService,
      broadcast,
      followUps: () => ({
        receive: async (event) => {
          received.push(event)
        },
        repositoryWatched: async () => true
      })
    })
    const base = {
      provider: 'gitlab' as const,
      orgId: ORG,
      bindingId: BINDING,
      host: repo.host,
      repoId: '123',
      deliveryKey: 'delivery'
    }
    return { service, repo, received, broadcast, enqueue, base }
  }
  const object = (subject: 'pull' | 'issue', number: number) => ({
    orgId: ORG,
    provider: 'gitlab',
    bindingId: BINDING,
    repoId: 123n,
    subject,
    number
  })

  it('folds a wake-only event without resuming any session', async () => {
    const h = harness()
    const merged = {
      ...h.base,
      kind: 'event' as const,
      subject: 'pull' as const,
      event: 'merged' as const,
      pullNumber: 12,
      wakeOnly: true as const
    }
    expect(await h.service.receive(merged)).toEqual({ accepted: true, authorAgentIds: [] })
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.received).toEqual([
      { object: object('pull', 12), deliveryKey: 'delivery', kind: 'merged', feedback: false }
    ])
  })

  it('leaves a bound service account’s note on an issue out, as the lane does', async () => {
    const h = harness()
    vi.mocked(h.repo.admits).mockResolvedValue(false)
    const note = {
      ...h.base,
      kind: 'comment' as const,
      subject: 'issue' as const,
      event: 'comment' as const,
      pullNumber: 7,
      actorId: '9',
      wakeOnly: true as const
    }
    await h.service.receive(note)
    expect(h.received).toEqual([])
  })

  it('still resumes the opening session on feedback, and folds it as feedback', async () => {
    const h = harness()
    const comment = {
      ...h.base,
      kind: 'comment' as const,
      subject: 'pull' as const,
      event: 'comment' as const,
      pullNumber: 12,
      actorId: '7'
    }
    await h.service.receive(comment)
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.received).toEqual([
      { object: object('pull', 12), deliveryKey: 'delivery', kind: 'comment', feedback: true }
    ])
  })

  it('takes the merge request an event names to its watches, a fork’s included, where the lane takes none', async () => {
    const h = harness()
    vi.mocked(h.repo.pulls).mockResolvedValue([{ ...pull, sourceRepoId: 999n }])
    const comment = {
      ...h.base,
      kind: 'comment' as const,
      subject: 'pull' as const,
      event: 'comment' as const,
      pullNumber: 12,
      actorId: '7'
    }
    await h.service.receive(comment)
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.received).toEqual([
      { object: object('pull', 12), deliveryKey: 'delivery', kind: 'comment', feedback: true }
    ])
  })

  it('watches a project follow-ups watch, even with no writing workspace, and tells the relay to send its wakes', async () => {
    const h = harness({ workspace: false })
    await h.service.sync('gitlab', ORG, 123n)
    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gitlab',
        repoId: '123',
        watch: expect.objectContaining({ followUps: true })
      })
    )
  })
})
