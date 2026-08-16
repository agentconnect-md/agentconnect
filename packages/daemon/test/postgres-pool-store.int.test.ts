import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PostgresDataPlane } from '../src/store/postgres-transcript-store.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL pool member store', () => {
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
    first.store.setCronLastRun(`${agentId}:cron`, 42, '{}')
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
      expect(second.store.cronRun(`${agentId}:cron`)?.lastRunAt).toBe(42)
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
      expect(second.store.recoverPermissionRequests([`other-${suffix}`], 200)).toBe(0)
      expect(second.store.listPermissionRequests(agentId)[0]?.status).toBe('pending')
      expect(second.store.recoverPermissionRequests([agentId], 201)).toBe(1)
      expect(second.store.listPermissionRequests(agentId)[0]).toMatchObject({ status: 'expired', resolvedAt: 201 })
      expect(second.store.recoverMemoryCaptures(101)).toEqual({ retried: 0, ambiguous: 0 })
      // #1035: the hook terminal-report outbox is install-wide here, so a member
      // may drain only its own rows and may never release a peer's body.
      const hookId = `hook-${suffix}`
      expect(
        first.store.appendInbox({
          id: hookId,
          sessionKey: `hook:${suffix}:d-1:${agentId}`,
          agentId,
          msg: '{}',
          hookContext: '{}',
          enqueuedAt: '00000000000000000002'
        })
      ).toBe(true)
      expect(first.store.completeHookInbox(hookId, '{"status":"success"}', 1_000, `daemon-a-${suffix}`)).toBe(
        'completed'
      )
      const drained = (ownerId: string, now: number) =>
        second.store
          .listHookTerminalReports(now, ownerId, [agentId])
          .filter((row) => row.id === hookId)
          .map((row) => row.terminalReport)
      expect(drained(`daemon-b-${suffix}`, 1_500)).toEqual([])
      expect(second.store.claimHookTerminalReport(hookId, `daemon-b-${suffix}`, 1_500)).toBe(false)
      expect(second.store.acknowledgeHookInbox(hookId, { ownerId: `daemon-b-${suffix}` })).toBe(false)
      const lapsed = 1_000 + 2 * 60 * 1_000 + 1
      expect(drained(`daemon-b-${suffix}`, lapsed)).toEqual(['{"status":"success"}'])
      expect(second.store.claimHookTerminalReport(hookId, `daemon-b-${suffix}`, lapsed)).toBe(true)
      expect(second.store.releaseHookTerminalReport(hookId, `daemon-a-${suffix}`, lapsed)).toBe(true)
      expect(drained(`daemon-a-${suffix}`, lapsed)).toEqual(['{"status":"success"}'])
      expect(first.store.acknowledgeHookInbox(hookId, { ownerId: `daemon-a-${suffix}` })).toBe(true)
      second.store.removeInbox(hookId)
      expect(first.store.attachActivationEnvelope(`activation-${suffix}`, '{}', 10_000).dispatch).toBe(true)
      expect(second.store.attachActivationEnvelope(`activation-${suffix}`, '{}', 10_000).dispatch).toBe(false)
      expect(second.store.recoverMemoryCaptures(120_101, true, [`other-connection-${suffix}`])).toEqual({
        retried: 0,
        ambiguous: 0
      })
      expect(second.store.getMemoryCapture(`capture-${suffix}`)?.state).toBe('sending')
      expect(second.store.recoverMemoryCaptures(120_101, true, [`connection-${suffix}`])).toEqual({
        retried: 1,
        ambiguous: 0
      })

      const raceKey = `activation-race-${suffix}`
      first.store.claimActivationObservation(
        raceKey,
        { platformMessageId: `race-message-${suffix}`, transcriptCoordinates: `race-${suffix}` },
        Number.MAX_SAFE_INTEGER
      )
      const getActivation = second.store.getActivation.bind(second.store)
      let disappeared = false
      const getSpy = vi.spyOn(second.store, 'getActivation').mockImplementation((key) => {
        if (key === raceKey && !disappeared) {
          disappeared = true
          expect(first.store.releaseActivation(key)).toBe(true)
          return undefined
        }
        return getActivation(key)
      })
      try {
        expect(second.store.attachActivationEnvelope(raceKey, '{}', 10_000)).toMatchObject({ dispatch: true })
      } finally {
        getSpy.mockRestore()
      }
    } finally {
      await second.close()
      await first.close()
    }
  })

  it('leases session-metadata snapshots per member and wakes when the claim lapses', async () => {
    // #1023 against the real engine: the outbox is install-wide here, and the refill check's
    // "when does this become workable" query must run on PostgreSQL, not just SQLite.
    const suffix = randomUUID()
    const agentId = `agent-${suffix}`
    const sessionId = `session-${suffix}`
    const ownerA = `daemon-a-${suffix}`
    const ownerB = `daemon-b-${suffix}`
    const lease = 2 * 60 * 1_000
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const orgForAgent = (id: string) => (id === agentId ? `org-${suffix}` : undefined)
    const first = await PostgresDataPlane.open(config, orgForAgent)
    const second = await PostgresDataPlane.open(config, orgForAgent)
    try {
      expect(first.store.saveSessionMetadataSnapshot(agentId, sessionId, '{"phase":"end"}', true, 1_000, ownerA)).toBe(
        1
      )
      // A's claim is live: B is not offered the row, cannot take it, and cannot release it.
      expect(second.store.nextSessionMetadataSnapshot(1_500, ownerB, [agentId])).toBeUndefined()
      expect(second.store.claimSessionMetadataSnapshot(agentId, sessionId, 1, ownerB, 1_500)).toBe(false)
      expect(second.store.acknowledgeSessionMetadataSnapshot(agentId, sessionId, 1, ownerB)).toBe(false)
      // ...but B's wake is armed for the moment it lapses, so nothing waits on a duty change.
      expect(second.store.nextSessionMetadataAttemptAt(ownerB, [agentId])).toBe(1_000 + lease)

      const lapsed = 1_000 + lease + 1
      expect(second.store.nextSessionMetadataSnapshot(lapsed, ownerB, [agentId])?.sessionId).toBe(sessionId)
      expect(second.store.claimSessionMetadataSnapshot(agentId, sessionId, 1, ownerB, lapsed)).toBe(true)
      // Parking returns the row to the pool with its body and failure count intact.
      expect(second.store.parkSessionMetadataSnapshot(agentId, sessionId, 1, lapsed + 60_000)).toBe(true)
      expect(second.store.pendingSessionMetadataSnapshot(agentId, sessionId)).toMatchObject({
        failedAttempts: 0,
        snapshot: '{"phase":"end"}'
      })
      expect(second.store.nextSessionMetadataSnapshot(lapsed, ownerB, [agentId])).toBeUndefined()

      // The duty comes back to A: the reclaim drops the backoff and settles under A's fence.
      expect(first.store.reclaimSessionMetadataSnapshots([agentId], ownerA)).toBe(1)
      expect(first.store.nextSessionMetadataAttemptAt(ownerA, [agentId])).toBe(0)
      expect(first.store.nextSessionMetadataSnapshot(lapsed, ownerA, [agentId])?.sessionId).toBe(sessionId)
      expect(first.store.claimSessionMetadataSnapshot(agentId, sessionId, 1, ownerA, lapsed)).toBe(true)
      expect(first.store.releaseOwnedSessionMetadataSnapshots(ownerA)).toBe(1)
      expect(first.store.acknowledgeSessionMetadataSnapshot(agentId, sessionId, 1, ownerA)).toBe(true)
      expect(first.store.hasPendingSessionMetadata(ownerA, [agentId])).toBe(false)
      expect(first.store.nextSessionMetadataAttemptAt(ownerA, [agentId])).toBeUndefined()
    } finally {
      await second.close()
      await first.close()
    }
  })

  it('keeps each member on its own runtime model catalog', async () => {
    // The rollout case against the real schema: two members, two fingerprints, one table.
    const suffix = randomUUID()
    const runtimeId = `runtime-${suffix}`
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const first = await PostgresDataPlane.open(config, () => undefined)
    const second = await PostgresDataPlane.open(config, () => undefined)
    try {
      first.store.recordRuntimeCatalogMeta({ runtimeId, fingerprint: 'fp-1', source: 'acp', observedAt: 100 })
      first.store.upsertRuntimeModelCap({ runtimeId, modelId: 'a', fingerprint: 'fp-1', caps: {}, observedAt: 100 })
      first.store.markRuntimeCatalogComplete(runtimeId, 'fp-1', 'hash-1', 100)

      second.store.recordRuntimeCatalogMeta({ runtimeId, fingerprint: 'fp-2', source: 'acp', observedAt: 200 })
      second.store.upsertRuntimeModelCap({ runtimeId, modelId: 'b', fingerprint: 'fp-2', caps: {}, observedAt: 200 })
      second.store.pruneRuntimeModelCaps(runtimeId, ['b'])

      expect(first.store.getRuntimeCatalogMeta(runtimeId)).toMatchObject({
        fingerprint: 'fp-1',
        complete: true,
        modelsHash: 'hash-1'
      })
      expect(second.store.getRuntimeCatalogMeta(runtimeId)).toMatchObject({ fingerprint: 'fp-2', complete: false })
      expect(first.store.listRuntimeModelCaps(runtimeId).map((row) => row.modelId)).toEqual(['a'])
      expect(second.store.listRuntimeModelCaps(runtimeId).map((row) => row.modelId)).toEqual(['b'])

      // A departed member's cache is unreadable by anyone, so the shorter window takes it.
      second.store.gcRuntimeCatalog(1, 150)
      expect(first.store.getRuntimeCatalogMeta(runtimeId)).toBeUndefined()
      expect(second.store.getRuntimeCatalogMeta(runtimeId)).toMatchObject({ fingerprint: 'fp-2' })

      // The single-holder sweep lease decides through the same upsert on PostgreSQL as on SQLite.
      const lease = `sweep-${suffix}`
      expect(first.store.acquireSweepLease(lease, 1_000, 10_000)).toBe(true)
      expect(second.store.acquireSweepLease(lease, 1_000, 10_500)).toBe(false)
      expect(first.store.acquireSweepLease(lease, 1_000, 10_900)).toBe(true)
      expect(second.store.acquireSweepLease(lease, 1_000, 11_950)).toBe(true)
      expect(first.store.acquireSweepLease(lease, 1_000, 12_000)).toBe(false)
    } finally {
      second.store.gcRuntimeCatalog(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      await second.close()
      await first.close()
    }
  })
})
