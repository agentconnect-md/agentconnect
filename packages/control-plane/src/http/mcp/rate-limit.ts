/**
 * `http/mcp/rate-limit.ts` — per-credential sliding-window limits for MCP tool
 * calls (agent-assistant.md §6.5): 120 tool calls/min total, 30 write-tool
 * calls/min. CP-memory by design — the limit guards against a runaway AI
 * client, not distributed abuse. ONE instance per composition root, shared by
 * both mounts of the MCP plugin (`/api/v1/mcp` + the public `/v1` alias), so
 * hitting the alias cannot double a credential's budget.
 */
import type { Clock } from '../../domain/clock.js'

export interface McpRateLimits {
  /** Tool calls (read + write) admitted per window. */
  total: number
  /** Write-tool calls admitted per window (a strict subset of `total`). */
  write: number
  windowMs: number
}

export const DEFAULT_MCP_RATE_LIMITS: McpRateLimits = { total: 120, write: 30, windowMs: 60_000 }

/** Admission timestamps within the current window, oldest first. */
interface KeyWindow {
  total: number[]
  write: number[]
}

/** Idle-key GC cadence: sweep the map every N admission checks (see {@link McpRateLimiter#sweep}). */
const SWEEP_EVERY = 1024

export class McpRateLimiter {
  private readonly byKey = new Map<string, KeyWindow>()
  private checksSinceSweep = 0

  constructor(
    private readonly clock: Clock,
    private readonly limits: McpRateLimits = DEFAULT_MCP_RATE_LIMITS
  ) {}

  /**
   * Admit (and record) one tool call, or refuse it. Returns `null` when
   * admitted; whole seconds until a slot frees when refused. Refusals are NOT
   * recorded — a refused caller cannot push its own retry horizon further out.
   */
  check(key: string, write: boolean): number | null {
    const now = this.clock.now()
    this.sweep(now)
    const w = this.byKey.get(key) ?? { total: [], write: [] }
    prune(w.total, now, this.limits.windowMs)
    prune(w.write, now, this.limits.windowMs)
    if (w.total.length >= this.limits.total) return this.retryAfter(w.total, this.limits.total, now)
    if (write && w.write.length >= this.limits.write) return this.retryAfter(w.write, this.limits.write, now)
    w.total.push(now)
    if (write) w.write.push(now)
    this.byKey.set(key, w)
    return null
  }

  /** Seconds until the Nth-newest admission (N = limit) leaves the window and frees a slot. */
  private retryAfter(stamps: number[], limit: number, now: number): number {
    const freesAt = stamps[stamps.length - limit]! + this.limits.windowMs
    return Math.max(1, Math.ceil((freesAt - now) / 1000))
  }

  /** Drop keys with no admissions in the current window, every {@link SWEEP_EVERY}
   *  checks — revoked/rotated keys must not accrete map entries forever. */
  private sweep(now: number): void {
    if (++this.checksSinceSweep < SWEEP_EVERY) return
    this.checksSinceSweep = 0
    for (const [key, w] of this.byKey) {
      prune(w.total, now, this.limits.windowMs)
      if (w.total.length === 0) this.byKey.delete(key)
    }
  }
}

/** Admissions are appended in clock order — drop the expired prefix in place. */
function prune(stamps: number[], now: number, windowMs: number): void {
  let expired = 0
  while (expired < stamps.length && stamps[expired]! <= now - windowMs) expired++
  if (expired > 0) stamps.splice(0, expired)
}
