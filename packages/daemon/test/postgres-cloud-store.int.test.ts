import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PostgresDataPlane } from '../src/store/postgres-transcript-store.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL cloud daemon store', () => {
  it('persists sessions, transcripts, inbox, outboxes, and caches without SQLite', async () => {
    const suffix = randomUUID()
    const agentId = `agent-${suffix}`
    const sessionKey = `slack:C-${suffix}:T-${suffix}:${agentId}`
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const first = await PostgresDataPlane.open(config, (id) => (id === agentId ? `org-${suffix}` : undefined))
    first.store.upsertSession({
      key: sessionKey,
      agentId,
      platform: 'slack',
      channel: `C-${suffix}`,
      thread: `T-${suffix}`,
      acpSessionId: `session-${suffix}`,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    first.store.appendTranscript({
      channel: `C-${suffix}`,
      thread: `T-${suffix}`,
      ts: '1.000001',
      sender: 'user',
      recipient: agentId,
      kind: 'text',
      text: 'persisted in PostgreSQL'
    })
    first.store.appendTranscript({
      channel: `C-${suffix}`,
      thread: `T-${suffix}`,
      ts: '1.000001',
      sender: 'user',
      recipient: agentId,
      kind: 'text',
      text: 'authoritative PostgreSQL text',
      authoritative: true
    })
    expect(
      first.store.appendInbox({
        id: `delivery-${suffix}`,
        sessionKey,
        agentId,
        msg: '{}',
        enqueuedAt: '00000000000000000001'
      })
    ).toBe(true)
    first.store.setCronLastRun(`${agentId}:cron`, 42)
    first.store.setDisplayName(`U-${suffix}`, 'Cloud user', 1)
    first.store.saveSessionMetadataSnapshot(agentId, `session-${suffix}`, '{"title":"Cloud"}', true, 7)
    first.store.insertDream({
      dreamId: `dream-${suffix}`,
      agentId,
      status: 'completed',
      trigger: 'manual',
      sessionIds: [`session-${suffix}`],
      snapshotDigest: `sha256:${suffix}`,
      executionSessionId: `execution-${suffix}`,
      stopReason: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    first.store.claimActivationObservation(
      `activation-${suffix}`,
      {
        platformMessageId: `message-${suffix}`,
        transcriptCoordinates: `C-${suffix} T-${suffix}`
      },
      Number.MAX_SAFE_INTEGER
    )
    await first.close()

    const second = await PostgresDataPlane.open(config, (id) => (id === agentId ? `org-${suffix}` : undefined))
    try {
      expect(second.store.getSession(sessionKey)?.acpSessionId).toBe(`session-${suffix}`)
      expect(second.store.threadTranscript(`C-${suffix}`, `T-${suffix}`).map((row) => row.text)).toEqual([
        'authoritative PostgreSQL text'
      ])
      expect(second.store.hasInbox(`delivery-${suffix}`)).toBe(true)
      expect(second.store.getCronLastRun(`${agentId}:cron`)).toBe(42)
      expect(second.store.getDisplayNames([`U-${suffix}`]).get(`U-${suffix}`)).toBe('Cloud user')
      expect(second.store.pendingSessionMetadataSnapshot(agentId, `session-${suffix}`)?.snapshot).toBe(
        '{"title":"Cloud"}'
      )
      expect(second.store.getDream(agentId, `dream-${suffix}`)).toMatchObject({
        sessionIds: [`session-${suffix}`],
        executionSessionId: `execution-${suffix}`,
        stopReason: 'completed'
      })
      expect(second.store.getActivation(`activation-${suffix}`)?.transcriptCoordinates).toBe(`C-${suffix} T-${suffix}`)
    } finally {
      second.store.removeInbox(`delivery-${suffix}`)
      second.store.deleteSession(sessionKey)
      await second.close()
    }
  })
})
