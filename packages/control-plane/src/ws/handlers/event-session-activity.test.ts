import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleSessionActivity } from './event-session-activity.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function activityFrame(): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-27T00:00:00.000Z',
    type: 'event/session-activity',
    payload: {
      sessionId: 'session-407',
      agentId: AGENT_ID,
      revision: '12',
      ts: '2026-07-27T00:00:00.000Z'
    }
  }
}

describe('handleSessionActivity', () => {
  it('publishes only after verifying the agent is placed on the reporting daemon', async () => {
    const publishActivity = vi.fn()
    const release = vi.fn()
    const deps = {
      agent: { get: vi.fn().mockResolvedValue({ daemonId: DAEMON_ID }) },
      agentMutations: { tryBeginMutation: vi.fn(() => release) },
      events: { publishActivity }
    } as unknown as DaemonWsDeps
    const frame = activityFrame()

    await handleSessionActivity(frame, { daemonId: DAEMON_ID } as DaemonConnection, deps)

    expect(publishActivity).toHaveBeenCalledWith(DAEMON_ID, frame.payload)
    expect(release).toHaveBeenCalledOnce()
  })

  it('drops activity from a daemon that does not own the agent', async () => {
    const publishActivity = vi.fn()
    const deps = {
      agent: { get: vi.fn().mockResolvedValue({ daemonId: crypto.randomUUID() }) },
      agentMutations: { tryBeginMutation: vi.fn(() => vi.fn()) },
      events: { publishActivity }
    } as unknown as DaemonWsDeps

    await handleSessionActivity(activityFrame(), { daemonId: DAEMON_ID } as DaemonConnection, deps)

    expect(publishActivity).not.toHaveBeenCalled()
  })
})
