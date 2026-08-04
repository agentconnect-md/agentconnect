import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleSessionPurged } from './event-session-purged.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PURGED_AT = '2026-08-04T09:00:00.000Z'

function purgedFrame(): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: PURGED_AT,
    type: 'event/session-purged',
    payload: {
      agentId: AGENT_ID,
      sessionIds: ['acp-1', 'acp-2'],
      reason: 'retention',
      ts: PURGED_AT
    }
  }
}

function depsWith(
  markContentPurged: ReturnType<typeof vi.fn>,
  placedOn: string = DAEMON_ID
): { deps: DaemonWsDeps; release: ReturnType<typeof vi.fn> } {
  const release = vi.fn()
  const deps = {
    agent: { get: vi.fn().mockResolvedValue({ daemonId: placedOn }) },
    agentMutations: { tryBeginMutation: vi.fn(() => release) },
    session: { markContentPurged }
  } as unknown as DaemonWsDeps
  return { deps, release }
}

function conn() {
  return { daemonId: DAEMON_ID, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
    sendError: ReturnType<typeof vi.fn>
  }
}

describe('handleSessionPurged', () => {
  it('stamps the reported sessions and ACKs after the commit', async () => {
    const markContentPurged = vi.fn().mockResolvedValue({ marked: ['acp-1', 'acp-2'], alreadyPurged: 0 })
    const { deps, release } = depsWith(markContentPurged)
    const c = conn()
    const frame = purgedFrame()

    await handleSessionPurged(frame, c, deps)

    expect(markContentPurged).toHaveBeenCalledWith(AGENT_ID, ['acp-1', 'acp-2'], 'retention', new Date(PURGED_AT))
    expect(c.replyTo).toHaveBeenCalledWith(frame, 'ack', { ok: true })
    expect(release).toHaveBeenCalledOnce()
  })

  it('ignores a report from a daemon that does not own the agent, but still ACKs it', async () => {
    // The daemon's local row is gone either way, so its receipt has nothing left
    // to converge — an error would make it retry a report that can never land.
    const markContentPurged = vi.fn()
    const { deps } = depsWith(markContentPurged, crypto.randomUUID())
    const c = conn()

    await handleSessionPurged(purgedFrame(), c, deps)

    expect(markContentPurged).not.toHaveBeenCalled()
    expect(c.replyTo).toHaveBeenCalledWith(expect.anything(), 'ack', { ok: true })
    expect(c.sendError).not.toHaveBeenCalled()
  })

  it('answers a retryable error when the stamp fails, so the receipt is kept', async () => {
    const markContentPurged = vi.fn().mockRejectedValue(new Error('db down'))
    const { deps } = depsWith(markContentPurged)
    const c = conn()
    const frame = purgedFrame()

    await handleSessionPurged(frame, c, deps)

    expect(c.replyTo).not.toHaveBeenCalled()
    expect(c.sendError).toHaveBeenCalledWith(frame.id, 'INTERNAL', expect.any(String), true)
  })
})
