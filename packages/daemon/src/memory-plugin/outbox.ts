import { createHash, randomUUID } from 'node:crypto'
import type { MemoryConnectionSpec, MemoryPluginManifest } from '@agentconnect.md/protocol'
import { canonicalAgentMemoryKey } from '../agents/memory-recall.js'
import type { LocalStore, MemoryCaptureOutboxRow } from '../store/local-store.js'
import type { MemoryPluginClient } from './client.js'
import { defaultMemoryPluginMetrics, type MemoryPluginMetrics } from './metrics.js'

export const MEMORY_CAPTURE_INPUT_MAX_BYTES = 16 * 1024
export const MEMORY_CAPTURE_OUTPUT_MAX_BYTES = 32 * 1024
export const MEMORY_CAPTURE_MAX_ACTIVE_ITEMS = 10_000
export const MEMORY_CAPTURE_MAX_ACTIVE_BYTES = 64 * 1024 * 1024
export const MEMORY_CAPTURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const MEMORY_CAPTURE_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000
const UNAVAILABLE_RETRY_MS = 5_000
const ACCEPTED_POLL_MS = 2_000
const MAX_CAPTURE_ATTEMPTS = 8
const DRAIN_BATCH = 100

export interface MemoryCaptureConnectionRegistry {
  clientFor(connectionId: string): MemoryPluginClient | undefined
  specFor(connectionId: string): MemoryConnectionSpec | undefined
  markDegraded(connectionId: string, reasonCode?: string): void
  markRecovered(connectionId: string, reasonCodes: readonly string[]): void
}

export interface EnqueueMemoryCapture {
  agentId: string
  connectionId: string
  connectionRevision: number
  pluginId: string
  manifestDigest?: string
  config: Record<string, unknown>
  idempotency: MemoryPluginManifest['capabilities']['idempotency']
  turnId: string
  sessionId?: string
  input: string
  output: string
}

export type EnqueueMemoryCaptureResult =
  { status: 'inserted' | 'duplicate'; operationId: string } | { status: 'full' | 'conflict'; operationId: string }

export interface MemoryCaptureOutboxOptions {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  metrics?: MemoryPluginMetrics
  log?: { warn(message: string): void }
  maxActiveItems?: number
  maxActiveBytes?: number
  retryBaseMs?: number
  retryMaxMs?: number
  unavailableRetryMs?: number
  acceptedPollMs?: number
  maxCaptureAttempts?: number
  maxAgeMs?: number
  terminalRetentionMs?: number
}

function boundedIdentity(prefix: string, value: string): string {
  if (value.length > 0 && value.length <= 512) return value
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`
}

function utf8Head(buf: Buffer, maxBytes: number): string {
  return buf
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/, '')
}

function utf8Tail(buf: Buffer, maxBytes: number): string {
  return buf
    .subarray(Math.max(0, buf.length - maxBytes))
    .toString('utf8')
    .replace(/^\uFFFD+/, '')
}

/** Preserve both the opening and conclusion of a response while bounding the
 * copied daemon-local payload on UTF-8 codepoint boundaries. */
export function boundedCaptureText(text: string, maxBytes: number): string {
  const buf = Buffer.from(text)
  if (buf.length <= maxBytes) return text
  const marker = '\n[…capture truncated…]\n'
  const markerBytes = Buffer.byteLength(marker)
  if (maxBytes <= markerBytes) return utf8Head(buf, maxBytes)
  const contentBytes = maxBytes - markerBytes
  const headBytes = Math.ceil(contentBytes / 2)
  return `${utf8Head(buf, headBytes)}${marker}${utf8Tail(buf, contentBytes - headBytes)}`
}

function operationIdFor(input: Pick<EnqueueMemoryCapture, 'agentId' | 'connectionId' | 'turnId'>): string {
  const digest = createHash('sha256')
    .update(input.agentId)
    .update('\0')
    .update(input.connectionId)
    .update('\0')
    .update(input.turnId)
    .digest('hex')
  return `ac:capture:${digest}`
}

function payloadHashFor(input: {
  pluginId: string
  connectionRevision: number
  manifestDigest: string | null
  config: string
  scopeKey: string
  sessionId: string | null
  input: string
  output: string
  idempotency: 'operation-id' | 'none'
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`
}

function retryDelay(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1))
}

function definitionMismatch(
  row: MemoryCaptureOutboxRow,
  spec: MemoryConnectionSpec,
  client: MemoryPluginClient
): 'connection_revision_changed' | 'plugin_id_changed' | 'manifest_mismatch' | 'idempotency_changed' | undefined {
  if (spec.revision !== row.connectionRevision) return 'connection_revision_changed'
  if (client.manifest.plugin.id !== row.pluginId) return 'plugin_id_changed'
  if (row.manifestDigest != null && client.manifestDigest !== row.manifestDigest) return 'manifest_mismatch'
  if (client.manifest.capabilities.idempotency !== row.idempotency) return 'idempotency_changed'
  return undefined
}

/**
 * Durable, single-writer capture pump. The user reply is delivered before
 * `enqueue`; this worker owns every external side effect afterward.
 */
export class MemoryCaptureOutbox {
  private readonly now: () => number
  private readonly setTimer: NonNullable<MemoryCaptureOutboxOptions['setTimer']>
  private readonly clearTimer: NonNullable<MemoryCaptureOutboxOptions['clearTimer']>
  private readonly metrics: MemoryPluginMetrics
  private timer?: ReturnType<typeof setTimeout>
  private inFlight?: Promise<void>
  private running = false
  private wakeRequested = false

  constructor(
    private readonly store: LocalStore,
    private readonly registry: MemoryCaptureConnectionRegistry,
    private readonly options: MemoryCaptureOutboxOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.metrics = options.metrics ?? defaultMemoryPluginMetrics
  }

  start(): void {
    if (this.running) return
    this.running = true
    const now = this.now()
    const recovered = this.store.recoverMemoryCaptures(now)
    if (recovered.retried > 0) {
      this.metrics.captureState('retry', { count: recovered.retried, reason: 'restart_retry' })
    }
    if (recovered.ambiguous > 0) {
      this.metrics.captureState('ambiguous', { count: recovered.ambiguous, reason: 'restart_after_send' })
    }
    this.expire(now)
    this.observe(now)
    this.wake()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    await this.inFlight
  }

  enqueue(input: EnqueueMemoryCapture): EnqueueMemoryCaptureResult {
    const now = this.now()
    this.expire(now)
    const operationId = operationIdFor(input)
    const existing = this.store.getMemoryCapture(operationId)
    const boundedInput = boundedCaptureText(input.input, MEMORY_CAPTURE_INPUT_MAX_BYTES)
    const boundedOutput = boundedCaptureText(input.output, MEMORY_CAPTURE_OUTPUT_MAX_BYTES)
    const config = JSON.stringify(input.config)
    const scopeKey = canonicalAgentMemoryKey(input.agentId)
    const sessionId = input.sessionId ? boundedIdentity('session', input.sessionId) : null
    const manifestDigest = input.manifestDigest ?? null
    const payloadHash = payloadHashFor({
      pluginId: input.pluginId,
      connectionRevision: input.connectionRevision,
      manifestDigest,
      config,
      scopeKey,
      sessionId,
      input: boundedInput,
      output: boundedOutput,
      idempotency: input.idempotency
    })
    const row: MemoryCaptureOutboxRow = {
      operationId,
      turnId: boundedIdentity('turn', input.turnId),
      agentId: input.agentId,
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision,
      pluginId: input.pluginId,
      manifestDigest,
      config,
      scopeKey,
      sessionId,
      input: boundedInput,
      output: boundedOutput,
      payloadHash,
      payloadBytes: Buffer.byteLength(boundedInput) + Buffer.byteLength(boundedOutput) + Buffer.byteLength(config),
      idempotency: input.idempotency,
      state: 'pending',
      attempts: 0,
      backendOperationId: null,
      reasonCode: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now
    }
    if (!existing) {
      const stats = this.store.memoryCaptureStats()
      const maxItems = this.options.maxActiveItems ?? MEMORY_CAPTURE_MAX_ACTIVE_ITEMS
      const maxBytes = this.options.maxActiveBytes ?? MEMORY_CAPTURE_MAX_ACTIVE_BYTES
      if (stats.activeCount >= maxItems || stats.activeBytes + row.payloadBytes > maxBytes) {
        this.observe(now)
        return { status: 'full', operationId }
      }
    }
    const status = this.store.appendMemoryCapture(row)
    this.observe(now)
    if (status === 'inserted') this.wake()
    return { status, operationId }
  }

  snapshot() {
    return this.store.memoryCaptureStats()
  }

  wake(): void {
    if (!this.running) return
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    if (this.inFlight) {
      this.wakeRequested = true
      return
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.inFlight = this.drain().finally(() => {
        this.inFlight = undefined
        if (this.wakeRequested) {
          this.wakeRequested = false
          this.wake()
        } else {
          this.scheduleNext()
        }
      })
    }, 0)
    this.timer.unref?.()
  }

  private async drain(): Promise<void> {
    for (let i = 0; this.running && i < DRAIN_BATCH; i += 1) {
      const now = this.now()
      this.expire(now)
      const row = this.store.nextDueMemoryCapture(now)
      if (!row) break
      if (row.state === 'accepted') await this.pollAccepted(row)
      else await this.sendPending(row)
    }
    this.observe(this.now())
  }

  private scheduleNext(): void {
    if (!this.running || this.timer || this.inFlight) return
    const dueAt = this.store.nextMemoryCaptureDueAt()
    const maintenanceAt = this.store.nextMemoryCaptureMaintenanceAt(
      this.options.maxAgeMs ?? MEMORY_CAPTURE_MAX_AGE_MS,
      this.options.terminalRetentionMs ?? MEMORY_CAPTURE_TERMINAL_RETENTION_MS
    )
    const nextAt =
      dueAt === undefined ? maintenanceAt : maintenanceAt === undefined ? dueAt : Math.min(dueAt, maintenanceAt)
    if (nextAt === undefined) return
    const delay = Math.max(0, nextAt - this.now())
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.wake()
    }, delay)
    this.timer.unref?.()
  }

  private currentClient(row: MemoryCaptureOutboxRow): MemoryPluginClient | undefined {
    const spec = this.registry.specFor(row.connectionId)
    const client = this.registry.clientFor(row.connectionId)
    if (!spec || !client) return undefined
    const mismatch = definitionMismatch(row, spec, client)
    if (mismatch) {
      this.finish(row, 'failed', mismatch)
      return undefined
    }
    return client
  }

  private async sendPending(row: MemoryCaptureOutboxRow): Promise<void> {
    const client = this.currentClient(row)
    if (!client) {
      if (this.store.getMemoryCapture(row.operationId)?.state === 'pending') {
        const now = this.now()
        this.store.deferPendingMemoryCapture(
          row.operationId,
          now + (this.options.unavailableRetryMs ?? UNAVAILABLE_RETRY_MS),
          now,
          'connection_unavailable'
        )
      }
      return
    }
    const now = this.now()
    const claimed = this.store.claimMemoryCapture(row.operationId, now)
    if (!claimed) return
    if (claimed.attempts > (this.options.maxCaptureAttempts ?? MAX_CAPTURE_ATTEMPTS)) {
      this.finish(claimed, 'failed', 'retry_exhausted')
      return
    }
    let config: Record<string, unknown>
    try {
      config = JSON.parse(claimed.config) as Record<string, unknown>
    } catch {
      this.finish(claimed, 'failed', 'invalid_persisted_config')
      return
    }
    try {
      const receipt = await client.capture({
        context: {
          requestId: randomUUID(),
          connection: { id: claimed.connectionId, config },
          scope: { kind: 'agent', key: claimed.scopeKey }
        },
        operationId: claimed.operationId,
        turn: {
          turnId: claimed.turnId,
          ...(claimed.sessionId ? { sessionId: claimed.sessionId } : {}),
          input: claimed.input,
          output: claimed.output
        }
      })
      if (receipt.state === 'completed' || receipt.state === 'accepted') {
        this.registry.markRecovered(claimed.connectionId, [
          'capture_unavailable',
          'capture_failed',
          'health_unavailable'
        ])
      } else {
        this.registry.markDegraded(claimed.connectionId, 'capture_failed')
      }
      this.applyReceipt(claimed, receipt)
    } catch {
      this.registry.markDegraded(claimed.connectionId, 'capture_unavailable')
      if (claimed.idempotency === 'operation-id') {
        const retryAt =
          this.now() +
          retryDelay(
            claimed.attempts,
            this.options.retryBaseMs ?? RETRY_BASE_MS,
            this.options.retryMaxMs ?? RETRY_MAX_MS
          )
        this.store.retryMemoryCapture(claimed.operationId, retryAt, this.now(), 'capture_retry')
        this.metrics.captureState('retry', {
          ageMs: Math.max(0, this.now() - claimed.createdAt),
          reason: 'capture_retry'
        })
      } else {
        // Once the call begins, transport failure cannot prove that a
        // non-idempotent write had no effect. Never duplicate it automatically.
        this.finish(claimed, 'ambiguous', 'capture_delivery_unknown')
      }
    }
  }

  private async pollAccepted(row: MemoryCaptureOutboxRow): Promise<void> {
    const client = this.currentClient(row)
    if (!client) {
      if (this.store.getMemoryCapture(row.operationId)?.state === 'accepted') {
        const now = this.now()
        this.store.rescheduleAcceptedMemoryCapture(
          row.operationId,
          now + (this.options.unavailableRetryMs ?? UNAVAILABLE_RETRY_MS),
          now
        )
      }
      return
    }
    if (!row.backendOperationId) {
      this.finish(row, 'failed', 'accepted_without_backend_operation')
      return
    }
    let config: Record<string, unknown>
    try {
      config = JSON.parse(row.config) as Record<string, unknown>
    } catch {
      this.finish(row, 'failed', 'invalid_persisted_config')
      return
    }
    try {
      const receipt = await client.operationStatus({
        context: {
          requestId: randomUUID(),
          connection: { id: row.connectionId, config },
          scope: { kind: 'agent', key: row.scopeKey }
        },
        operationId: row.operationId,
        backendOperationId: row.backendOperationId
      })
      if (receipt.state === 'completed' || receipt.state === 'accepted') {
        this.registry.markRecovered(row.connectionId, ['capture_status_unavailable', 'health_unavailable'])
      } else {
        this.registry.markDegraded(row.connectionId, 'capture_failed')
      }
      if (receipt.state === 'accepted') {
        const now = this.now()
        this.store.rescheduleAcceptedMemoryCapture(
          row.operationId,
          now + (this.options.acceptedPollMs ?? ACCEPTED_POLL_MS),
          now
        )
      } else {
        this.applyReceipt(row, receipt)
      }
    } catch {
      this.registry.markDegraded(row.connectionId, 'capture_status_unavailable')
      const now = this.now()
      this.store.rescheduleAcceptedMemoryCapture(
        row.operationId,
        now + (this.options.unavailableRetryMs ?? UNAVAILABLE_RETRY_MS),
        now
      )
    }
  }

  private applyReceipt(
    row: MemoryCaptureOutboxRow,
    receipt: { state: 'completed' | 'accepted' | 'failed' | 'ambiguous'; backendOperationId?: string }
  ): void {
    if (receipt.state === 'accepted') {
      if (!receipt.backendOperationId) {
        this.finish(row, 'failed', 'accepted_without_backend_operation')
        return
      }
      const now = this.now()
      this.store.acceptMemoryCapture(
        row.operationId,
        receipt.backendOperationId,
        now + (this.options.acceptedPollMs ?? ACCEPTED_POLL_MS),
        now
      )
      this.metrics.captureState('accepted', { ageMs: Math.max(0, now - row.createdAt) })
      return
    }
    this.finish(row, receipt.state, `plugin_${receipt.state}`)
  }

  private finish(
    row: Pick<MemoryCaptureOutboxRow, 'operationId' | 'createdAt'>,
    state: 'completed' | 'failed' | 'ambiguous',
    reasonCode:
      | 'plugin_completed'
      | 'plugin_failed'
      | 'plugin_ambiguous'
      | 'connection_revision_changed'
      | 'plugin_id_changed'
      | 'manifest_mismatch'
      | 'idempotency_changed'
      | 'retry_exhausted'
      | 'invalid_persisted_config'
      | 'capture_delivery_unknown'
      | 'accepted_without_backend_operation'
  ): void {
    const now = this.now()
    if (this.store.finishMemoryCapture(row.operationId, state, now, reasonCode)) {
      this.metrics.captureState(state, { ageMs: Math.max(0, now - row.createdAt), reason: reasonCode })
      if (state !== 'completed') {
        // Metadata only. Never include plugin errors, turn text, or config.
        this.options.log?.warn(`memory capture ${row.operationId} ended ${state} (${reasonCode})`)
      }
    }
  }

  private observe(now: number): void {
    this.metrics.outbox(this.store.memoryCaptureStats(), now)
  }

  private expire(now: number): void {
    const expired = this.store.expireMemoryCaptures(
      now - (this.options.maxAgeMs ?? MEMORY_CAPTURE_MAX_AGE_MS),
      now - (this.options.terminalRetentionMs ?? MEMORY_CAPTURE_TERMINAL_RETENTION_MS),
      now
    )
    if (expired.expired > 0) {
      this.metrics.captureState('failed', { count: expired.expired, reason: 'retention_expired' })
    }
  }
}
