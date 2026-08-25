import { describe, expect, it } from 'vitest'
import {
  GithubHookMetadata,
  GithubReviewAuthorize,
  GitlabHookMetadata,
  HookStart,
  HOOK_REPORT_REASON_AGENT_HANDOVER,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED,
  HookConfigSnapshot,
  HookReport,
  buildEnvelope,
  decodeEnvelope,
  isGithubPullRequestRevisionEvent,
  isFrame
} from '../index.js'

const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const DAEMON_ID = '33333333-3333-4333-8333-333333333333'
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444'

const snapshot = {
  configRevision: '7',
  dispatchRevision: '9',
  dispatchDaemonId: DAEMON_ID,
  reviewPolicy: 'full' as const,
  reportingMode: 'check' as const,
  gateMode: 'informational' as const
}

const github = {
  repoId: '987654321',
  repoFullName: 'acme/infra',
  sourceInstallationId: '1234567',
  subjectKind: 'pull_request' as const,
  pullNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  reportSha: 'a'.repeat(40),
  headRepoFullName: 'alice/infra',
  mergeCommitSha: 'c'.repeat(40),
  isDraft: false,
  baseChanged: false
}

describe('R1/R2a hook control schemas', () => {
  it('requires an exact snapshot for action-time RPCs', () => {
    expect(HookConfigSnapshot.safeParse(snapshot).success).toBe(true)
    expect(HookConfigSnapshot.safeParse({ ...snapshot, dispatchRevision: undefined }).success).toBe(false)
    expect(HookConfigSnapshot.safeParse({ ...snapshot, configRevision: '-1' }).success).toBe(false)
  })

  it('validates trusted PR metadata without requiring a webhook-provided revision', () => {
    expect(GithubHookMetadata.safeParse(github).success).toBe(true)
    expect(
      GithubHookMetadata.safeParse({
        ...github,
        pullRequestReviewId: '3565283000',
        reviewCommentId: '3565656411',
        reviewThreadRootCommentId: '3565283658'
      }).success
    ).toBe(true)
    // PR issue_comment: number is trusted, but the daemon resolves head/base later.
    expect(
      GithubHookMetadata.safeParse({
        repoId: github.repoId,
        repoFullName: github.repoFullName,
        sourceInstallationId: github.sourceInstallationId,
        subjectKind: 'pull_request',
        pullNumber: 42,
        explicitReviewRequest: true
      }).success
    ).toBe(true)
    expect(GithubHookMetadata.safeParse({ ...github, pullNumber: undefined }).success).toBe(false)
    expect(GithubHookMetadata.safeParse({ ...github, headSha: undefined }).success).toBe(false)
    expect(GithubHookMetadata.safeParse({ ...github, reportSha: 'test-merge-sha' }).success).toBe(false)
    expect(GithubHookMetadata.safeParse({ ...github, pullRequestReviewId: '0' }).success).toBe(false)
    expect(GithubHookMetadata.safeParse({ ...github, reviewCommentId: '-1' }).success).toBe(false)
    expect(GithubHookMetadata.safeParse({ ...github, reviewThreadRootCommentId: '01' }).success).toBe(false)
  })

  it('distinguishes target-branch changes from content-only PR edits', () => {
    expect(isGithubPullRequestRevisionEvent('pull_request:opened')).toBe(true)
    expect(isGithubPullRequestRevisionEvent('pull_request:synchronize')).toBe(true)
    expect(isGithubPullRequestRevisionEvent('pull_request:edited', { baseChanged: true })).toBe(true)
    expect(isGithubPullRequestRevisionEvent('pull_request:edited', { baseChanged: false })).toBe(false)
  })

  it('keeps legacy hook/report decodable while carrying submitted metadata for recovery', () => {
    expect(
      HookReport.safeParse({
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-1',
        status: 'success'
      }).success
    ).toBe(true)
    expect(
      HookReport.safeParse({
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-2',
        event: 'pull_request:synchronize',
        github,
        ...snapshot,
        status: 'success',
        publishedComment: { kind: 'issue_comment', commentId: '5199581711' }
      }).success
    ).toBe(true)
    expect(
      HookReport.safeParse({
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-3',
        status: 'success',
        reviewAttemptId: ATTEMPT_ID,
        reviewResult: {
          state: 'submitted',
          reviewId: '9007199254740993',
          event: 'APPROVE',
          verdict: 'pass',
          commitId: github.headSha
        },
        publishedComment: { kind: 'issue_comment', commentId: '5199581711' }
      }).success
    ).toBe(false)
    expect(
      HookReport.safeParse({
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-1',
        event: 'pull_request:synchronize',
        github,
        ...snapshot,
        status: 'success',
        reviewAttemptId: ATTEMPT_ID,
        reviewResult: {
          state: 'submitted',
          reviewId: '9007199254740993',
          event: 'APPROVE',
          verdict: 'pass',
          commitId: github.headSha
        }
      }).success
    ).toBe(true)
    expect(
      HookReport.safeParse({
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-1',
        status: 'success',
        reviewAttemptId: ATTEMPT_ID
      }).success
    ).toBe(false)
  })

  it('accepts the normalized provider quota failure reason', () => {
    expect(HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED).toBe('provider_quota_exhausted')
    expect(HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED).toBe('provider_auth_required')
    expect(
      HookReport.safeParse({
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-1',
        status: 'failed',
        reason: HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
      }).success
    ).toBe(true)
  })

  it('accepts the normalized infrastructure-interruption reason', () => {
    expect(HOOK_REPORT_REASON_AGENT_HANDOVER).toBe('agent_handover')
    expect(
      HookReport.safeParse({
        hookId: HOOK_ID,
        agentId: AGENT_ID,
        deliveryKey: 'delivery-1',
        status: 'failed',
        sessionId: 'acp-1',
        durationMs: 90_000,
        reason: HOOK_REPORT_REASON_AGENT_HANDOVER
      }).success
    ).toBe(true)
  })

  it('round-trips hook/start and all formal-review correlated requests', () => {
    const start = buildEnvelope('hook/start', {
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      deliveryKey: 'delivery-1',
      sessionId: 'session/with space',
      event: 'pull_request:synchronize',
      github,
      ...snapshot
    })
    const decodedStart = decodeEnvelope(JSON.stringify(start))
    expect(decodedStart.ok).toBe(true)
    if (!decodedStart.ok || !isFrame('hook/start')(decodedStart.frame)) throw new Error('expected hook/start')
    expect(decodedStart.frame.payload.sessionId).toBe('session/with space')
    expect(decodedStart.frame.payload.github?.reportSha).toBe(github.headSha)

    const startOk = decodeEnvelope(
      JSON.stringify(buildEnvelope('hook/start/ok', { accepted: true }, { corr: start.id }))
    )
    expect(startOk.ok).toBe(true)

    const auth = buildEnvelope('github/review-authorize', {
      hookId: HOOK_ID,
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT_ID,
      requestedEvent: 'APPROVE',
      requestedVerdict: 'pass',
      snapshot
    })
    expect(decodeEnvelope(JSON.stringify(auth)).ok).toBe(true)
    expect(
      decodeEnvelope(
        JSON.stringify(
          buildEnvelope(
            'github/review-authorized',
            {
              attemptId: ATTEMPT_ID,
              token: 'ghs_secret',
              ttlSec: 3600,
              expiresAt: '2026-07-11T12:00:00.000Z',
              repoId: github.repoId,
              repoFullName: github.repoFullName,
              pullNumber: github.pullNumber,
              expectedHeadSha: github.headSha,
              expectedBaseSha: github.baseSha
            },
            { corr: auth.id }
          )
        )
      ).ok
    ).toBe(true)

    const result = buildEnvelope('github/review-result', {
      hookId: HOOK_ID,
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT_ID,
      snapshot,
      result: {
        state: 'submitted',
        reviewId: '1234567890123456789',
        event: 'APPROVE',
        verdict: 'pass',
        commitId: github.headSha
      }
    })
    expect(decodeEnvelope(JSON.stringify(result)).ok).toBe(true)
    expect(
      decodeEnvelope(JSON.stringify(buildEnvelope('github/review-result/ok', { accepted: true }, { corr: result.id })))
        .ok
    ).toBe(true)
  })

  it('requires the requested verdict in the review authorization fence', () => {
    const base = {
      hookId: HOOK_ID,
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT_ID,
      requestedEvent: 'COMMENT',
      requestedVerdict: 'neutral',
      snapshot
    }
    expect(GithubReviewAuthorize.safeParse(base).success).toBe(true)
    expect(GithubReviewAuthorize.safeParse({ ...base, requestedVerdict: undefined }).success).toBe(false)
  })
})

const gitlab = {
  projectId: '4455667',
  projectPath: 'example-group/sub/example-project',
  webhookId: '9001',
  target: { kind: 'merge_request' as const, iid: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }
}

describe('code-host M0 shapes (gitlab-com-integration.md §17.2)', () => {
  it('validates GitLab subject metadata across all three targets', () => {
    expect(GitlabHookMetadata.safeParse(gitlab).success).toBe(true)
    expect(GitlabHookMetadata.safeParse({ ...gitlab, target: { kind: 'issue', iid: 12 } }).success).toBe(true)
    expect(GitlabHookMetadata.safeParse({ ...gitlab, target: { kind: 'push', ref: 'refs/heads/main' } }).success).toBe(
      true
    )
    // Missing subject identity is rejected before a session key could be derived from it.
    expect(GitlabHookMetadata.safeParse({ ...gitlab, target: { kind: 'issue' } }).success).toBe(false)
    expect(GitlabHookMetadata.safeParse({ ...gitlab, target: { kind: 'push', ref: '' } }).success).toBe(false)
    expect(GitlabHookMetadata.safeParse({ ...gitlab, projectId: 'example/project' }).success).toBe(false)
  })

  it('keeps hook/start a provider one-of and existing github senders valid', () => {
    const base = { hookId: HOOK_ID, agentId: AGENT_ID, deliveryKey: 'delivery-1', ...snapshot }
    expect(HookStart.safeParse({ ...base, github }).success).toBe(true)
    expect(HookStart.safeParse({ ...base, gitlab }).success).toBe(true)
    expect(HookStart.safeParse(base).success).toBe(false)
    expect(HookStart.safeParse({ ...base, github, gitlab }).success).toBe(false)
  })

  it('round-trips a gitlab hook/start and its correlated barrier reply', () => {
    const start = buildEnvelope('hook/start', {
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      deliveryKey: 'delivery-1',
      sessionId: 'acp-gitlab-1',
      event: 'merge_request:update',
      gitlab,
      ...snapshot
    })
    const decoded = decodeEnvelope(JSON.stringify(start))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('hook/start')(decoded.frame)) throw new Error('expected hook/start')
    // The trusted subject discriminator survives the wire: the head the CP fences reviews on.
    expect(decoded.frame.payload.github).toBeUndefined()
    expect(decoded.frame.payload.gitlab?.projectId).toBe(gitlab.projectId)
    const target = decoded.frame.payload.gitlab?.target
    expect(target?.kind === 'merge_request' ? target.headSha : undefined).toBe('a'.repeat(40))
    expect(
      decodeEnvelope(JSON.stringify(buildEnvelope('hook/start/ok', { accepted: true }, { corr: start.id }))).ok
    ).toBe(true)
  })

  it('accepts gitlab metadata and a provider-neutral published output on hook/report', () => {
    const base = { hookId: HOOK_ID, agentId: AGENT_ID, deliveryKey: 'delivery-1', status: 'success' as const }
    const note = { provider: 'gitlab', kind: 'note', externalId: '123456' }
    expect(HookReport.safeParse({ ...base, gitlab, publishedOutput: note }).success).toBe(true)
    // The provider members and the two published-output shapes are mutually exclusive.
    expect(HookReport.safeParse({ ...base, github, gitlab }).success).toBe(false)
    expect(
      HookReport.safeParse({
        ...base,
        github,
        publishedComment: { kind: 'issue_comment', commentId: '77' },
        publishedOutput: note
      }).success
    ).toBe(false)
    // A submitted formal review still excludes any fallback output.
    expect(
      HookReport.safeParse({
        ...base,
        gitlab,
        reviewAttemptId: ATTEMPT_ID,
        reviewResult: { state: 'submitted', reviewId: 'r1', event: 'COMMENT', verdict: 'pass', commitId: 'c1' },
        publishedOutput: note
      }).success
    ).toBe(false)
  })
})
