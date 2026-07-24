import * as si from 'systeminformation'
import type { Clock } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'

/** Latest sampled host load — utilization fractions in 0..1 (like the wire `load` frame). */
export interface LoadSample {
  /** CPU utilization across all cores, 0..1 (busy fraction since the previous sample). */
  cpu: number
  /** Memory utilization, 0..1 (active/used memory over total). */
  mem: number
}

/** How often the background sampler refreshes {@link SystemMetrics.snapshot}. Decoupled
 *  from the heartbeat interval so CPU% resolution isn't tied to it (issue #125). */
const DEFAULT_INTERVAL_MS = 5_000

/** The raw sampling function seam — replaced in tests so no real system probe runs. */
export type SampleFn = () => Promise<LoadSample>

/** clamp to a 0..1 fraction, mapping non-finite (NaN/Infinity) to 0. */
function frac(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
}

/** Default sampler: cross-platform CPU + memory via `systeminformation`, replacing the
 *  hand-rolled `os.cpus()` jiffy-delta + `freemem/totalmem` sampling (issue #125).
 *  `si.currentLoad()` keeps its own previous-sample state, so each call yields the busy
 *  fraction since the last call; memory uses `active` (real used, excluding cache/buffers)
 *  which is more accurate and consistent across platforms than `1 - freemem/totalmem`. */
async function sampleSystem(): Promise<LoadSample> {
  const [load, mem] = await Promise.all([si.currentLoad(), si.mem()])
  const usedMem = mem.active || mem.used || 0
  return {
    cpu: frac(load.currentLoad / 100),
    mem: mem.total > 0 ? frac(usedMem / mem.total) : 0
  }
}

/**
 * Background host-load sampler. Polls CPU/memory on a timer and caches the latest
 * {@link LoadSample} so callers (the CP heartbeat's `loadSnapshot`) read it
 * synchronously without blocking the send path on an async system probe. Sampling
 * runs on the injected {@link Clock} so a `FakeClock` fully controls it in tests.
 */
export class SystemMetrics {
  private latest: LoadSample = { cpu: 0, mem: 0 }
  private timer?: ReturnType<Clock['setTimeout']>
  private running = false
  private readonly clock: Clock
  private readonly intervalMs: number
  private readonly sample: SampleFn
  private readonly log?: Logger

  constructor(opts: { clock: Clock; intervalMs?: number; sample?: SampleFn; log?: Logger }) {
    this.clock = opts.clock
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.sample = opts.sample ?? sampleSystem
    this.log = opts.log
  }

  /** The most recent load sample (defaults to zeros until the first sample resolves). */
  snapshot(): LoadSample {
    return { ...this.latest }
  }

  /** Begin sampling: take one sample now, then refresh every `intervalMs`. Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
  }

  /** Stop sampling and clear the pending timer. Safe to call when not started. */
  stop(): void {
    this.running = false
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Sample once, cache it, then re-arm — unless stopped mid-flight. */
  private async tick(): Promise<void> {
    try {
      this.latest = await this.sample()
    } catch (err) {
      // A probe failure keeps the previous sample (never throws into the loop);
      // the next tick retries.
      this.log?.debug(`metrics: system load sample failed: ${(err as Error).message ?? err}`)
    }
    if (!this.running) return
    this.timer = this.clock.setTimeout(() => void this.tick(), this.intervalMs)
  }
}
