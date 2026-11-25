// The approvals the credential proxy checks a restricted MCP call against (mcp-tool-permissions.md §7.4).
import { createHash } from 'node:crypto'

/** Who approved a call, as `X-AC-Tool-Approval` carries it to the relay; an Always ask tool accepts only `person`. */
export type ApprovalSource = 'person' | 'runtime-review'

/** One approved call: the same call id, provider, tool and arguments may pass the proxy once. */
export interface ApprovalRecord {
  agentId: string
  toolCallId: string
  /** The MCP definition's name, so a call id never approves another provider's tool. */
  provider: string
  tool: string
  argsDigest: string
  source: ApprovalSource
  expiresAt: number
}

/** How long a record waits for its call. */
export const APPROVAL_TTL_MS = 2 * 60_000

/** How long the proxy waits for a record its call outran: ACP and the call travel separate paths. */
export const APPROVAL_WAIT_MS = 2_000

/** The most records one agent holds; the oldest goes first. */
export const MAX_APPROVALS_PER_AGENT = 256

/** JSON with every object's keys sorted, recursively; numbers and strings as JSON.stringify writes them. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** SHA-256 of a call's arguments as parsed values; absent arguments read as none, so `{}` and a missing field agree. */
export function argumentsDigest(args: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(args ?? {}))
    .digest('hex')
}

interface Waiter {
  accept: (record: ApprovalRecord) => boolean
  resolve: (record: ApprovalRecord | undefined) => void
}

/** In-memory records per agent, each used once; a call that arrives first waits briefly for its record. */
export class ApprovalRecords {
  private readonly byAgent = new Map<string, Map<string, ApprovalRecord>>()
  private readonly waiters = new Map<string, Set<Waiter>>()

  constructor(
    private readonly opts: {
      now?: () => number
      ttlMs?: number
      perAgent?: number
    } = {}
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** Write or replace the record for a call id, then hand it to a call already waiting for it. */
  put(record: Omit<ApprovalRecord, 'expiresAt'> & { expiresAt?: number }): void {
    const records = this.byAgent.get(record.agentId) ?? new Map<string, ApprovalRecord>()
    records.delete(record.toolCallId)
    records.set(record.toolCallId, {
      ...record,
      expiresAt: record.expiresAt ?? this.now() + (this.opts.ttlMs ?? APPROVAL_TTL_MS)
    })
    const limit = this.opts.perAgent ?? MAX_APPROVALS_PER_AGENT
    for (const id of records.keys()) {
      if (records.size <= limit) break
      records.delete(id)
    }
    this.byAgent.set(record.agentId, records)
    this.offer(record.agentId, record.toolCallId)
  }

  /** Replace a record's argument digest, keeping its expiry; false when it is gone. */
  refresh(agentId: string, toolCallId: string, argsDigest: string): boolean {
    const record = this.live(agentId, toolCallId)
    if (!record) return false
    record.argsDigest = argsDigest
    this.offer(agentId, toolCallId)
    return true
  }

  delete(agentId: string, toolCallId: string): void {
    const records = this.byAgent.get(agentId)
    records?.delete(toolCallId)
    if (records?.size === 0) this.byAgent.delete(agentId)
  }

  /** Drop every record of an agent, as when it leaves this daemon. */
  release(agentId: string): void {
    this.byAgent.delete(agentId)
  }

  get(agentId: string, toolCallId: string): ApprovalRecord | undefined {
    const record = this.live(agentId, toolCallId)
    return record && { ...record }
  }

  /** Consume the call's record once `accept` holds for it, waiting up to `waitMs` for one to be written or refreshed. */
  async take(
    agentId: string,
    toolCallId: string,
    accept: (record: ApprovalRecord) => boolean,
    waitMs = APPROVAL_WAIT_MS
  ): Promise<ApprovalRecord | undefined> {
    const now = this.tryTake(agentId, toolCallId, accept)
    if (now || waitMs <= 0) return now
    const key = waiterKey(agentId, toolCallId)
    return await new Promise<ApprovalRecord | undefined>((resolve) => {
      const waiters = this.waiters.get(key) ?? new Set<Waiter>()
      const waiter: Waiter = {
        accept,
        resolve: (record) => {
          clearTimeout(timer)
          waiters.delete(waiter)
          if (waiters.size === 0) this.waiters.delete(key)
          resolve(record)
        }
      }
      const timer = setTimeout(() => waiter.resolve(undefined), waitMs)
      timer.unref?.()
      waiters.add(waiter)
      this.waiters.set(key, waiters)
    })
  }

  private live(agentId: string, toolCallId: string): ApprovalRecord | undefined {
    const records = this.byAgent.get(agentId)
    const record = records?.get(toolCallId)
    if (record && record.expiresAt <= this.now()) {
      this.delete(agentId, toolCallId)
      return undefined
    }
    return record
  }

  private tryTake(
    agentId: string,
    toolCallId: string,
    accept: (record: ApprovalRecord) => boolean
  ): ApprovalRecord | undefined {
    const record = this.live(agentId, toolCallId)
    if (!record || !accept({ ...record })) return undefined
    this.delete(agentId, toolCallId)
    return record
  }

  // Waiters are offered the record in arrival order, so one record serves one call.
  private offer(agentId: string, toolCallId: string): void {
    for (const waiter of [...(this.waiters.get(waiterKey(agentId, toolCallId)) ?? [])]) {
      const record = this.tryTake(agentId, toolCallId, waiter.accept)
      if (record) {
        waiter.resolve(record)
        return
      }
    }
  }
}

function waiterKey(agentId: string, toolCallId: string): string {
  return `${agentId}\n${toolCallId}`
}
