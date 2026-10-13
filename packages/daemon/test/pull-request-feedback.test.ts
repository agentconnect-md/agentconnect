import { describe, expect, it, vi } from 'vitest'
import type { SessionPullRequestFeedback } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

describe('pull request feedback continuation', () => {
  it.each(['github', 'gitlab', 'gitea'] as const)(
    'reopens the exact author session for %s as a durable headless turn',
    async (provider) => {
      const daemon = new Daemon({ sandboxMechanism: null } as never)
      const channel = `${provider}:issue:850`
      const host = `https://${provider}.example.test`
      const key = sessionKey('hook', channel, channel, AGENT_ID)
      const session = {
        key,
        agentId: AGENT_ID,
        acpSessionId: 'acp-session-850',
        outwardSessionId: SESSION_ID,
        platform: 'hook',
        channel,
        thread: channel,
        transportScope: null,
        conversationKind: 'channel',
        externalProvider: provider,
        externalRealmKey: provider === 'github' ? 'github.com' : host,
        externalResourceKind: 'repository',
        externalResourceKey: '456'
      } as unknown as SessionRecord
      const inner = daemon as never as {
        agents: Map<string, unknown>
        managedWorkspaceRepo: (agentId: string) => { provider: string; repoId: string }
        store: { getSessionByOutwardId: (sessionId: string, agentId: string) => Promise<SessionRecord | undefined> }
        dispatch: ReturnType<typeof vi.fn>
        webchatTransport: { webchatWakeContext: (platform: string, channel: string) => unknown }
        dispatchPullRequestFeedback: (req: SessionPullRequestFeedback) => Promise<unknown>
      }
      inner.agents.set(AGENT_ID, { id: AGENT_ID, gitlabHost: host, giteaHost: host })
      vi.spyOn(inner, 'managedWorkspaceRepo').mockReturnValue({ provider, repoId: '456' })
      inner.store = { getSessionByOutwardId: vi.fn(async () => session) }
      inner.dispatch = vi.fn(async (...args: unknown[]) => {
        const opts = args[5] as { onAdmission: (result: { accepted: boolean }) => void }
        opts.onAdmission({ accepted: true })
        return SESSION_ID
      })
      vi.spyOn(inner.webchatTransport, 'webchatWakeContext').mockReturnValue(undefined)
      const request: SessionPullRequestFeedback = {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        deliveryKey: 'delivery-review-1',
        repoId: '456',
        repoFullName: 'example-org/example-repo',
        ...(provider !== 'github' ? { provider, host } : {}),
        pullNumber: 1465
      }

      await expect(inner.dispatchPullRequestFeedback(request)).resolves.toEqual({
        deliveryKey: request.deliveryKey,
        accepted: true
      })
      expect(inner.dispatch).toHaveBeenCalledTimes(1)
      const [agentId, message, integrationId, , callMeta, options] = inner.dispatch.mock.calls[0]!
      expect(agentId).toBe(AGENT_ID)
      expect(integrationId).toBeUndefined()
      expect(message).toMatchObject({
        source: 'system',
        platform: 'hook',
        channel: session.channel,
        thread: session.thread,
        headless: true
      })
      expect(callMeta).toMatchObject({
        callFrom: AGENT_ID,
        conversationContinuation: true
      })
      if (provider === 'github') {
        expect(callMeta).toMatchObject({
          externalOrigin: { provider, realmKey: 'github.com', resourceKind: 'repository', resourceKey: '456' }
        })
      }
      expect(options).toMatchObject({
        requireDurable: true,
        deliveryId:
          provider === 'github' ? 'pr-feedback:delivery-review-1' : `pr-feedback:${provider}:456:1465:delivery-review-1`
      })
      if (provider !== 'github') {
        await expect(
          inner.dispatchPullRequestFeedback({ ...request, host: 'https://other.example.test' })
        ).resolves.toMatchObject({ accepted: false, reason: 'not_found' })
        expect(inner.dispatch).toHaveBeenCalledTimes(1)
      }
    }
  )
})

describe('pull request feedback in a direct message that is one long session', () => {
  /** The message the feedback dispatches into a Slack DM session at `thread` that recorded `replyThread`. */
  async function feedbackInto(thread: string, replyThread: string | null) {
    const daemon = new Daemon({ sandboxMechanism: null } as never)
    const session = {
      key: sessionKey('slack', 'D-ADA', thread, AGENT_ID),
      agentId: AGENT_ID,
      acpSessionId: 'acp-session-850',
      sessionId: SESSION_ID,
      platform: 'slack',
      channel: 'D-ADA',
      thread,
      transportScope: null,
      conversationKind: 'dm',
      replyThread
    } as unknown as SessionRecord
    const inner = daemon as never as {
      agents: Map<string, unknown>
      connByIntegration: Map<string, unknown>
      store: { getSessionByOutwardId: (sessionId: string, agentId: string) => Promise<SessionRecord | undefined> }
      dispatch: ReturnType<typeof vi.fn>
      dispatchPullRequestFeedback: (req: SessionPullRequestFeedback) => Promise<unknown>
    }
    inner.agents.set(AGENT_ID, { id: AGENT_ID, integrations: [{ id: 'int-s', platform: 'slack' }] })
    inner.connByIntegration.set('int-s', { postMessage: vi.fn() })
    inner.store = { getSessionByOutwardId: vi.fn(async () => session) }
    inner.dispatch = vi.fn(async (...args: unknown[]) => {
      ;(args[5] as { onAdmission: (result: { accepted: boolean }) => void }).onAdmission({ accepted: true })
      return SESSION_ID
    })
    await expect(
      inner.dispatchPullRequestFeedback({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        deliveryKey: 'delivery-review-2',
        repoId: '456',
        repoFullName: 'example-org/example-repo',
        pullNumber: 1466
      })
    ).resolves.toEqual({ deliveryKey: 'delivery-review-2', accepted: true })
    const [, message, integrationId] = inner.dispatch.mock.calls[0]! as [string, NormalizedMessage, string]
    expect(integrationId).toBe('int-s')
    expect(message).toMatchObject({ source: 'system', platform: 'slack', channel: 'D-ADA', isDm: true })
    return message
  }

  it('replies under the message the session last replied under', async () => {
    const message = await feedbackInto('append:1000', '1700.0001')
    expect(message).toMatchObject({ thread: '1700.0001', sessionThread: 'append:1000' })
  })

  it('stays at the top level when the session last replied there', async () => {
    const message = await feedbackInto('append:1000', null)
    expect(message.thread).toBeUndefined()
    expect(message.sessionThread).toBe('append:1000')
  })

  it('replies in a per-thread session’s own thread, as before', async () => {
    const message = await feedbackInto('1700.0001', null)
    expect(message.thread).toBe('1700.0001')
    expect(message.sessionThread).toBeUndefined()
  })
})
