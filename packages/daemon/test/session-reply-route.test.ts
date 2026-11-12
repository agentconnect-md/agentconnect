import { expect, it, vi } from 'vitest'
import { sessionReplyRoute, sessionWakeFields } from '../src/session/reply-route.js'
import type { SessionRecord } from '../src/store/local-store.js'

const session = (platform: string, transportScope?: string): SessionRecord => ({
  key: 'parent-key',
  agentId: 'parent',
  platform,
  channel: 'channel',
  thread: 'thread',
  transportScope,
  state: 'idle',
  acpSessionId: 'acp-parent',
  lastDeliveredTs: null,
  updatedAt: 1
})

it.each(['github', 'gitlab', 'gitea'])(
  'recognizes a legacy %s repository scope without looking up a chat integration',
  (provider) => {
    const lookup = vi.fn()
    expect(sessionReplyRoute(session('hook', `${provider}:123`), lookup)).toEqual({})
    expect(lookup).not.toHaveBeenCalled()
  }
)

it.each(['slack', 'telegram', 'dream', 'hook'])('keeps unknown %s transport scopes fail-closed', (platform) => {
  expect(sessionReplyRoute(session(platform, 'disconnected-account'), () => undefined)).toBeUndefined()
})

it('keeps the scoped chat integration and accepts an unscoped webhook', () => {
  expect(sessionReplyRoute(session('slack', 'account-1'), () => 'integration-1')).toEqual({
    integrationId: 'integration-1'
  })
  expect(sessionReplyRoute(session('hook'), () => undefined)).toEqual({})
})

it('wakes a single session where its latest turn replied, and a coordinator at the root', () => {
  const latest = { replyChannel: 'channel', replyThread: '300.1' }
  expect(sessionWakeFields({ ...session('slack'), thread: 'append:1000', ...latest })).toMatchObject({
    thread: '300.1',
    sessionThread: 'append:1000'
  })
  const coordinator = { ...session('slack'), thread: 'append:coordinator-1000', ...latest }
  const woken = sessionWakeFields(coordinator)
  expect(woken.thread).toBeUndefined()
  expect(woken).toMatchObject({ channel: 'channel', sessionThread: 'append:coordinator-1000' })
  // A wake that names its own target still lands there.
  expect(sessionWakeFields(coordinator, { replyChannel: 'channel', replyThread: '200.1' })).toMatchObject({
    thread: '200.1',
    sessionThread: 'append:coordinator-1000'
  })
})
