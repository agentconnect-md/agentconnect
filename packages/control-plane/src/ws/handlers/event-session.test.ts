import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { SessionMetaRecord, SessionMilestoneResult } from '../../persistence/ports.js'
import { handleEventSession } from './event-session.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_ID = 'session-407'

function scopedDeps(extra: Record<string, unknown>): DaemonWsDeps {
  return {
    agent: { get: vi.fn().mockResolvedValue({ daemonId: DAEMON_ID }) },
    agentMutations: { tryBeginMutation: vi.fn(() => vi.fn()) },
    ...extra
  } as unknown as DaemonWsDeps
}

function eventSessionFrame(): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-10T00:00:00.000Z',
    type: 'event/session',
    payload: {
      sessionId: 'session-407',
      agentId: AGENT_ID,
      phase: 'start',
      platform: 'slack',
      channel: 'C407',
      title: 'Fresh session',
      ts: '2026-07-10T00:00:00.000Z'
    }
  }
}

/** A minimal `recorded` result: the upsert landed and settled no A2A children. */
function recorded(session: Partial<SessionMetaRecord> = {}): SessionMilestoneResult {
  return {
    recorded: true,
    session: { id: SESSION_ID, agentId: AGENT_ID, parentSessionId: null, ...session } as SessionMetaRecord,
    settled: []
  }
}

describe('handleEventSession', () => {
  it('publishes the milestone only after it has been persisted', async () => {
    const order: string[] = []
    let finishPersist!: () => void
    const recordMilestone = vi.fn(() => {
      order.push('persist:start')
      return new Promise<SessionMilestoneResult>((resolve) => {
        finishPersist = () => {
          order.push('persist:finish')
          resolve(recorded())
        }
      })
    })
    const publish = vi.fn(() => {
      order.push('publish')
    })
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish }
    })
    const conn = { daemonId: DAEMON_ID } as DaemonConnection
    const frame = eventSessionFrame()

    const handling = handleEventSession(frame, conn, deps)

    await vi.waitFor(() => expect(order).toEqual(['persist:start']))
    expect(order).toEqual(['persist:start'])
    expect(publish).not.toHaveBeenCalled()

    finishPersist()
    await handling

    expect(order).toEqual(['persist:start', 'persist:finish', 'publish'])
    expect(publish).toHaveBeenCalledWith(DAEMON_ID, frame.payload)
  })

  it('passes the execution-config snapshot through and stamps daemonId from the connection', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      runtime: 'claude',
      model: 'opus',
      effort: 'high',
      fastMode: true,
      permissionMode: 'acceptEdits',
      outputMode: 'medium'
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'claude',
        model: 'opus',
        effort: 'high',
        fastMode: true,
        permissionMode: 'acceptEdits',
        outputMode: 'medium',
        // The reporting daemon is CP-stamped from the authenticated connection,
        // never taken from the frame payload.
        daemonId: DAEMON_ID
      })
    )
  })

  it('does not publish when persistence fails', async () => {
    const failure = new Error('write failed')
    const publish = vi.fn()
    const deps = scopedDeps({
      session: { recordMilestone: vi.fn().mockRejectedValue(failure) },
      events: { publish }
    })

    await expect(
      handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID } as DaemonConnection, deps)
    ).rejects.toBe(failure)
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not publish a milestone rejected by the session ownership fence', async () => {
    const publish = vi.fn()
    const deps = scopedDeps({
      session: { recordMilestone: vi.fn().mockResolvedValue({ recorded: false, session: null, settled: [] }) },
      events: { publish }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID } as DaemonConnection, deps)

    expect(publish).not.toHaveBeenCalled()
  })

  it('drops a milestone for an agent not placed on the reporting daemon', async () => {
    const release = vi.fn()
    const recordMilestone = vi.fn()
    const publish = vi.fn()
    const deps = scopedDeps({
      agent: { get: vi.fn().mockResolvedValue({ daemonId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }) },
      agentMutations: { tryBeginMutation: vi.fn(() => release) },
      session: { recordMilestone },
      events: { publish }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID } as DaemonConnection, deps)

    expect(recordMilestone).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
})
