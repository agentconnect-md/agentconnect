import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { MEMORY_PLUGIN_PROFILE, type MemoryConnectionSpec, type MemoryPluginManifest } from '@agentconnect.md/protocol'
import { LocalStore, type MemoryCaptureOutboxRow } from '../src/store/local-store.js'
import { openTestStore, usingPostgresStore } from './store-support.js'
import {
  MEMORY_CAPTURE_INPUT_MAX_BYTES,
  MEMORY_CAPTURE_OUTPUT_MAX_BYTES,
  MemoryCaptureOutbox,
  boundedCaptureText,
  type MemoryCaptureConnectionRegistry
} from '../src/memory-plugin/outbox.js'
import type { MemoryPluginClient } from '../src/memory-plugin/client.js'
import type { MemoryPluginMetrics } from '../src/memory-plugin/metrics.js'

const connectionId = '11111111-1111-4111-8111-111111111111'

/** True in the `store-postgres` project, where every store below is the real pool store. */
const pg = usingPostgresStore()

async function store(path?: string): Promise<LocalStore> {
  return await openTestStore({ path: path ?? join(mkdtempSync(join(tmpdir(), 'ac-memory-outbox-')), 'local.sqlite') })
}

function manifest(idempotency: 'operation-id' | 'none', asyncCapture = false): MemoryPluginManifest {
  return {
    profile: MEMORY_PLUGIN_PROFILE,
    plugin: { id: 'ai.example.memory', version: '1.0.0' },
    connection: { configSchema: { type: 'object', properties: {} }, secretFields: [] },
    capabilities: {
      scopes: ['agent'],
      operations: ['recall', 'capture'],
      asyncCapture,
      idempotency
    },
    limits: { maxQueryBytes: 16_384, maxRecordBytes: 32_768, maxBatchItems: 20 }
  }
}

function fakeClient(options: {
  idempotency: 'operation-id' | 'none'
  asyncCapture?: boolean
  capture: ReturnType<typeof vi.fn>
  status?: ReturnType<typeof vi.fn>
}): MemoryPluginClient {
  return {
    manifest: manifest(options.idempotency, options.asyncCapture),
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    capture: options.capture,
    operationStatus: options.status ?? vi.fn()
  } as unknown as MemoryPluginClient
}

function spec(): MemoryConnectionSpec {
  return {
    connectionId,
    revision: 1,
    transport: 'streamable-http',
    relayUrl: 'https://relay.example/memory/' + connectionId,
    grantKey: 'grant',
    config: { project: 'p1' },
    secretKeys: ['apiKey'],
    pin: { pluginId: 'ai.example.memory', profileMajor: 1, secretHeaders: [] }
  }
}

function registryFor(client: MemoryPluginClient): MemoryCaptureConnectionRegistry & {
  markRecovered: Mock<MemoryCaptureConnectionRegistry['markRecovered']>
  markDegraded: Mock<MemoryCaptureConnectionRegistry['markDegraded']>
} {
  return {
    connectionIds: () => [connectionId],
    clientFor: (id) => (id === connectionId ? client : undefined),
    specFor: (id) => (id === connectionId ? spec() : undefined),
    markRecovered: vi.fn<MemoryCaptureConnectionRegistry['markRecovered']>(),
    markDegraded: vi.fn<MemoryCaptureConnectionRegistry['markDegraded']>()
  }
}

const metrics: MemoryPluginMetrics = {
  recall: vi.fn(),
  recallInjected: vi.fn(),
  captureState: vi.fn(),
  outbox: vi.fn()
}

function input() {
  return {
    agentId: 'bot-a',
    connectionId,
    connectionRevision: 1,
    pluginId: 'ai.example.memory',
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    config: { project: 'p1' },
    turnId: 'turn-1',
    sessionId: 'session-1',
    input: 'remember the deploy region',
    output: 'We deploy in sea.'
  }
}

describe('MemoryCaptureOutbox', () => {
  it('persists before send, polls an async receipt, and reaches completed', async () => {
    const capture = vi.fn(async () => ({ state: 'accepted' as const, backendOperationId: 'event-1' }))
    const status = vi.fn(async () => ({ state: 'completed' as const }))
    const client = fakeClient({ idempotency: 'none', asyncCapture: true, capture, status })
    const registry = registryFor(client)
    const db = await store()
    const outbox = new MemoryCaptureOutbox(db, registry, { metrics, acceptedPollMs: 5 })
    await outbox.start()
    const queued = await outbox.enqueue({ ...input(), idempotency: 'none' })
    expect(queued.status).toBe('inserted')
    expect((await db.getMemoryCapture(queued.operationId))?.state).toMatch(/pending|sending|accepted|completed/)

    await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('completed'))
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: queued.operationId,
        context: expect.objectContaining({ scope: { kind: 'agent', key: 'ac:agent:bot-a' } })
      })
    )
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: queued.operationId, backendOperationId: 'event-1' })
    )
    expect(registry.markRecovered).toHaveBeenCalledWith(connectionId, [
      'capture_status_unavailable',
      'health_unavailable'
    ])
    expect(await db.getMemoryCapture(queued.operationId)).toMatchObject({
      config: '{}',
      input: '',
      output: '',
      payloadBytes: 0
    })
    expect((await outbox.enqueue({ ...input(), idempotency: 'none' })).status).toBe('duplicate')
    await outbox.stop()
    await db.close()
  })

  it('never retries a non-idempotent call once delivery becomes unknown', async () => {
    const capture = vi.fn(async () => {
      throw new Error('socket reset after write')
    })
    const client = fakeClient({ idempotency: 'none', capture })
    const registry = registryFor(client)
    const db = await store()
    const outbox = new MemoryCaptureOutbox(db, registry, { metrics, retryBaseMs: 5 })
    await outbox.start()
    const queued = await outbox.enqueue({ ...input(), idempotency: 'none' })
    await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('ambiguous'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(capture).toHaveBeenCalledTimes(1)
    expect(registry.markDegraded).toHaveBeenCalledWith(connectionId, 'capture_unavailable')
    await outbox.stop()
    await db.close()
  })

  it('retries only an operation-id-capable plugin with the identical operation id', async () => {
    const capture = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ state: 'completed' as const })
    const client = fakeClient({ idempotency: 'operation-id', capture })
    const db = await store()
    const outbox = new MemoryCaptureOutbox(db, registryFor(client), {
      metrics,
      retryBaseMs: 5,
      retryMaxMs: 5
    })
    await outbox.start()
    const queued = await outbox.enqueue({ ...input(), idempotency: 'operation-id' })
    await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('completed'))
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture.mock.calls.map((call) => call[0].operationId)).toEqual([queued.operationId, queued.operationId])
    await outbox.stop()
    await db.close()
  })

  it('recovers a sending row across restart before the connection registry converges', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-memory-restart-')), 'local.sqlite')
    let db = await store(path)
    const base: MemoryCaptureOutboxRow = {
      operationId: 'op-idempotent',
      turnId: 'turn-a',
      agentId: 'bot-a',
      connectionId,
      connectionRevision: 1,
      pluginId: 'ai.example.memory',
      config: '{}',
      scopeKey: 'ac:agent:bot-a',
      input: 'in',
      output: 'out',
      payloadHash: 'sha256:' + 'c'.repeat(64),
      payloadBytes: 5,
      idempotency: 'operation-id',
      state: 'sending',
      attempts: 1,
      nextAttemptAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    expect(await db.appendMemoryCapture(base)).toBe('inserted')
    expect(
      await db.appendMemoryCapture({
        ...base,
        operationId: 'op-none',
        turnId: 'turn-b',
        idempotency: 'none'
      })
    ).toBe('inserted')
    expect(await db.recoverMemoryCaptures(10, true)).toEqual({ retried: 0, ambiguous: 0 })
    await db.close()

    db = await store(path)
    const outbox = new MemoryCaptureOutbox(
      db,
      {
        connectionIds: () => [],
        clientFor: () => undefined,
        specFor: () => undefined,
        markRecovered: vi.fn(),
        markDegraded: vi.fn()
      },
      { metrics, now: () => 10 }
    )
    await outbox.start()
    expect((await db.getMemoryCapture('op-idempotent'))?.state).toBe('pending')
    expect(await db.getMemoryCapture('op-none')).toMatchObject({
      state: 'ambiguous',
      config: '{}',
      input: '',
      output: '',
      payloadBytes: 0
    })
    await outbox.stop()
    await db.close()
  })

  it('processes only connections owned by this daemon registry', async () => {
    const capture = vi.fn(async () => ({ state: 'completed' as const }))
    const db = await store()
    const foreign: MemoryCaptureOutboxRow = {
      operationId: 'foreign-operation',
      turnId: 'foreign-turn',
      agentId: 'bot-b',
      connectionId: '22222222-2222-4222-8222-222222222222',
      connectionRevision: 1,
      pluginId: 'ai.example.memory',
      config: '{}',
      scopeKey: 'ac:agent:bot-b',
      input: 'foreign input',
      output: 'foreign output',
      payloadHash: 'sha256:' + 'd'.repeat(64),
      payloadBytes: 27,
      idempotency: 'operation-id',
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    expect(await db.appendMemoryCapture(foreign)).toBe('inserted')
    const outbox = new MemoryCaptureOutbox(db, registryFor(fakeClient({ idempotency: 'operation-id', capture })), {
      metrics
    })
    try {
      await outbox.start()
      const queued = await outbox.enqueue({ ...input(), idempotency: 'operation-id' })
      await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('completed'))
      expect(await db.getMemoryCapture(foreign.operationId)).toMatchObject({ state: 'pending', nextAttemptAt: 0 })
      expect(capture).toHaveBeenCalledTimes(1)
    } finally {
      await outbox.stop()
      await db.close()
    }
  })

  it('marks an explicit failed receipt degraded and redacts its persisted body', async () => {
    const capture = vi.fn(async () => ({ state: 'failed' as const }))
    const registry = registryFor(fakeClient({ idempotency: 'none', capture }))
    const db = await store()
    const outbox = new MemoryCaptureOutbox(db, registry, { metrics })
    await outbox.start()
    const queued = await outbox.enqueue({ ...input(), idempotency: 'none' })
    await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('failed'))
    expect(registry.markDegraded).toHaveBeenCalledWith(connectionId, 'capture_failed')
    expect(await db.getMemoryCapture(queued.operationId)).toMatchObject({
      reasonCode: 'plugin_failed',
      config: '{}',
      input: '',
      output: '',
      payloadBytes: 0
    })
    await outbox.stop()
    await db.close()
  })

  it('deduplicates stable turns, rejects a full queue, and truncates valid UTF-8', async () => {
    const capture = vi.fn(async () => ({ state: 'completed' as const }))
    const db = await store()
    const outbox = new MemoryCaptureOutbox(db, registryFor(fakeClient({ idempotency: 'none', capture })), {
      metrics,
      maxActiveItems: 1
    })
    const large = {
      ...input(),
      idempotency: 'none',
      input: '€'.repeat(MEMORY_CAPTURE_INPUT_MAX_BYTES),
      output: '™'.repeat(MEMORY_CAPTURE_OUTPUT_MAX_BYTES)
    } as const
    const first = await outbox.enqueue(large)
    expect(first.status).toBe('inserted')
    expect((await outbox.enqueue(large)).status).toBe('duplicate')
    expect((await outbox.enqueue({ ...input(), idempotency: 'none' })).status).toBe('conflict')
    expect((await outbox.enqueue({ ...input(), turnId: 'turn-2', idempotency: 'none' })).status).toBe('full')
    const row = (await db.getMemoryCapture(first.operationId))!
    expect(Buffer.byteLength(row.input)).toBeLessThanOrEqual(MEMORY_CAPTURE_INPUT_MAX_BYTES)
    expect(Buffer.byteLength(row.output)).toBeLessThanOrEqual(MEMORY_CAPTURE_OUTPUT_MAX_BYTES)
    expect(row.input).not.toContain('\uFFFD')
    expect(row.output).not.toContain('\uFFFD')
    expect(boundedCaptureText('abc', 3)).toBe('abc')
    await db.close()
  })

  it('fails closed when the verified manifest changes instead of retargeting an old row', async () => {
    const capture = vi.fn(async () => ({ state: 'completed' as const }))
    const client = fakeClient({ idempotency: 'none', capture })
    Object.defineProperty(client, 'manifestDigest', { value: 'sha256:' + 'b'.repeat(64) })
    const db = await store()
    const outbox = new MemoryCaptureOutbox(db, registryFor(client), { metrics })
    const queued = await outbox.enqueue({ ...input(), idempotency: 'none' })
    await outbox.start()
    await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('failed'))
    expect((await db.getMemoryCapture(queued.operationId))?.reasonCode).toBe('manifest_mismatch')
    expect(capture).not.toHaveBeenCalled()
    await outbox.stop()
    await db.close()
  })

  it('fails closed when the connection definition revision changes instead of writing to a replacement backend', async () => {
    const capture = vi.fn(async () => ({ state: 'completed' as const }))
    const client = fakeClient({ idempotency: 'none', capture })
    const registry = registryFor(client)
    registry.specFor = () => ({ ...spec(), revision: 2 })
    const db = await store()
    const outbox = new MemoryCaptureOutbox(db, registry, { metrics })
    const queued = await outbox.enqueue({ ...input(), idempotency: 'none' })
    await outbox.start()
    await vi.waitFor(async () => expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('failed'))
    expect((await db.getMemoryCapture(queued.operationId))?.reasonCode).toBe('connection_revision_changed')
    expect(capture).not.toHaveBeenCalled()
    await outbox.stop()
    await db.close()
  })

  it('schedules age expiry even while the queue is otherwise quiet', async () => {
    const db = await store()
    const unavailable: MemoryCaptureConnectionRegistry = {
      connectionIds: () => [connectionId],
      clientFor: () => undefined,
      specFor: () => spec(),
      markRecovered: vi.fn(),
      markDegraded: vi.fn()
    }
    const outbox = new MemoryCaptureOutbox(db, unavailable, {
      metrics,
      maxAgeMs: 30,
      unavailableRetryMs: 1_000
    })
    try {
      const queued = await outbox.enqueue({ ...input(), idempotency: 'none' })
      await outbox.start()
      await vi.waitFor(
        async () => expect((await db.getMemoryCapture(queued.operationId))?.reasonCode).toBe('retention_expired'),
        {
          timeout: 500,
          interval: 5
        }
      )
      // The terminal row it leaves is the retention rule table's to drop, not this loop's.
      expect((await db.getMemoryCapture(queued.operationId))?.state).toBe('failed')
    } finally {
      await outbox.stop()
      await db.close()
    }
  })
})
