/**
 * GitLab hook normalization (gitlab-com-integration.md §12.3, daemon side):
 * the session key is RECOMPUTED from the trusted `gitlab` discriminator (never
 * colon-split), the transport scope pins the immutable project id, the excerpt
 * rides inside the GitLab untrusted fence, and merged/closed lifecycle events
 * map to the shared worktree-cleanup family.
 */
import { describe, it, expect } from 'vitest'
import type { RdMsgHook } from '@agentconnect.md/protocol'
import {
  buildHookMessage,
  buildHookText,
  gitlabSessionThread,
  hookAnchorText,
  UNTRUSTED_CONTENT_BEGIN_GITLAB,
  UNTRUSTED_CONTENT_END
} from '../src/messages/hook-message.js'
import { githubThreadWorktreeCleanup } from '../src/github/hook-coords.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PROJECT = '4455667'

function fire(overrides: Partial<RdMsgHook> = {}): RdMsgHook {
  return {
    source: 'hook',
    agentId: AGENT,
    sessionKey: `gitlab:${PROJECT}:issue:42`,
    msgId: `${HOOK}:msg_delivery_1`,
    hookId: HOOK,
    deliveryKey: 'msg_delivery_1',
    firedAt: '2026-08-22T00:00:00.000Z',
    event: 'issues:opened',
    gitlab: {
      projectId: PROJECT,
      projectPath: 'example-group/example-project',
      target: { kind: 'issue', iid: 42 }
    },
    context: {
      source: 'gitlab',
      event: 'issues',
      action: 'opened',
      repo: 'example-group/example-project',
      number: 42,
      title: 'db down',
      senderLogin: 'alice',
      labels: ['bug'],
      htmlUrl: 'https://gitlab.com/example-group/example-project/-/issues/42',
      bodyExcerpt: 'the primary is unreachable',
      truncated: false
    },
    ...overrides
  }
}

describe('gitlab hook normalization (§12.3)', () => {
  it('recomputes the thread from trusted metadata: channel = hookId, thread = full key, scope pinned', () => {
    const msg = buildHookMessage(fire(), 'trace-1')
    expect(msg.channel).toBe(HOOK)
    expect(msg.thread).toBe(`gitlab:${PROJECT}:issue:42`)
    expect(msg.transportScope).toBe(`gitlab:${PROJECT}`)
    expect(msg.platform).toBe('hook')
    expect(msg.headless).toBe(true)
    expect(msg.threadUrl).toBe('https://gitlab.com/example-group/example-project/-/issues/42')
    expect(msg.sender.id).toBe('alice')
    expect(msg.initialSessionTitle).toBe('Issue example-group/example-project#42: db down')
  })

  it('trusted metadata wins over a divergent sessionKey string — the key is never parsed', () => {
    const msg = buildHookMessage(fire({ sessionKey: 'gitlab:999:issue:1#evil' }), 'trace-2')
    expect(msg.channel).toBe(HOOK)
    expect(msg.thread).toBe(`gitlab:${PROJECT}:issue:42`)
  })

  it('subjects are disjoint by kind, iid, project, and ref; deliveries for one subject share a key', () => {
    const issue = gitlabSessionThread({ projectId: PROJECT, projectPath: 'p', target: { kind: 'issue', iid: 7 } })
    const mr = gitlabSessionThread({ projectId: PROJECT, projectPath: 'p', target: { kind: 'merge_request', iid: 7 } })
    const otherIid = gitlabSessionThread({ projectId: PROJECT, projectPath: 'p', target: { kind: 'issue', iid: 8 } })
    const otherProject = gitlabSessionThread({ projectId: '999', projectPath: 'p', target: { kind: 'issue', iid: 7 } })
    const push = gitlabSessionThread({
      projectId: PROJECT,
      projectPath: 'p',
      target: { kind: 'push', ref: 'refs/heads/main' }
    })
    expect(new Set([issue, mr, otherIid, otherProject, push]).size).toBe(5)
    // A renamed project changes projectPath but never the key.
    expect(
      gitlabSessionThread({ projectId: PROJECT, projectPath: 'renamed/path', target: { kind: 'issue', iid: 7 } })
    ).toBe(issue)
  })

  it('fences the excerpt in the GitLab untrusted boundary with the trusted header outside', () => {
    const text = buildHookText(fire())
    expect(text).toContain('GitLab issues:opened — example-group/example-project#42 "db down"')
    expect(text).toContain('From: alice · labels: bug')
    expect(text).toContain(UNTRUSTED_CONTENT_BEGIN_GITLAB)
    expect(text).toContain(UNTRUSTED_CONTENT_END)
    expect(text.indexOf(UNTRUSTED_CONTENT_BEGIN_GITLAB)).toBeLessThan(text.indexOf('the primary is unreachable'))
    // No posting promise before the M5 output surface exists.
    expect(text).not.toContain('posts')
  })

  it('renders MR references with ! and surfaces revision facts on the trusted header', () => {
    const msg = fire({
      sessionKey: `gitlab:${PROJECT}:merge_request:77`,
      event: 'merge_request:synchronize',
      gitlab: {
        projectId: PROJECT,
        projectPath: 'example-group/example-project',
        target: { kind: 'merge_request', iid: 77, headSha: 'a'.repeat(40), isDraft: true }
      },
      context: {
        source: 'gitlab',
        event: 'merge_request',
        action: 'synchronize',
        number: 77,
        title: 'tighten retry',
        senderLogin: 'alice',
        truncated: false
      }
    })
    const text = buildHookText(msg)
    expect(text).toContain('example-group/example-project!77')
    expect(text).toContain(`Head SHA: ${'a'.repeat(40)}`)
    expect(text).toContain('Draft: true')
    expect(buildHookMessage(msg, 't').initialSessionTitle).toBe('MR example-group/example-project!77: tighten retry')
    expect(hookAnchorText(msg)).toContain('merge_request:synchronize — example-group/example-project!77')
  })

  it('maps merged MRs and closed issues to the shared worktree-cleanup family, fenced on metadata', () => {
    const gitlab = { projectId: PROJECT, projectPath: 'p', target: { kind: 'merge_request' as const, iid: 77 } }
    expect(githubThreadWorktreeCleanup({ event: 'merge_request:merged', gitlab })).toBe('pull_request_merged')
    expect(
      githubThreadWorktreeCleanup({
        event: 'issues:closed',
        gitlab: { ...gitlab, target: { kind: 'issue', iid: 42 } }
      })
    ).toBe('issue_closed')
    // The event alone never authorizes maintenance (a malformed frame must run
    // as an ordinary hook, not silently delete a checkout).
    expect(githubThreadWorktreeCleanup({ event: 'merge_request:merged' })).toBeUndefined()
    expect(githubThreadWorktreeCleanup({ event: 'issues:closed', gitlab })).toBeUndefined()
  })
})
