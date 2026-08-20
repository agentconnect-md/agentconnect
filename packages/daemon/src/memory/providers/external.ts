import type {
  ExternalMemoryBinding,
  MemoryEntry,
  MemoryConnectionSpec,
  MemoryPluginOperation
} from '@agentconnect.md/protocol'
import { randomUUID } from 'node:crypto'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'
import { externalMemoryTools } from '../tools.js'
import { MemoryConflictError, MemoryTooLargeError } from '../store.js'
import { canonicalAgentMemoryKey } from '../keys.js'
import type {
  EnqueueMemoryCapture,
  EnqueueMemoryCaptureResult,
  MemoryCaptureConnectionRegistry
} from '../../memory-plugin/outbox.js'
import { defaultMemoryPluginMetrics, type MemoryPluginMetrics } from '../../memory-plugin/metrics.js'
import {
  MemoryPluginConflictError,
  MemoryPluginInputError,
  type MemoryPluginClient
} from '../../memory-plugin/client.js'
import {
  MemoryProviderUnavailableError,
  type MemoryProvider,
  type MemoryRecord,
  type MemoryReadResult,
  type MemoryScope,
  type MemoryWriteResult,
  type RecallPolicy,
  type RecallRequest,
  type RecordMemoryAdmin,
  type TurnRecord
} from '../types.js'

/** The durable capture sink. Promise-returning is allowed: the outbox writes to the store. */
export interface MemoryCaptureEnqueueSink {
  enqueue(input: EnqueueMemoryCapture): EnqueueMemoryCaptureResult | Promise<EnqueueMemoryCaptureResult>
}

export interface ExternalMemoryRuntimeDeps {
  registry: MemoryCaptureConnectionRegistry
  outbox: MemoryCaptureEnqueueSink
  metrics?: MemoryPluginMetrics
  now?: () => number
}

/**
 * Secret-free connection definition captured at turn admission. Capturing this
 * before the model runs makes the post-delivery enqueue independent of a
 * concurrent provider/connection reconfiguration: an old turn is either sent
 * through its original definition or fenced by the outbox, never retargeted.
 */
export interface PreparedExternalMemoryCapture {
  connectionId: string
  connectionRevision: number
  pluginId: string
  manifestDigest: string
  config: Record<string, unknown>
  idempotency: 'operation-id' | 'none'
}

/**
 * Backend-neutral external provider. It derives the only v1 scope from the
 * trusted agent id, applies the binding's bounded recall policy, and turns
 * post-delivery captures into durable outbox rows. Raw plugin tools, endpoint
 * credentials, and backend-specific payloads never enter the model session.
 */
export class ExternalMemoryProvider implements MemoryProvider {
  readonly kind = 'external' as const
  private readonly metrics: MemoryPluginMetrics
  private readonly now: () => number

  constructor(
    private readonly binding: ExternalMemoryBinding,
    private readonly deps: ExternalMemoryRuntimeDeps
  ) {
    this.metrics = deps.metrics ?? defaultMemoryPluginMetrics
    this.now = deps.now ?? Date.now
  }

  runtimeEnv(): Record<string, string> {
    throw new Error('ExternalMemoryProvider.runtimeEnv must not be called — use memoryProviderFor at spawn')
  }

  async ensure(): Promise<void> {}

  async standingContextAtSessionStart(): Promise<string> {
    // External recall is query-dependent and runs on every activation. It must
    // never become a leading session/title block.
    return ''
  }

  recallPolicy(): RecallPolicy {
    return { ...this.binding.recall }
  }

  async recallForTurn(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]> {
    if (this.binding.recall.mode === 'tool-only' || !req.query.trim()) return []
    const startedAt = this.now()
    try {
      const { client, config } = this.connection()
      const output = await client.recall(
        {
          context: {
            requestId: randomUUID(),
            connection: { id: this.binding.connectionId, config },
            scope: { kind: 'agent', key: canonicalAgentMemoryKey(scope.agentId) }
          },
          query: req.query,
          topK: this.binding.recall.topK,
          maxBytes: this.binding.recall.maxBytes
        },
        { timeoutMs: this.binding.recall.timeoutMs, ...(req.signal ? { signal: req.signal } : {}) }
      )
      this.deps.registry.markRecovered(this.binding.connectionId, ['recall_unavailable', 'health_unavailable'])
      this.metrics.recall({
        durationMs: Math.max(0, this.now() - startedAt),
        outcome: output.records.length ? 'ok' : 'empty',
        resultCount: output.records.length
      })
      return output.records
    } catch (error) {
      this.deps.registry.markDegraded(this.binding.connectionId, 'recall_unavailable')
      this.metrics.recall({
        durationMs: Math.max(0, this.now() - startedAt),
        outcome: 'error',
        resultCount: 0
      })
      throw error
    }
  }

  async recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<void> {
    if (this.binding.capture.mode !== 'turn' || !turn.output.trim()) return
    return this.recordTurnWithTarget(scope, turn, this.prepareCaptureTarget())
  }

  prepareCaptureTarget(): PreparedExternalMemoryCapture {
    const { client, config, spec } = this.connection()
    // Connection config is protocol-validated JSON data. Clone it now so an
    // in-memory spec update during the turn cannot mutate the captured target.
    const capturedConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
    return {
      connectionId: this.binding.connectionId,
      connectionRevision: spec.revision,
      pluginId: client.manifest.plugin.id,
      manifestDigest: client.manifestDigest,
      config: capturedConfig,
      idempotency: client.manifest.capabilities.idempotency
    }
  }

  async recordTurnWithTarget(
    scope: MemoryScope,
    turn: TurnRecord,
    target: PreparedExternalMemoryCapture | undefined
  ): Promise<void> {
    if (this.binding.capture.mode !== 'turn' || !turn.output.trim()) return
    if (!turn.turnId) throw new MemoryProviderUnavailableError('external memory capture requires a stable turn id')
    if (!target || target.connectionId !== this.binding.connectionId) {
      throw new MemoryProviderUnavailableError('external memory capture target is unavailable')
    }
    const result = await this.deps.outbox.enqueue({
      agentId: scope.agentId,
      ...target,
      turnId: turn.turnId,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      input: turn.input,
      output: turn.output
    })
    if (result.status === 'full') {
      throw new MemoryProviderUnavailableError('external memory capture outbox is full')
    }
    if (result.status === 'conflict') {
      throw new MemoryProviderUnavailableError('external memory capture operation identity conflicted')
    }
  }

  tools(): ToolDescriptor[] {
    const { client } = this.connection()
    return externalMemoryTools(new Set(client.manifest.capabilities.operations))
  }

  toolsForAgent(): ToolDescriptor[] {
    return this.tools()
  }

  adminSurface(): RecordMemoryAdmin {
    const { client } = this.connection()
    const capabilities = new Set(client.manifest.capabilities.operations)
    return {
      shape: 'records',
      capabilities,
      search: (scope, req) => this.searchRecords(scope, req),
      list: (scope, req) =>
        this.adminCall('list', async () => {
          const connection = this.connection()
          const output = await connection.client.list({
            context: this.callContext(scope, connection),
            ...(req.cursor ? { cursor: req.cursor } : {}),
            limit: req.limit
          })
          return { records: output.records, ...(output.nextCursor ? { nextCursor: output.nextCursor } : {}) }
        }),
      get: (scope, id) =>
        this.adminCall('get', async () => {
          const connection = this.connection()
          return (await connection.client.get({ context: this.callContext(scope, connection), id })).record
        }),
      create: (scope, req) =>
        this.adminCall('create', async () => {
          const connection = this.connection()
          return (
            await connection.client.create({
              context: this.callContext(scope, connection),
              operationId: req.operationId,
              text: req.text,
              ...(req.metadata ? { metadata: req.metadata } : {})
            })
          ).record
        }),
      update: (scope, req) =>
        this.adminCall('update', async () => {
          const connection = this.connection()
          return (
            await connection.client.update({
              context: this.callContext(scope, connection),
              operationId: req.operationId,
              id: req.id,
              text: req.text,
              ...(req.metadata ? { metadata: req.metadata } : {}),
              ...(req.version ? { version: req.version } : {})
            })
          ).record
        }),
      delete: (scope, req) =>
        this.adminCall('delete', async () => {
          const connection = this.connection()
          return (
            await connection.client.delete({
              context: this.callContext(scope, connection),
              operationId: req.operationId,
              id: req.id,
              ...(req.version ? { version: req.version } : {})
            })
          ).deleted
        }),
      history: (scope, req) =>
        this.adminCall('history', async () => {
          const connection = this.connection()
          const output = await connection.client.history({
            context: this.callContext(scope, connection),
            id: req.id,
            ...(req.cursor ? { cursor: req.cursor } : {}),
            limit: req.limit
          })
          return { events: output.events, ...(output.nextCursor ? { nextCursor: output.nextCursor } : {}) }
        })
    }
  }

  async list(): Promise<MemoryEntry[]> {
    throw new MemoryProviderUnavailableError('external memory uses records, not files')
  }

  async read(_scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    throw new MemoryProviderUnavailableError(`external memory cannot read file ${path}`)
  }

  async write(_scope: MemoryScope, path: string): Promise<MemoryWriteResult> {
    throw new MemoryProviderUnavailableError(`external memory cannot write file ${path}`)
  }

  private connection(): { client: MemoryPluginClient; config: Record<string, unknown>; spec: MemoryConnectionSpec } {
    const spec = this.deps.registry.specFor(this.binding.connectionId)
    const client = this.deps.registry.clientFor(this.binding.connectionId)
    if (!spec || !client) {
      throw new MemoryProviderUnavailableError('external memory connection is temporarily unavailable')
    }
    return { client, config: spec.config, spec }
  }

  private callContext(
    scope: MemoryScope,
    connection: { config: Record<string, unknown> }
  ): {
    requestId: string
    connection: { id: string; config: Record<string, unknown> }
    scope: { kind: 'agent'; key: string }
  } {
    return {
      requestId: randomUUID(),
      connection: { id: this.binding.connectionId, config: connection.config },
      scope: { kind: 'agent', key: canonicalAgentMemoryKey(scope.agentId) }
    }
  }

  private async searchRecords(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]> {
    return this.adminCall('recall', async () => {
      const connection = this.connection()
      return (
        await connection.client.recall(
          {
            context: this.callContext(scope, connection),
            query: req.query,
            topK: req.topK,
            maxBytes: req.maxBytes
          },
          { timeoutMs: req.timeoutMs, ...(req.signal ? { signal: req.signal } : {}) }
        )
      ).records
    })
  }

  private async adminCall<T>(operation: MemoryPluginOperation, call: () => Promise<T>): Promise<T> {
    try {
      const result = await call()
      this.deps.registry.markRecovered(this.binding.connectionId, [
        `admin_${operation}_unavailable`,
        'health_unavailable'
      ])
      return result
    } catch (error) {
      if (error instanceof MemoryPluginConflictError) {
        throw new MemoryConflictError('memory record changed since the supplied version')
      }
      if (error instanceof MemoryPluginInputError) {
        throw new MemoryTooLargeError(error.message)
      }
      this.deps.registry.markDegraded(this.binding.connectionId, `admin_${operation}_unavailable`)
      throw error
    }
  }
}
