import { describe, expect, it, vi } from 'vitest'
import type { SessionPullRequestFeedback } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

describe('pull request feedback continuation', () => {
  it('reopens the exact GitHub issue session as a durable headless turn', async () => {
    const daemon = new Daemon({ sandboxMechanism: null } as never)
    const key = sessionKey('hook', 'github:issue:850', 'github:issue:850', AGENT_ID)
    const session = {
      key,
      agentId: AGENT_ID,
      acpSessionId: 'acp-session-850',
      outwardSessionId: SESSION_ID,
      platform: 'hook',
      channel: 'github:issue:850',
      thread: 'github:issue:850',
      transportScope: null,
      conversationKind: 'channel',
      externalProvider: 'github',
      externalRealmKey: 'github.com',
      externalResourceKind: 'repository',
      externalResourceKey: '456'
    } as unknown as SessionRecord
    const inner = daemon as never as {
      agents: Map<string, unknown>
      store: { getSessionByOutwardId: (sessionId: string, agentId: string) => Promise<SessionRecord | undefined> }
      dispatch: ReturnType<typeof vi.fn>
      webchatTransport: { webchatWakeContext: (platform: string, channel: string) => unknown }
      dispatchPullRequestFeedback: (req: SessionPullRequestFeedback) => Promise<unknown>
    }
    inner.agents.set(AGENT_ID, { id: AGENT_ID })
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
      repoFullName: 'acme/infra',
      pullNumber: 1465,
      event: 'issue_comment:created',
      kind: 'comment'
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
      conversationContinuation: true,
      externalOrigin: {
        provider: 'github',
        realmKey: 'github.com',
        resourceKind: 'repository',
        resourceKey: '456'
      }
    })
    expect(options).toMatchObject({ requireDurable: true, deliveryId: 'pr-feedback:delivery-review-1' })
  })
})
