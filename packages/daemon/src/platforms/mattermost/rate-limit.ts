// Mattermost REST rate-limit backoff (429 Retry-After / X-RateLimit-Reset) and per-channel FIFO send queues.
import { PlatformSendQueue } from '../send-queue.js'

export const MATTERMOST_DEFAULT_RETRY_AFTER_MS = 1_000
export const MATTERMOST_MAX_RETRY_AFTER_MS = 60_000
export const MATTERMOST_DEFAULT_SEND_INTERVAL_MS = 100
export const MATTERMOST_QUEUE_TIMEOUT_MS = 30_000
const MAX_CHANNEL_QUEUES = 1_000

function readHeader(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') {
    const val = (headers as Headers).get(name)
    return val === null ? undefined : val
  }
  const target = name.toLowerCase()
  for (const [key, val] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== target) continue
    if (Array.isArray(val)) return val[0]
    return val
  }
  return undefined
}

/** Parse Mattermost `Retry-After` (seconds or HTTP date) or `X-RateLimit-Reset` into a bounded delay in ms. */
export function parseRetryAfterMs(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
  now: number = Date.now(),
  maxMs: number = MATTERMOST_MAX_RETRY_AFTER_MS
): number | undefined {
  const retryAfter = readHeader(headers, 'retry-after')?.trim()
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
      const ms = Math.ceil(Number(retryAfter) * 1000)
      if (Number.isFinite(ms)) return Math.max(0, Math.min(ms, maxMs))
    }
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) {
      return Math.max(0, Math.min(at - now, maxMs))
    }
  }
  const reset = readHeader(headers, 'x-ratelimit-reset')?.trim()
  if (reset && /^\d+(?:\.\d+)?$/.test(reset)) {
    const num = Number(reset)
    if (Number.isFinite(num)) {
      // Mattermost sends seconds until reset; treat values >= 1e9 as Unix epoch seconds.
      const ms = num >= 1_000_000_000 ? num * 1000 - now : Math.ceil(num * 1000)
      return Math.max(0, Math.min(ms, maxMs))
    }
  }
  return undefined
}

export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
  sleepImpl: (ms: number) => Promise<void> = (delay) => new Promise((resolve) => setTimeout(resolve, delay).unref?.())
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
  }
  if (ms <= 0) return Promise.resolve()
  if (!signal) return sleepImpl(ms)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Shared client-wide cooldown when Mattermost answers HTTP 429 so concurrent requests back off together. */
export class MattermostRateLimiter {
  private blockedUntil = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
      abortableSleep(ms, signal),
    private readonly maxBackoffMs: number = MATTERMOST_MAX_RETRY_AFTER_MS
  ) {}

  get cooldownRemainingMs(): number {
    return Math.max(0, this.blockedUntil - this.now())
  }

  /** Extend the shared backoff window to at least `now + delayMs`. */
  backoff(delayMs: number): number {
    const bounded = Math.max(0, Math.min(delayMs, this.maxBackoffMs))
    const until = this.now() + bounded
    if (until > this.blockedUntil) this.blockedUntil = until
    return bounded
  }

  /** Wait until any active 429 cooldown expires, failing immediately if `signal` aborts. */
  async waitIfLimited(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      const before = this.now()
      const wait = this.blockedUntil - before
      if (wait <= 0) return
      await this.sleep(wait, signal)
      // Guard against non-advancing mock clocks in unit tests.
      if (this.now() <= before) return
    }
  }
}

/** Per-channel FIFO outbound queues gated on the shared 429 rate limiter. */
export class MattermostSendQueue {
  private readonly queues = new Map<string, PlatformSendQueue>()

  constructor(
    private readonly limiter: MattermostRateLimiter,
    private readonly minIntervalMs = MATTERMOST_DEFAULT_SEND_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly taskTimeoutMs = MATTERMOST_QUEUE_TIMEOUT_MS
  ) {}

  private queueFor(channel: string): PlatformSendQueue {
    const existing = this.queues.get(channel)
    if (existing) {
      this.queues.delete(channel)
      this.queues.set(channel, existing)
      return existing
    }
    const created = new PlatformSendQueue(this.minIntervalMs, this.now, this.sleep, this.taskTimeoutMs)
    this.queues.set(channel, created)
    while (this.queues.size > MAX_CHANNEL_QUEUES) {
      const oldest = this.queues.keys().next().value
      if (oldest === undefined) break
      this.queues.delete(oldest)
    }
    return created
  }

  enqueue<T>(channel: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queueFor(channel).enqueue(task, () => this.limiter.waitIfLimited(signal))
  }
}
