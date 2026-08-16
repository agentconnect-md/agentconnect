import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
import type { DataPlaneConfig } from './postgres-config.js'
import type {
  StoreBatchResult,
  StoreBatchStatement,
  StoreDatabase,
  StoreRunResult,
  StoreStatement
} from './local-store.js'

// Stored schema name — the pool's data lives here, so the literal outlives the vocabulary rename.
const POOL_STORE_SCHEMA = 'agentconnect_cloud_store'

type WorkerReply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: string }

const canonicalColumns = [
  'acpSessionId',
  'activationKey',
  'activeAt',
  'activeBytes',
  'activeCount',
  'agentCallDeliveryId',
  'agentId',
  'attachmentsJson',
  'attemptAt',
  'authorityGeneration',
  'authorityId',
  'automaticCount',
  'automaticWindowStartedAt',
  'backendOperationId',
  'callEnvelope',
  'callMeta',
  'capsJson',
  'channelId',
  'childSessionId',
  'claimedAt',
  'completedAt',
  'connectionId',
  'connectionRevision',
  'conversationId',
  'conversationKind',
  'correlationId',
  'cpPrivate',
  'cpRev',
  'createdAt',
  'defaultModel',
  'defaultPermissionMode',
  'deliveryReason',
  'dispatchId',
  'dreamId',
  'dueAt',
  'effortOverride',
  'endedAt',
  'enqueuedAt',
  'eventTimeUs',
  'executionSessionId',
  'expiresAt',
  'externalIntegrationId',
  'externalOriginJson',
  'externalProvider',
  'externalRealmKey',
  'externalResourceKey',
  'externalResourceKind',
  'failedAttempts',
  'fastModeOverride',
  'globalRules',
  'hookContext',
  'integrationId',
  'introducedAt',
  'isIm',
  'isQueueCmd',
  'lastDeliveredTs',
  'lastRunAt',
  'lastTurnOutcome',
  'launchCorrelationId',
  'localExcluded',
  'loopGuardCounted',
  'mainAgentId',
  'mainSessionKey',
  'manifestDigest',
  'memoryProvider',
  'modelId',
  'modelOverride',
  'modelsHash',
  'needsParentReply',
  'nextAttemptAt',
  'observedAt',
  'observedModel',
  'observedModelSet',
  'oldestActiveAt',
  'operationId',
  'orchestrationId',
  'organizationSuggestions',
  'orgId',
  'originSessionId',
  'ownerId',
  'outputModeOverride',
  'parentId',
  'payloadBytes',
  'payloadHash',
  'permissionModeOverride',
  'permissionModes',
  'platformMessageId',
  'pluginId',
  'postId',
  'posterPublishState',
  'profileId',
  'providerCheckpoint',
  'purgedAt',
  'queuedAt',
  'quoteJson',
  'reasonCode',
  'replyTarget',
  'reportClaimedAt',
  'reportOwnerId',
  'requesterId',
  'requesterName',
  'recoveryAt',
  'resolvedAt',
  'retractedAt',
  'revision',
  'routingEpoch',
  'runtimeId',
  'scopeKey',
  'sessionKey',
  'sessionId',
  'sessionIds',
  'seededAt',
  'snapshotDigest',
  'snapshotWrites',
  'sourceBindingKind',
  'spaceId',
  'statusBarTs',
  'stopReason',
  'terminalAt',
  'terminalReport',
  'tenantScope',
  'threadUrl',
  'toAgentId',
  'toolCallId',
  'touchedAt',
  'totalCount',
  'transportScope',
  'transcriptCoordinates',
  'trustedAgentBot',
  'triggerKind',
  'triggeredBy',
  'trippedAt',
  'turnId',
  'updatedAt',
  'windowStartedAt',
  'workspaceIsolation'
] as const

const columnNames = Object.fromEntries(canonicalColumns.map((name) => [name.toLowerCase(), name]))

class PostgresStatement implements StoreStatement {
  constructor(
    private readonly database: PostgresSyncDatabase,
    private readonly sql: string
  ) {}

  run(...params: unknown[]): StoreRunResult {
    const result = this.database.query(this.sql, params)
    return { changes: result.changes }
  }

  get(...params: unknown[]): unknown {
    return this.database.query(this.sql, params).rows[0]
  }

  all(...params: unknown[]): unknown[] {
    return this.database.query(this.sql, params).rows
  }
}

/** Synchronous facade over a dedicated PostgreSQL worker, preserving LocalStore's commit-before-return contract. */
export class PostgresSyncDatabase implements StoreDatabase {
  private readonly worker: Worker
  private readonly replies
  private nextId = 1
  private closed = false

  constructor(
    config: DataPlaneConfig,
    private readonly onFailure: (error: Error) => void = () => undefined
  ) {
    const channel = new MessageChannel()
    const readySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    this.replies = channel.port1
    this.worker = new Worker(new URL('./postgres-store-worker.js', import.meta.url), {
      workerData: {
        databaseUrl: config.databaseUrl,
        schema: POOL_STORE_SCHEMA,
        columnNames,
        replyPort: channel.port2,
        readySignal
      },
      transferList: [channel.port2]
    })
    if (Atomics.wait(readySignal, 0, 0, 30_000) === 'timed-out') {
      void this.worker.terminate()
      throw new Error('PostgreSQL pool store startup timed out after 30 seconds')
    }
    const ready = this.waitForReply(0)
    if (!ready.ok) throw new Error(`PostgreSQL pool store failed to open: ${ready.error}`)
  }

  exec(sql: string): void {
    this.request('exec', sql, [])
  }

  prepare(sql: string): StoreStatement {
    return new PostgresStatement(this, sql)
  }

  query(sql: string, params: unknown[]): { rows: unknown[]; changes: number } {
    const value = this.request('query', sql, params) as { rows?: unknown[]; changes?: number } | undefined
    return { rows: value?.rows ?? [], changes: value?.changes ?? 0 }
  }

  /** One round trip for an ordered statement list. The worker still runs each statement on its
   *  own — same rewrite, same per-statement commit — so only the number of blocking hand-offs
   *  changes. An error names the statement that failed and abandons the rest, exactly as the
   *  equivalent run of single-statement calls would. */
  batch(statements: StoreBatchStatement[]): StoreBatchResult[] {
    if (statements.length === 0) return []
    const value = this.request('batch', '', [], statements) as { rows?: unknown[]; changes?: number }[] | undefined
    return (value ?? []).map((result) => ({ rows: result?.rows ?? [], changes: result?.changes ?? 0 }))
  }

  finishSchemaInitialization(): void {
    this.request('finishSchemaInitialization', '', [])
  }

  close(): void {
    if (this.closed) return
    this.request('close', '', [])
    this.closed = true
    void this.worker.terminate()
    this.replies.close()
  }

  private request(kind: string, sql: string, params: unknown[], statements?: StoreBatchStatement[]): unknown {
    if (this.closed) throw new Error('PostgreSQL pool store is closed')
    const id = this.nextId++
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    this.worker.postMessage({ id, kind, sql, params, statements, signal })
    if (Atomics.wait(signal, 0, 0, 30_000) === 'timed-out') {
      const error = new Error('PostgreSQL pool store operation timed out after 30 seconds')
      this.onFailure(error)
      throw error
    }
    const reply = this.waitForReply(id)
    if (!reply.ok) {
      const error = new Error(reply.error)
      this.onFailure(error)
      throw error
    }
    return reply.value
  }

  private waitForReply(id: number): WorkerReply {
    for (;;) {
      const received = receiveMessageOnPort(this.replies)
      if (received) {
        const reply = received.message as WorkerReply
        if (reply.id === id) return reply
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    }
  }
}
