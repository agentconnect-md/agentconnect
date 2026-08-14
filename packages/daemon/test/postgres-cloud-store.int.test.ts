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
      trustedAgentBot: true,
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
    expect(
      first.store.appendInbox({
        id: `delivery-${suffix}`,
        sessionKey,
        agentId,
        msg: '{}',
        loopGuardCounted: 1,
        enqueuedAt: '00000000000000000001'
      })
    ).toBe(false)
    first.store.appendMemoryCapture({
      operationId: `capture-${suffix}`,
      turnId: `turn-${suffix}`,
      agentId,
      connectionId: `connection-${suffix}`,
      connectionRevision: 1,
      pluginId: 'test.memory',
      config: '{}',
      scopeKey: `ac:agent:${agentId}`,
      input: 'input',
      output: 'output',
      payloadHash: `sha256:${suffix.replaceAll('-', '')}`,
      payloadBytes: 11,
      idempotency: 'operation-id',
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 1234,
      createdAt: 1,
      updatedAt: 1
    })
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
      expect(second.store.threadTranscript(`C-${suffix}`, `T-${suffix}`)).toMatchObject([
        { text: 'authoritative PostgreSQL text', trustedAgentBot: 1 }
      ])
      expect(second.store.hasInbox(`delivery-${suffix}`)).toBe(true)
      expect(second.store.listInboxBySessionKeyFifo()).toContainEqual(
        expect.objectContaining({ id: `delivery-${suffix}`, sessionKey, loopGuardCounted: 1 })
      )
      expect(second.store.nextMemoryCaptureDueAt()).toBe(1234)
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

  it('fences process-owned recovery and activation claims across replicas', async () => {
    const suffix = randomUUID()
    const agentId = `agent-${suffix}`
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const orgForAgent = (id: string) => (id === agentId ? `org-${suffix}` : undefined)
    const first = await PostgresDataPlane.open(config, orgForAgent)
    first.store.createPermissionRequest({
      id: `permission-${suffix}`,
      agentId,
      sessionId: `session-${suffix}`,
      createdAt: 100,
      requesterId: null,
      requesterName: null,
      command: 'test command',
      status: 'pending',
      resolvedAt: null
    })
    first.store.appendMemoryCapture({
      operationId: `capture-${suffix}`,
      turnId: `turn-${suffix}`,
      agentId,
      connectionId: `connection-${suffix}`,
      connectionRevision: 1,
      pluginId: 'test.memory',
      config: '{}',
      scopeKey: `ac:agent:${agentId}`,
      input: 'input',
      output: 'output',
      payloadHash: `sha256:${suffix.replaceAll('-', '')}`,
      payloadBytes: 11,
      idempotency: 'operation-id',
      state: 'sending',
      attempts: 1,
      nextAttemptAt: 100,
      createdAt: 100,
      updatedAt: 100
    })
    first.store.claimActivationObservation(
      `activation-${suffix}`,
      { platformMessageId: `message-${suffix}`, transcriptCoordinates: `C-${suffix} T-${suffix}` },
      Number.MAX_SAFE_INTEGER
    )

    const second = await PostgresDataPlane.open(config, orgForAgent)
    try {
      expect(second.store.listPermissionRequests(agentId)).toMatchObject([
        { id: `permission-${suffix}`, status: 'pending', resolvedAt: null }
      ])
      expect(second.store.recoverMemoryCaptures(101)).toEqual({ retried: 0, ambiguous: 0 })
      expect(first.store.attachActivationEnvelope(`activation-${suffix}`, '{}', 10_000).dispatch).toBe(true)
      expect(second.store.attachActivationEnvelope(`activation-${suffix}`, '{}', 10_000).dispatch).toBe(false)
      expect(second.store.recoverMemoryCaptures(120_101)).toEqual({ retried: 1, ambiguous: 0 })
    } finally {
      await second.close()
      await first.close()
    }
  })
})
