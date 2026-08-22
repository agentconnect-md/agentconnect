import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_PLUGIN_PROFILE,
  type ExternalMemoryBinding,
  type MemoryConnectionSpec,
  type MemoryPluginManifest
} from '@agentconnect.md/protocol'
import { ExternalMemoryProvider, createMemoryProvider, type ExternalMemoryRuntimeDeps } from '../src/memory/provider.js'
import {
  MemoryPluginConflictError,
  MemoryPluginInputError,
  type MemoryPluginClient
} from '../src/memory-plugin/client.js'
import { MemoryConflictError, MemoryTooLargeError } from '../src/memory/store.js'
import { LocalMemoryFs } from '../src/memory/fs.js'

const connectionA = '11111111-1111-4111-8111-111111111111'
const connectionB = '22222222-2222-4222-8222-222222222222'

function binding(connectionId = connectionA, capture: 'turn' | 'manual' = 'turn'): ExternalMemoryBinding {
  return {
    provider: 'external',
    connectionId,
    recall: { mode: 'auto', topK: 3, maxBytes: 4_096, timeoutMs: 250 },
    capture: { mode: capture }
  }
}

function manifest(
  operations: MemoryPluginManifest['capabilities']['operations'] = ['recall', 'capture']
): MemoryPluginManifest {
  return {
    profile: MEMORY_PLUGIN_PROFILE,
    plugin: { id: 'ai.example.memory', version: '1.0.0' },
    connection: { configSchema: { type: 'object', properties: {} }, secretFields: [] },
    capabilities: {
      scopes: ['agent'],
      operations,
      asyncCapture: false,
      idempotency: 'operation-id'
    },
    limits: { maxQueryBytes: 16_384, maxRecordBytes: 32_768, maxBatchItems: 20 }
  }
}

function spec(connectionId: string): MemoryConnectionSpec {
  return {
    connectionId,
    revision: 1,
    transport: 'streamable-http',
    relayUrl: `https://relay.example/memory/${connectionId}`,
    grantKey: 'grant',
    config: { account: connectionId },
    secretKeys: [],
    pin: { pluginId: 'ai.example.memory', profileMajor: 1, secretHeaders: [] }
  }
}

function harness(operations?: MemoryPluginManifest['capabilities']['operations']) {
  const recall = vi.fn(async (req: any) => ({
    records: [
      {
        id: 'record-1',
        text: 'deploy in sea',
        scope: req.context.scope,
        provenance: { pluginId: 'ai.example.memory' }
      }
    ]
  }))
  const client = {
    manifest: manifest(operations),
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    recall,
    list: vi.fn(async (req: any) => ({
      records: [{ id: 'record-1', text: 'deploy in sea', scope: req.context.scope }],
      nextCursor: 'cursor-2'
    })),
    get: vi.fn(async (req: any) => ({
      record: { id: req.id, text: 'deploy in sea', scope: req.context.scope, version: 'v1' }
    })),
    create: vi.fn(async (req: any) => ({
      record: { id: 'record-new', text: req.text, scope: req.context.scope, metadata: req.metadata }
    })),
    update: vi.fn(async (req: any) => ({
      record: { id: req.id, text: req.text, scope: req.context.scope, version: 'v2' }
    })),
    delete: vi.fn(async () => ({ deleted: true })),
    history: vi.fn(async (req: any) => ({
      events: [
        {
          id: 'event-1',
          event: 'update',
          at: '2026-07-16T00:00:00.000Z',
          record: { id: req.id, text: 'deploy in sea', scope: req.context.scope }
        }
      ]
    }))
  } as unknown as MemoryPluginClient
  const enqueue = vi.fn(() => ({ status: 'inserted' as const, operationId: 'operation-1' }))
  const markRecovered = vi.fn()
  const markDegraded = vi.fn()
  const clientFor = vi.fn(() => client)
  const specFor = vi.fn((id: string) => spec(id))
  const deps: ExternalMemoryRuntimeDeps = {
    registry: {
      clientFor,
      specFor,
      markRecovered,
      markDegraded
    } as unknown as ExternalMemoryRuntimeDeps['registry'],
    outbox: { enqueue },
    metrics: { recall: vi.fn(), recallInjected: vi.fn(), captureState: vi.fn(), outbox: vi.fn() }
  }
  return { deps, client, recall, enqueue, markRecovered, markDegraded, clientFor, specFor }
}

describe('ExternalMemoryProvider', () => {
  it('uses binding budgets and trusted agent scope for every-turn recall', async () => {
    const h = harness()
    const provider = new ExternalMemoryProvider(binding(), h.deps)
    const records = await provider.recallForTurn(
      { agentId: 'bot-a', sessionId: 'session-1' },
      { turnId: 'turn-1', query: 'where?', topK: 20, maxBytes: 32_768, timeoutMs: 3_000 }
    )
    expect(records).toHaveLength(1)
    expect(h.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        topK: 3,
        maxBytes: 4_096,
        context: expect.objectContaining({
          connection: { id: connectionA, config: { account: connectionA } },
          scope: { kind: 'agent', key: 'ac:agent:bot-a' }
        })
      }),
      expect.objectContaining({ timeoutMs: 250 })
    )
    expect(h.markRecovered).toHaveBeenCalledWith(connectionA, ['recall_unavailable', 'health_unavailable'])
  })

  it('forwards a raised cold-start recall budget to the plugin and does not degrade on success', async () => {
    const h = harness()
    // A local/self-hosted provider can need a multi-second cold-start budget the
    // old 3s ceiling forbade; the configured budget must reach the plugin call
    // and a healthy (if slow) recall must mark the connection ready, not degraded.
    const coldStart: ExternalMemoryBinding = {
      ...binding(),
      recall: { mode: 'auto', topK: 3, maxBytes: 4_096, timeoutMs: 8_000 }
    }
    const provider = new ExternalMemoryProvider(coldStart, h.deps)
    const records = await provider.recallForTurn(
      { agentId: 'bot-a', sessionId: 'session-1' },
      { turnId: 'turn-1', query: 'where?', topK: 3, maxBytes: 4_096, timeoutMs: 8_000 }
    )
    expect(records).toHaveLength(1)
    expect(h.recall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeoutMs: 8_000 }))
    expect(h.markRecovered).toHaveBeenCalledWith(connectionA, ['recall_unavailable', 'health_unavailable'])
    expect(h.markDegraded).not.toHaveBeenCalled()
  })

  it('skips tool-only recall and manual capture without touching the plugin/outbox', async () => {
    const h = harness()
    const toolOnly = { ...binding(connectionA, 'manual'), recall: { ...binding().recall, mode: 'tool-only' as const } }
    const provider = new ExternalMemoryProvider(toolOnly, h.deps)
    await expect(
      provider.recallForTurn(
        { agentId: 'bot-a' },
        { turnId: 'turn-1', query: 'q', topK: 5, maxBytes: 8_192, timeoutMs: 1_000 }
      )
    ).resolves.toEqual([])
    await provider.recordTurn(
      { agentId: 'bot-a' },
      { turnId: 'turn-1', input: 'remember', output: 'done', sessionId: 'session-1' }
    )
    expect(h.recall).not.toHaveBeenCalled()
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('durably enqueues turn capture and never reroutes it after a concurrent binding switch', async () => {
    const h = harness()
    let current = binding(connectionB)
    const dispatcher = createMemoryProvider({
      memoryFsFor: () => new LocalMemoryFs('/tmp/agent'),
      agentDirByAgent: () => '/tmp/agent',
      runtimeFor: () => undefined,
      providerKindFor: () => 'external',
      externalBindingFor: () => current,
      externalDeps: h.deps
    })
    const capturedAtTurnStart = binding(connectionA)
    const captureTarget = dispatcher.captureTargetForBinding(capturedAtTurnStart)
    current = binding(connectionB)
    await dispatcher.recordTurnForBinding(
      { agentId: 'bot-a', sessionId: 'session-1' },
      { turnId: 'turn-1', input: 'remember', output: 'done', sessionId: 'session-1' },
      capturedAtTurnStart,
      captureTarget
    )
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: connectionA,
        connectionRevision: 1,
        config: { account: connectionA },
        turnId: 'turn-1'
      })
    )
    expect(h.clientFor).toHaveBeenCalledTimes(1)
    expect(h.specFor).toHaveBeenCalledTimes(1)
  })

  it('fails recall open through the session boundary while emitting only a degraded fact code', async () => {
    const h = harness()
    h.recall.mockRejectedValueOnce(new Error('secret body that must not be logged'))
    const provider = new ExternalMemoryProvider(binding(), h.deps)
    await expect(
      provider.recallForTurn(
        { agentId: 'bot-a' },
        { turnId: 'turn-1', query: 'q', topK: 5, maxBytes: 8_192, timeoutMs: 1_000 }
      )
    ).rejects.toThrow()
    expect(h.markDegraded).toHaveBeenCalledWith(connectionA, 'recall_unavailable')
  })

  it('maps optional plugin operations to a canonical record admin surface and stable tools', async () => {
    const h = harness(['recall', 'capture', 'list', 'get', 'create', 'update', 'delete', 'history'])
    const provider = new ExternalMemoryProvider(binding(), h.deps)
    expect(provider.toolsForAgent().map((tool) => tool.name)).toEqual([
      'searchMemory',
      'saveMemory',
      'getMemory',
      'updateMemory',
      'deleteMemory'
    ])
    const admin = provider.adminSurface()
    expect(admin.shape).toBe('records')
    await expect(admin.list({ agentId: 'bot-a' }, { limit: 10 })).resolves.toMatchObject({
      records: [{ id: 'record-1', scope: { kind: 'agent', key: 'ac:agent:bot-a' } }],
      nextCursor: 'cursor-2'
    })
    await expect(
      admin.update({ agentId: 'bot-a' }, { operationId: 'op-1', id: 'record-1', text: 'deploy safely', version: 'v1' })
    ).resolves.toMatchObject({ id: 'record-1', version: 'v2' })
    expect(h.client.update).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-1',
        version: 'v1',
        context: expect.objectContaining({ scope: { kind: 'agent', key: 'ac:agent:bot-a' } })
      })
    )
    expect(h.markRecovered).toHaveBeenCalledWith(connectionA, ['admin_update_unavailable', 'health_unavailable'])
  })

  it('maps a profile-token version conflict without degrading the connection', async () => {
    const h = harness(['recall', 'capture', 'update'])
    vi.mocked(h.client.update).mockRejectedValueOnce(new MemoryPluginConflictError())
    const admin = new ExternalMemoryProvider(binding(), h.deps).adminSurface()
    await expect(
      admin.update(
        { agentId: 'bot-a' },
        { operationId: 'op-conflict', id: 'record-1', text: 'replacement', version: 'v1' }
      )
    ).rejects.toBeInstanceOf(MemoryConflictError)
    expect(h.markDegraded).not.toHaveBeenCalled()
  })

  it('maps a locally rejected record payload to bad input without degrading the connection', async () => {
    const h = harness(['recall', 'capture', 'create'])
    vi.mocked(h.client.create).mockRejectedValueOnce(new MemoryPluginInputError('record exceeds plugin limit'))
    const admin = new ExternalMemoryProvider(binding(), h.deps).adminSurface()
    await expect(
      admin.create({ agentId: 'bot-a' }, { operationId: 'op-large', text: 'oversized' })
    ).rejects.toBeInstanceOf(MemoryTooLargeError)
    expect(h.markDegraded).not.toHaveBeenCalled()
  })
})
