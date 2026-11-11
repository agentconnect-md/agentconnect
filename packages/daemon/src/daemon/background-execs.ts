import type { HostKey } from '../acp/host-key.js'
import { pendingTurnOwner } from './turn-types.js'

const TERMINAL_STATUSES = new Set(['completed', 'failed'])

interface ToolUpdate {
  sessionUpdate?: unknown
  toolCallId?: unknown
  kind?: unknown
  status?: unknown
}

/** The terminal tool call an update settles, or undefined. */
function settledCall(update: unknown): string | undefined {
  const u = update as ToolUpdate | null
  if (!u || u.sessionUpdate !== 'tool_call_update' || typeof u.toolCallId !== 'string') return undefined
  return TERMINAL_STATUSES.has(String(u.status)) ? u.toolCallId : undefined
}

/** Track a turn's open execute calls from one of its updates: opened by `tool_call`, closed by a terminal update. */
export function noteOpenExec(open: Map<string, number>, update: unknown, now: number): void {
  const settled = settledCall(update)
  if (settled) {
    open.delete(settled)
    return
  }
  const u = update as ToolUpdate | null
  if (u?.sessionUpdate !== 'tool_call' || u.kind !== 'execute' || typeof u.toolCallId !== 'string' || !u.toolCallId)
    return
  if (!TERMINAL_STATUSES.has(String(u.status))) open.set(u.toolCallId, now)
}

/** Execute calls a turn ended with still running (a runtime's background terminal), per lease key, until their terminal update arrives. */
export class BackgroundExecs {
  private readonly byLease = new Map<string, { agentId: string; calls: Map<string, number> }>()

  /** `ceilingMs` bounds how long one call counts from its start; both are read only while a call is held. */
  constructor(
    private readonly now: () => number,
    private readonly ceilingMs: () => number
  ) {}

  /** Take over the calls a cleanly ended turn left open. */
  adopt(leaseKey: string, agentId: string, open: ReadonlyMap<string, number> | undefined): void {
    if (!open?.size) return
    const entry = this.byLease.get(leaseKey) ?? { agentId, calls: new Map<string, number>() }
    for (const [id, startedAt] of open) entry.calls.set(id, startedAt)
    this.byLease.set(leaseKey, entry)
  }

  /** Release the call a terminal update settles, in a later turn or outside any. */
  settle(leaseKey: string, update: unknown): void {
    const id = settledCall(update)
    const entry = id ? this.byLease.get(leaseKey) : undefined
    if (!entry || !id) return
    entry.calls.delete(id)
    if (entry.calls.size === 0) this.byLease.delete(leaseKey)
  }

  /** Whether the session still runs one. */
  live(leaseKey: string): boolean {
    const entry = this.byLease.get(leaseKey)
    return !!entry && this.running(entry.calls)
  }

  /** Whether any of the agent's sessions still runs one. */
  agentLive(agentId: string): boolean {
    for (const entry of this.byLease.values()) if (entry.agentId === agentId && this.running(entry.calls)) return true
    return false
  }

  /** Whether any session one host owns still runs one. */
  ownerLive(owner: HostKey): boolean {
    for (const [key, entry] of this.byLease)
      if (pendingTurnOwner(key) === owner && this.running(entry.calls)) return true
    return false
  }

  /** The lease keys of the sessions one host owns that still run one. */
  ownerLiveKeys(owner: HostKey): string[] {
    return [...this.byLease]
      .filter(([key, entry]) => pendingTurnOwner(key) === owner && this.running(entry.calls))
      .map(([key]) => key)
  }

  drop(leaseKey: string): void {
    this.byLease.delete(leaseKey)
  }

  dropAgent(agentId: string): void {
    for (const [key, entry] of this.byLease) if (entry.agentId === agentId) this.byLease.delete(key)
  }

  dropOwner(owner: HostKey): void {
    for (const key of this.byLease.keys()) if (pendingTurnOwner(key) === owner) this.byLease.delete(key)
  }

  private running(calls: ReadonlyMap<string, number>): boolean {
    const now = this.now()
    const ceilingMs = this.ceilingMs()
    for (const startedAt of calls.values()) if (now - startedAt <= ceilingMs) return true
    return false
  }
}
