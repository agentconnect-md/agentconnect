import { describe, expect, it } from 'vitest'
import {
  AssistantFollowUpWake,
  AssistantFollowUpWatchReq,
  isFollowUpStateEvent,
  parseFollowUpWatchUrl
} from './follow-up-watch.js'
import { RcPullRequestFeedback } from './relay-cp.js'

describe('parseFollowUpWatchUrl', () => {
  it.each([
    [
      'https://github.com/example-org/example-repo/pull/12',
      'github',
      'github.com',
      'example-org/example-repo',
      'pull',
      12
    ],
    [
      'https://www.github.com/example-org/example-repo/pull/12/files#diff',
      'github',
      'github.com',
      'example-org/example-repo',
      'pull',
      12
    ],
    [
      'https://github.com/example-org/example-repo/issues/7?x=1',
      'github',
      'github.com',
      'example-org/example-repo',
      'issue',
      7
    ],
    [
      'https://gitlab.example.test/group/sub/project/-/merge_requests/3',
      'gitlab',
      'gitlab.example.test',
      'group/sub/project',
      'pull',
      3
    ],
    [
      'https://gitlab.example.test:8443/group/project/-/issues/9/',
      'gitlab',
      'gitlab.example.test:8443',
      'group/project',
      'issue',
      9
    ]
  ])('parses %s', (url, provider, host, repoPath, subject, number) => {
    expect(parseFollowUpWatchUrl(url)).toEqual({ target: { provider, host, repoPath, subject, number } })
  })

  it.each([
    'not a url',
    'ftp://github.com/example-org/example-repo/pull/12',
    'https://github.com/example-org/example-repo',
    'https://github.com/example-org/example-repo/actions/runs/5',
    'https://github.com/example-org/example-repo/pull/0',
    'https://gitlab.example.test/group/project/-/pipelines/4'
  ])('refuses %s with a reason', (url) => {
    expect(parseFollowUpWatchUrl(url)).toEqual({ error: expect.any(String) })
  })
})

describe('event wake frames', () => {
  it('counts the changes of state apart from discussion', () => {
    expect(
      ['merged', 'closed', 'reopened', 'approved', 'changes_requested', 'checks'].every((kind) =>
        isFollowUpStateEvent(kind as never)
      )
    ).toBe(true)
    expect(['comment', 'review', 'commits'].some((kind) => isFollowUpStateEvent(kind as never))).toBe(false)
  })

  it('requires a target for every set or full watch', () => {
    const agentId = '11111111-1111-4111-8111-111111111111'
    expect(
      AssistantFollowUpWatchReq.safeParse({ agentId, mode: 'remove', watches: [{ followUpId: 'f1' }] }).success
    ).toBe(true)
    expect(AssistantFollowUpWatchReq.safeParse({ agentId, mode: 'set', watches: [{ followUpId: 'f1' }] }).success).toBe(
      false
    )
  })

  it('requires a wake to name its events, unless it is an ended notice', () => {
    const base = { agentId: '11111111-1111-4111-8111-111111111111', followUpId: 'f1', wakeId: 1 }
    expect(
      AssistantFollowUpWake.safeParse({ ...base, kinds: ['merged'], latestAt: '2026-10-17T00:00:00.000Z' }).success
    ).toBe(true)
    expect(AssistantFollowUpWake.safeParse({ ...base, kinds: [], ended: 'access_lost' }).success).toBe(true)
    expect(AssistantFollowUpWake.safeParse({ ...base, kinds: [] }).success).toBe(false)
  })

  it('keeps an issue signal wake-only', () => {
    const signal = {
      deliveryKey: 'd1',
      installationId: '1',
      repoId: '2',
      repoFullName: 'example-org/example-repo',
      pullNumber: 7,
      subject: 'issue',
      event: 'closed'
    }
    expect(RcPullRequestFeedback.safeParse(signal).success).toBe(false)
    expect(RcPullRequestFeedback.safeParse({ ...signal, wakeOnly: true }).success).toBe(true)
  })
})
