import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PostgresDataPlane } from '../src/store/postgres-data-plane.js'
import { PostgresSyncDatabase } from '../src/store/postgres-sync-database.js'
import type { LocalStore } from '../src/store/local-store.js'
import { STORE_RETENTION_RULES, StoreRetentionSweeper } from '../src/store/retention.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL pool member store', () => {
  it('persists sessions, transcripts, inbox, outboxes, and caches without SQLite', async () => {
    const suffix = randomUUID()
    const agentId = `agent-${suffix}`
    const sessionKey = `slack:C-${suffix}:T-${suffix}:${agentId}`
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const first = await PostgresDataPlane.open(config, (id) => (id === agentId ? `org-${suffix}` : undefined))
    await first.store.upsertSession({
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
    await first.store.appendTranscript({
      channel: `C-${suffix}`,
      thread: `T-${suffix}`,
      ts: '1.000001',
      sender: 'user',
      recipient: agentId,
      trustedAgentBot: true,
      kind: 'text',
      text: 'persisted in PostgreSQL'
    })
    await first.store.appendTranscript({
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
      await first.store.appendInbox({
        id: `delivery-${suffix}`,
        sessionKey,
        agentId,
        msg: '{}',
        enqueuedAt: '00000000000000000001'
      })
    ).toBe(true)
    expect(
      await first.store.appendInbox({
        id: `delivery-${suffix}`,
        sessionKey,
        agentId,
        msg: '{}',
        loopGuardCounted: 1,
        enqueuedAt: '00000000000000000001'
      })
    ).toBe(false)
    await first.store.appendMemoryCapture({
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
    await first.store.setCronLastRun(`${agentId}:cron`, 42, '{}')
    await first.store.setDisplayName(`U-${suffix}`, 'Cloud user', 1)
    await first.store.saveSessionMetadataSnapshot(agentId, `session-${suffix}`, '{"title":"Cloud"}', true, 7)
    await first.store.insertDream({
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
    await first.store.claimActivationObservation(
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
      expect((await second.store.getSession(sessionKey))?.acpSessionId).toBe(`session-${suffix}`)
      expect(await second.store.threadTranscript(`C-${suffix}`, `T-${suffix}`, agentId)).toMatchObject([
        { text: 'authoritative PostgreSQL text', trustedAgentBot: 1 }
      ])
      expect(await second.store.hasInbox(`delivery-${suffix}`)).toBe(true)
      expect(await second.store.listInboxBySessionKeyFifo()).toContainEqual(
        expect.objectContaining({ id: `delivery-${suffix}`, sessionKey, loopGuardCounted: 1 })
      )
      expect(await second.store.nextMemoryCaptureDueAt()).toBe(1234)
      expect((await second.store.cronRun(`${agentId}:cron`))?.lastRunAt).toBe(42)
      expect((await second.store.getDisplayNames([`U-${suffix}`])).get(`U-${suffix}`)).toBe('Cloud user')
      expect((await second.store.pendingSessionMetadataSnapshot(agentId, `session-${suffix}`))?.snapshot).toBe(
        '{"title":"Cloud"}'
      )
      expect(await second.store.getDream(agentId, `dream-${suffix}`)).toMatchObject({
        sessionIds: [`session-${suffix}`],
        executionSessionId: `execution-${suffix}`,
        stopReason: 'completed'
      })
      expect((await second.store.getActivation(`activation-${suffix}`))?.transcriptCoordinates).toBe(
        `C-${suffix} T-${suffix}`
      )
    } finally {
      await second.store.removeInbox(`delivery-${suffix}`)
      await second.store.deleteSession(sessionKey)
      await second.close()
    }
  })

  it('fences process-owned recovery and activation claims across replicas', async () => {
    const suffix = randomUUID()
    const agentId = `agent-${suffix}`
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const orgForAgent = (id: string) => (id === agentId ? `org-${suffix}` : undefined)
    const first = await PostgresDataPlane.open(config, orgForAgent)
    await first.store.createPermissionRequest({
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
    await first.store.appendMemoryCapture({
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
    await first.store.claimActivationObservation(
      `activation-${suffix}`,
      { platformMessageId: `message-${suffix}`, transcriptCoordinates: `C-${suffix} T-${suffix}` },
      Number.MAX_SAFE_INTEGER
    )

    const second = await PostgresDataPlane.open(config, orgForAgent)
    try {
      expect(await second.store.listPermissionRequests(agentId)).toMatchObject([
        { id: `permission-${suffix}`, status: 'pending', resolvedAt: null }
      ])
      expect(await second.store.recoverPermissionRequests([`other-${suffix}`], 200)).toBe(0)
      expect((await second.store.listPermissionRequests(agentId))[0]?.status).toBe('pending')
      expect(await second.store.recoverPermissionRequests([agentId], 201)).toBe(1)
      expect((await second.store.listPermissionRequests(agentId))[0]).toMatchObject({
        status: 'expired',
        resolvedAt: 201
      })
      expect(await second.store.recoverMemoryCaptures(101)).toEqual({ retried: 0, ambiguous: 0 })
      // #1035: the hook terminal-report outbox is install-wide here, so a member
      // may drain only its own rows and may never release a peer's body.
      const hookId = `hook-${suffix}`
      expect(
        await first.store.appendInbox({
          id: hookId,
          sessionKey: `hook:${suffix}:d-1:${agentId}`,
          agentId,
          msg: '{}',
          hookContext: '{}',
          enqueuedAt: '00000000000000000002'
        })
      ).toBe(true)
      expect(await first.store.completeHookInbox(hookId, '{"status":"success"}', 1_000, `daemon-a-${suffix}`)).toBe(
        'completed'
      )
      const drained = async (ownerId: string, now: number) =>
        (await second.store.listHookTerminalReports(now, ownerId, [agentId]))
          .filter((row) => row.id === hookId)
          .map((row) => row.terminalReport)
      expect(await drained(`daemon-b-${suffix}`, 1_500)).toEqual([])
      expect(await second.store.claimHookTerminalReport(hookId, `daemon-b-${suffix}`, 1_500)).toBe(false)
      expect(await second.store.acknowledgeHookInbox(hookId, { ownerId: `daemon-b-${suffix}` })).toBe(false)
      const lapsed = 1_000 + 2 * 60 * 1_000 + 1
      expect(await drained(`daemon-b-${suffix}`, lapsed)).toEqual(['{"status":"success"}'])
      expect(await second.store.claimHookTerminalReport(hookId, `daemon-b-${suffix}`, lapsed)).toBe(true)
      expect(await second.store.releaseHookTerminalReport(hookId, `daemon-a-${suffix}`, lapsed)).toBe(true)
      expect(await drained(`daemon-a-${suffix}`, lapsed)).toEqual(['{"status":"success"}'])
      expect(await first.store.acknowledgeHookInbox(hookId, { ownerId: `daemon-a-${suffix}` })).toBe(true)
      await second.store.removeInbox(hookId)
      expect((await first.store.attachActivationEnvelope(`activation-${suffix}`, '{}', 10_000)).dispatch).toBe(true)
      expect((await second.store.attachActivationEnvelope(`activation-${suffix}`, '{}', 10_000)).dispatch).toBe(false)
      expect(await second.store.recoverMemoryCaptures(120_101, true, [`other-connection-${suffix}`])).toEqual({
        retried: 0,
        ambiguous: 0
      })
      expect((await second.store.getMemoryCapture(`capture-${suffix}`))?.state).toBe('sending')
      expect(await second.store.recoverMemoryCaptures(120_101, true, [`connection-${suffix}`])).toEqual({
        retried: 1,
        ambiguous: 0
      })

      const raceKey = `activation-race-${suffix}`
      await first.store.claimActivationObservation(
        raceKey,
        { platformMessageId: `race-message-${suffix}`, transcriptCoordinates: `race-${suffix}` },
        Number.MAX_SAFE_INTEGER
      )
      const getActivation = second.store.getActivation.bind(second.store)
      let disappeared = false
      const getSpy = vi.spyOn(second.store, 'getActivation').mockImplementation(async (key) => {
        if (key === raceKey && !disappeared) {
          disappeared = true
          expect(await first.store.releaseActivation(key)).toBe(true)
          return undefined
        }
        return getActivation(key)
      })
      try {
        expect(await second.store.attachActivationEnvelope(raceKey, '{}', 10_000)).toMatchObject({ dispatch: true })
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
      expect(
        await first.store.saveSessionMetadataSnapshot(agentId, sessionId, '{"phase":"end"}', true, 1_000, ownerA)
      ).toBe(1)
      // A's claim is live: B is not offered the row, cannot take it, and cannot release it.
      expect(await second.store.nextSessionMetadataSnapshot(1_500, ownerB, [agentId])).toBeUndefined()
      expect(await second.store.claimSessionMetadataSnapshot(agentId, sessionId, 1, ownerB, 1_500)).toBe(false)
      expect(await second.store.acknowledgeSessionMetadataSnapshot(agentId, sessionId, 1, ownerB)).toBe(false)
      // ...but B's wake is armed for the moment it lapses, so nothing waits on a duty change.
      expect(await second.store.nextSessionMetadataAttemptAt(ownerB, [agentId])).toBe(1_000 + lease)

      const lapsed = 1_000 + lease + 1
      expect((await second.store.nextSessionMetadataSnapshot(lapsed, ownerB, [agentId]))?.sessionId).toBe(sessionId)
      expect(await second.store.claimSessionMetadataSnapshot(agentId, sessionId, 1, ownerB, lapsed)).toBe(true)
      // Parking returns the row to the pool with its body and failure count intact.
      expect(await second.store.parkSessionMetadataSnapshot(agentId, sessionId, 1, lapsed + 60_000)).toBe(true)
      expect(await second.store.pendingSessionMetadataSnapshot(agentId, sessionId)).toMatchObject({
        failedAttempts: 0,
        snapshot: '{"phase":"end"}'
      })
      expect(await second.store.nextSessionMetadataSnapshot(lapsed, ownerB, [agentId])).toBeUndefined()

      // The duty comes back to A: the reclaim drops the backoff and settles under A's fence.
      expect(await first.store.reclaimSessionMetadataSnapshots([agentId], ownerA)).toBe(1)
      expect(await first.store.nextSessionMetadataAttemptAt(ownerA, [agentId])).toBe(0)
      expect((await first.store.nextSessionMetadataSnapshot(lapsed, ownerA, [agentId]))?.sessionId).toBe(sessionId)
      expect(await first.store.claimSessionMetadataSnapshot(agentId, sessionId, 1, ownerA, lapsed)).toBe(true)
      expect(await first.store.releaseOwnedSessionMetadataSnapshots(ownerA)).toBe(1)
      expect(await first.store.acknowledgeSessionMetadataSnapshot(agentId, sessionId, 1, ownerA)).toBe(true)
      expect(await first.store.hasPendingSessionMetadata(ownerA, [agentId])).toBe(false)
      expect(await first.store.nextSessionMetadataAttemptAt(ownerA, [agentId])).toBeUndefined()
    } finally {
      await second.close()
      await first.close()
    }
  })

  it('lands a coalesced tool-call burst as the last body the burst produced', async () => {
    const suffix = randomUUID()
    const agentId = `agent-${suffix}`
    const channel = `C-${suffix}`
    const thread = `T-${suffix}`
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const member = await PostgresDataPlane.open(config, (id) => (id === agentId ? `org-${suffix}` : undefined))
    try {
      await member.store.insertToolCall({
        channel,
        thread,
        ts: '1',
        sender: agentId,
        toolCallId: 'tc-1',
        title: 'Bash',
        body: '{"status":"pending"}'
      })
      for (let chunk = 1; chunk <= 8; chunk++) {
        await member.store.updateToolCall(channel, thread, agentId, 'tc-1', {
          title: 'Bash',
          body: `{"status":"in_progress","chunk":${chunk}}`
        })
      }
      const row = (await member.store.threadTranscript(channel, thread, agentId)).find((entry) => entry.kind === 'tool')
      // Every intermediate body was superseded; the row carries the last one the burst produced,
      // and the revision the pool's sequence handed the write that landed it.
      expect(row?.body).toBe('{"status":"in_progress","chunk":8}')
      expect(Number(row?.revision)).toBeGreaterThan(0)
      // The read the CP's bounded tool-body fetch actually takes, drained by the same facade.
      expect(await member.store.getToolBodyForAgent(channel, thread, agentId, 'tc-1')).toBe(
        '{"status":"in_progress","chunk":8}'
      )
    } finally {
      await member.close()
    }
  })

  it('answers a batch in order and names the statement that failed', () => {
    const database = new PostgresSyncDatabase({ version: 1, databaseUrl: databaseUrl!, maxConnections: 2 })
    database.finishSchemaInitialization()
    try {
      expect(
        database.batch([
          { kind: 'read', sql: 'SELECT 1 AS one', params: [] },
          { kind: 'read', sql: 'SELECT 2 AS one', params: [] }
        ])
      ).toMatchObject([{ rows: [{ one: 1 }] }, { rows: [{ one: 2 }] }])
      // A failure is attributed to its statement, never collapsed into "the batch failed".
      expect(() =>
        database.batch([
          { kind: 'read', sql: 'SELECT 1 AS one', params: [] },
          { kind: 'read', sql: 'SELECT * FROM a_table_that_does_not_exist', params: [] }
        ])
      ).toThrow(/batch statement 2 of 2 failed/)
    } finally {
      database.close()
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
      await first.store.recordRuntimeCatalogMeta({ runtimeId, fingerprint: 'fp-1', source: 'acp', observedAt: 100 })
      await first.store.upsertRuntimeModelCap({
        runtimeId,
        modelId: 'a',
        fingerprint: 'fp-1',
        caps: {},
        observedAt: 100
      })
      await first.store.markRuntimeCatalogComplete(runtimeId, 'fp-1', 'hash-1', 100)

      await second.store.recordRuntimeCatalogMeta({ runtimeId, fingerprint: 'fp-2', source: 'acp', observedAt: 200 })
      await second.store.upsertRuntimeModelCap({
        runtimeId,
        modelId: 'b',
        fingerprint: 'fp-2',
        caps: {},
        observedAt: 200
      })
      await second.store.pruneRuntimeModelCaps(runtimeId, ['b'])

      expect(await first.store.getRuntimeCatalogMeta(runtimeId)).toMatchObject({
        fingerprint: 'fp-1',
        complete: true,
        modelsHash: 'hash-1'
      })
      expect(await second.store.getRuntimeCatalogMeta(runtimeId)).toMatchObject({
        fingerprint: 'fp-2',
        complete: false
      })
      expect((await first.store.listRuntimeModelCaps(runtimeId)).map((row) => row.modelId)).toEqual(['a'])
      expect((await second.store.listRuntimeModelCaps(runtimeId)).map((row) => row.modelId)).toEqual(['b'])

      // A departed member's cache is unreadable by anyone, so the retention rule's shorter
      // window takes it while the sweeping member's own rows keep the long one.
      await sweepCatalogs(second.store, 200 + 8 * 24 * 3_600_000)
      expect(await first.store.getRuntimeCatalogMeta(runtimeId)).toBeUndefined()
      expect(await second.store.getRuntimeCatalogMeta(runtimeId)).toMatchObject({ fingerprint: 'fp-2' })
    } finally {
      await sweepCatalogs(second.store, Number.MAX_SAFE_INTEGER / 2)
      await second.close()
      await first.close()
    }
  })
})

/** Run only the catalog rules, as the sweeping member would. */
async function sweepCatalogs(store: LocalStore, now: number): Promise<void> {
  await new StoreRetentionSweeper({
    store,
    rules: STORE_RETENTION_RULES.filter((rule) => rule.id.startsWith('catalog-')),
    ownerId: store.cacheOwner,
    settings: { scale: 1, deleteOrphans: false },
    clock: { now: () => now } as never,
    log: { info: () => undefined, warn: () => undefined }
  }).sweep()
}
