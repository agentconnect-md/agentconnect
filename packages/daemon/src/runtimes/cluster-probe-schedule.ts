import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'
import { K8S_PROBE_FRESH_MS } from './cluster-probe.js'

/** Minutes between a cluster member's re-probes of its runtime image; 0 turns the timer off. */
export const RUNTIME_PROBE_INTERVAL_ENV = 'AC_RUNTIME_PROBE_INTERVAL_MINUTES'
/** `true` lets the control plane request a probe; a self-hosted deployment sets it, a managed one does not. */
export const RUNTIME_PROBE_ON_DEMAND_ENV = 'AC_RUNTIME_PROBE_ON_DEMAND'
export const DEFAULT_RUNTIME_PROBE_INTERVAL_MS = 60 * 60_000

/** The re-probe interval this deployment declares, or the hourly default when it declares none or garbage. */
export function configuredRuntimeProbeIntervalMs(env: NodeJS.ProcessEnv, warn?: (message: string) => void): number {
  const raw = env[RUNTIME_PROBE_INTERVAL_ENV]?.trim()
  if (!raw) return DEFAULT_RUNTIME_PROBE_INTERVAL_MS
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes < 0) {
    warn?.(`runtimes: ignoring ${RUNTIME_PROBE_INTERVAL_ENV}=${raw} — expected minutes ≥ 0; re-probing hourly`)
    return DEFAULT_RUNTIME_PROBE_INTERVAL_MS
  }
  return Math.round(minutes * 60_000)
}

/** Whether this deployment lets the control plane request a probe; off unless stated. */
export function configuredRuntimeProbeOnDemand(env: NodeJS.ProcessEnv): boolean {
  const raw = env[RUNTIME_PROBE_ON_DEMAND_ENV]?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

export interface ClusterProbeScheduleDeps {
  clock: Clock
  /** 0 disables the timer; a start-up probe and requests still run. */
  intervalMs: number
  /** One pool probe that adopts only an answer published at or after `freshAfter` (epoch ms). */
  run: (freshAfter: number) => Promise<void>
  /** True while the daemon drains: a tick that lands then is dropped rather than claiming a pod. */
  paused?: () => boolean
  log: Logger
}

/** Runs a cluster member's runtime probes one at a time: at start-up, on a timer, and on request. */
export class ClusterProbeSchedule {
  private running: Promise<void> | undefined
  private pendingFreshAfter: number | undefined
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(private readonly deps: ClusterProbeScheduleDeps) {}

  /** The start-up probe: inherit a pool answer younger than both the freshness window and the interval. */
  start(): void {
    const window = this.deps.intervalMs > 0 ? Math.min(K8S_PROBE_FRESH_MS, this.deps.intervalMs) : K8S_PROBE_FRESH_MS
    this.trigger(this.deps.clock.now() - window)
  }

  /** A requested probe: nothing published before now satisfies it. Joins a probe already queued. */
  request(): void {
    this.trigger(this.deps.clock.now())
  }

  stop(): void {
    this.stopped = true
    this.pendingFreshAfter = undefined
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Settles when the probe in flight (and any queued behind it) has finished — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  private trigger(freshAfter: number): void {
    if (this.stopped) return
    if (this.running) {
      // One probe in flight serves every caller that asked before it; a later ask runs once it ends.
      this.pendingFreshAfter = Math.max(this.pendingFreshAfter ?? freshAfter, freshAfter)
      return
    }
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.running = this.deps
      .run(freshAfter)
      .catch((err: unknown) => this.deps.log.warn(`runtimes: scheduled probe failed: ${(err as Error).message}`))
      .finally(() => {
        this.running = undefined
        const next = this.pendingFreshAfter
        this.pendingFreshAfter = undefined
        if (next !== undefined) this.trigger(next)
        else this.arm()
      })
  }

  private arm(): void {
    if (this.stopped || this.deps.intervalMs <= 0) return
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined
      if (this.deps.paused?.()) return this.arm()
      // A peer's answer from within the last interval is as fresh as this tick asks for.
      this.trigger(this.deps.clock.now() - this.deps.intervalMs)
    }, this.deps.intervalMs)
  }
}
