// Reports audit records to the Control Plane (computer-use.md §8.2): queued in memory, sent in acked batches, typed text by length only.
import { randomUUID } from 'node:crypto'
import {
  COMPUTER_AUDIT_BATCH_BYTES,
  COMPUTER_AUDIT_BATCH_MAX,
  computerAuditArgs,
  computerAuditText,
  type ComputerAuditEntry
} from '@agentconnect.md/protocol/computer'
import type { AuditRecord, AuditSink } from '../audit.js'

/** The oldest entries are dropped beyond this while the Control Plane is unreachable. */
const MAX_QUEUED = 2000
const FLUSH_EVERY_MS = 2000

/** One record as the CP stores it: no typed text, bounded strings. */
export function auditEntry(record: AuditRecord, at: Date, id: string = randomUUID()): ComputerAuditEntry {
  const summary = computerAuditArgs(record.args)
  const text = (value: string | undefined, max: number) => (value ? computerAuditText(value.slice(0, max)) : '')
  const sessionId = text(record.sessionId, 256)
  const code = text(record.code, 64)
  return {
    id,
    at: at.toISOString(),
    tool: text(record.tool, 128) || 'unknown',
    client: text(record.client, 512) || 'unknown',
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    outcome: record.outcome,
    ...(code ? { code } : {}),
    ...(record.approval ? { approval: record.approval } : {}),
    args: summary.args,
    ...(summary.textLength !== undefined ? { textLength: summary.textLength } : {}),
    ms: Math.max(0, Math.round(record.ms))
  }
}

/** How the CP answered a batch: stored, not now (retry later), or never (resending it cannot help). */
export type AuditSendResult = 'stored' | 'retry' | 'rejected'

export interface AuditReporterDeps {
  send(entries: ComputerAuditEntry[]): Promise<AuditSendResult>
  log: (line: string) => void
  now?: () => number
  maxQueued?: number
}

export class AuditReporter {
  private queue: ComputerAuditEntry[] = []
  private dropped = 0
  private flushing: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly now: () => number
  private readonly maxQueued: number

  constructor(private readonly deps: AuditReporterDeps) {
    this.now = deps.now ?? Date.now
    this.maxQueued = deps.maxQueued ?? MAX_QUEUED
  }

  readonly sink: AuditSink = (record) => {
    this.queue.push(auditEntry(record, new Date(this.now())))
    if (this.queue.length > this.maxQueued) {
      this.queue.shift()
      this.dropped++
    }
  }

  get pending(): number {
    return this.queue.length
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), FLUSH_EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Send what is queued, oldest first, until the CP stops taking it. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => (this.flushing = undefined))
    return this.flushing
  }

  private async drain(): Promise<void> {
    if (this.dropped > 0) {
      this.deps.log(`audit: ${this.dropped} entries were dropped while the Control Plane was unreachable`)
      this.dropped = 0
    }
    while (this.queue.length > 0) {
      const batch = nextBatch(this.queue)
      const result = await this.send(batch)
      if (result === 'retry') return
      // A refused batch is resent one entry at a time, so one bad entry never holds back the rest.
      if (result === 'rejected' && batch.length > 1) {
        for (const entry of batch) {
          const alone = await this.send([entry])
          if (alone === 'retry') return
          if (alone === 'rejected')
            this.deps.log(`audit: the Control Plane refused entry ${entry.id} (${entry.tool}); dropped`)
          this.remove([entry])
        }
        continue
      }
      if (result === 'rejected')
        this.deps.log(`audit: the Control Plane refused entry ${batch[0]!.id} (${batch[0]!.tool}); dropped`)
      this.remove(batch)
    }
  }

  private async send(entries: ComputerAuditEntry[]): Promise<AuditSendResult> {
    try {
      return await this.deps.send(entries)
    } catch (error) {
      this.deps.log(`audit: report failed: ${(error as Error).message}`)
      return 'retry'
    }
  }

  // Records may have been queued or dropped meanwhile, so the sent ones are removed by id.
  private remove(entries: ComputerAuditEntry[]): void {
    const sent = new Set(entries.map((entry) => entry.id))
    this.queue = this.queue.filter((entry) => !sent.has(entry.id))
  }
}

/** The oldest entries that fit one frame, by count and by encoded bytes; always at least one. */
export function nextBatch(queue: readonly ComputerAuditEntry[]): ComputerAuditEntry[] {
  const batch: ComputerAuditEntry[] = []
  let bytes = 0
  for (const entry of queue) {
    if (batch.length >= COMPUTER_AUDIT_BATCH_MAX) break
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1
    if (batch.length > 0 && bytes + size > COMPUTER_AUDIT_BATCH_BYTES) break
    batch.push(entry)
    bytes += size
  }
  return batch
}
