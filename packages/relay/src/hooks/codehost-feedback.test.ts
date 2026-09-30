import { createHmac } from 'node:crypto'
import Fastify from 'fastify'
import { FakeClock } from '@agentconnect.md/connection'
import type { RcCodeHostFeedbackResult, RcHookAssign } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { HookTable } from './hook-table.js'
import { HookRateLimiter } from './rate-limit.js'
import { registerGitlabIngress } from './gitlab-ingress.js'
import { registerGiteaIngress } from './gitea/ingress.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const BINDING = '22222222-2222-4222-8222-222222222222'
const KEY = Buffer.alloc(32, 42)
const SHA = 'a'.repeat(40)

describe.each(['gitlab', 'gitea'] as const)('%s feedback ingress', (provider) => {
  function harness() {
    const clock = new FakeClock(1_780_000_000_000)
    const table = new HookTable()
    const signingKey = provider === 'gitlab' ? `whsec_${KEY.toString('base64')}` : KEY.toString('hex')
    table.feedbackWatch({
      provider,
      repoId: '123',
      watch: {
        orgId: 'example-org',
        bindingId: BINDING,
        host: `https://${provider}.example.test`,
        signingKey
      }
    })
    const reportFeedback = vi.fn<(...args: unknown[]) => Promise<RcCodeHostFeedbackResult>>(async () => ({
      accepted: true,
      authorAgentIds: []
    }))
    const sendMsg = vi.fn(async () => ({ msgId: 'delivery', accepted: true }))
    const app = Fastify()
    const deps = {
      clock,
      table,
      reportFeedback,
      daemons: () => ({ get: () => ({ supports: () => true, sendMsg }) }) as never,
      report: vi.fn(),
      authorizeMembership: vi.fn(async () => true),
      authzLimiter: new HookRateLimiter(clock),
      limiter: new HookRateLimiter(clock),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    }
    if (provider === 'gitlab') registerGitlabIngress(app, deps)
    else registerGiteaIngress(app, deps)
    const comment =
      provider === 'gitlab'
        ? {
            object_kind: 'note',
            project: { id: 123 },
            user: { id: 7, username: 'reviewer' },
            object_attributes: {
              id: 90,
              noteable_type: 'MergeRequest',
              action: 'create',
              note: 'Please fix the race.',
              system: false
            },
            merge_request: {
              iid: 12,
              author_id: 8,
              source_project_id: 123,
              target_project_id: 123,
              last_commit: { id: SHA }
            }
          }
        : {
            repository: { id: 123, full_name: 'example-org/example-repo' },
            sender: { id: 7, login: 'reviewer' },
            action: 'created',
            is_pull: true,
            comment: { id: 90, body: 'Please fix the race.' },
            pull_request: {
              number: 12,
              user: { id: 8, login: 'author' },
              head: { sha: SHA, ref: 'feature', repo_id: 123 },
              base: { repo_id: 123 }
            },
            issue: { number: 12, user: { id: 8, login: 'author' } }
          }
    const post = (payload: unknown = comment, event = 'pull_request_comment', bad = false) => {
      const body = JSON.stringify(payload)
      const delivery = 'example-delivery'
      const timestamp = String(clock.now() / 1000)
      const headers =
        provider === 'gitlab'
          ? {
              'webhook-id': delivery,
              'webhook-timestamp': timestamp,
              'webhook-signature': `v1,${createHmac('sha256', bad ? Buffer.alloc(32) : KEY)
                .update(`${delivery}.${timestamp}.${body}`)
                .digest('base64')}`
            }
          : {
              'x-gitea-delivery': delivery,
              'x-gitea-event-type': event,
              'x-gitea-signature': createHmac('sha256', bad ? 'bad' : signingKey)
                .update(body)
                .digest('hex')
            }
      return app.inject({
        method: 'POST',
        url: `/webhooks/${provider}`,
        payload: body,
        headers: { 'content-type': 'application/json', ...headers }
      })
    }
    const rule: RcHookAssign = {
      hookId: BINDING,
      kind: provider,
      agentId: AGENT,
      daemonId: AGENT,
      sessionMode: 'perThread',
      configRevision: '1',
      dispatchRevision: '1',
      dispatchDaemonId: AGENT,
      reviewPolicy: 'off',
      reportingMode: 'off',
      gateMode: 'informational',
      ...(provider === 'gitlab'
        ? {
            gitlab: {
              projectId: '123',
              projectPath: 'example-org/example-repo',
              sessionKeyPrefix: 'gitlab:123',
              events: ['merge_request:*'],
              mentionOnly: false,
              commentFamilies: ['merge_request' as const],
              serviceAccountUserId: '99',
              serviceAccountUsername: 'example-bot',
              signingToken: signingKey
            }
          }
        : {
            gitea: {
              repoId: '123',
              repoPath: 'example-org/example-repo',
              sessionKeyPrefix: 'gitea:123',
              events: ['merge_request:*'],
              mentionOnly: false,
              commentFamilies: ['pull_request' as const],
              botUserId: '99',
              botUsername: 'example-bot',
              signingKey
            }
          })
    }
    return { app, table, reportFeedback, sendMsg, comment, post, rule }
  }

  it('accepts a signed comment with no trigger and sends only coordinates', async () => {
    const h = harness()
    try {
      expect((await h.post()).statusCode).toBe(202)
      expect(h.reportFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          bindingId: BINDING,
          repoId: '123',
          pullNumber: 12,
          actorId: '7',
          kind: 'comment'
        })
      )
      expect(JSON.stringify(h.reportFeedback.mock.calls)).not.toContain('Please fix')
      expect(h.sendMsg).not.toHaveBeenCalled()
      h.reportFeedback.mockClear()
      expect((await h.post(h.comment, 'issue_comment', true)).statusCode).toBe(404)
      expect(h.reportFeedback).not.toHaveBeenCalled()
    } finally {
      await h.app.close()
    }
  })

  it('retries a persistence failure and suppresses a second author turn from an ordinary trigger', async () => {
    const h = harness()
    try {
      h.table.upsert(h.rule)
      expect((await h.post()).statusCode).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.sendMsg).toHaveBeenCalledOnce()
      h.sendMsg.mockClear()
      h.reportFeedback.mockResolvedValue({ accepted: true, authorAgentIds: [AGENT] })
      expect((await h.post()).statusCode).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.sendMsg).not.toHaveBeenCalled()
      h.reportFeedback.mockRejectedValue(new Error('unavailable'))
      expect((await h.post()).statusCode).toBe(503)
    } finally {
      await h.app.close()
    }
  })

  it('extracts a failed CI head without turning it into a review trigger', async () => {
    const h = harness()
    try {
      const payload =
        provider === 'gitlab'
          ? { object_kind: 'pipeline', project: { id: 123 }, object_attributes: { status: 'failed', sha: SHA } }
          : { repository: { id: 123 }, state: 'failure', sha: SHA, context: 'ci/test' }
      expect((await h.post(payload, 'status')).statusCode).toBe(202)
      expect(h.reportFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci', headSha: SHA }))
      expect(h.sendMsg).not.toHaveBeenCalled()
      h.reportFeedback.mockClear()
      const withoutSha =
        provider === 'gitlab'
          ? { ...payload, object_attributes: { status: 'failed' }, merge_request: { iid: 12 } }
          : { ...payload, sha: undefined, pull_request: { number: 12 } }
      expect((await h.post(withoutSha, 'status')).statusCode).toBe(202)
      expect(h.reportFeedback).not.toHaveBeenCalled()
    } finally {
      await h.app.close()
    }
  })
})
