// Reports audit records to the Control Plane (computer-use.md §8.2): queued in memory, sent in acked batches, typed text by length only.
import { randomUUID } from 'node:crypto'
import {
  COMPUTER_AUDIT_BATCH_MAX,
  computerAuditArgs,
  type ComputerAuditEntry
} from '@agentconnect.md/protocol/computer'
import type { AuditRecord, AuditSink } from '../audit.js'

/** The oldest entries are dropped beyond this while the Control Plane is unreachable. */
const MAX_QUEUED = 2000
const FLUSH_EVERY_MS = 2000

/** One record as the CP stores it: no typed text, bounded strings. */
export function auditEntry(record: AuditRecord, at: Date, id: string = randomUUID()): ComputerAuditEntry {
  const summary = computerAuditArgs(record.args)
  return {
    id,
    at: at.toISOString(),
    tool: record.tool.slice(0, 128),
    client: record.client.slice(0, 512),
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    outcome: record.outcome,
    ...(record.code ? { code: record.code.slice(0, 64) } : {}),
    ...(record.approval ? { approval: record.approval } : {}),
    args: summary.args,
    ...(summary.textLength !== undefined ? { textLength: summary.textLength } : {}),
    ms: Math.max(0, Math.round(record.ms))
  }
}

export interface AuditReporterDeps {
  /** Send one batch; true once the CP stored it, false when it cannot take it now. */
  send(entries: ComputerAuditEntry[]): Promise<boolean>
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
      const batch = this.queue.slice(0, COMPUTER_AUDIT_BATCH_MAX)
      let stored = false
      try {
        stored = await this.deps.send(batch)
      } catch (error) {
        this.deps.log(`audit: report failed: ${(error as Error).message}`)
      }
      if (!stored) return
      // Records may have been queued or dropped meanwhile, so the sent ones are removed by id.
      const sent = new Set(batch.map((entry) => entry.id))
      this.queue = this.queue.filter((entry) => !sent.has(entry.id))
    }
  }
}
