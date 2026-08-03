/**
 * Reusable daemon lifecycle + the §7.1 DeliveryHandle surface for the
 * Collaboration Arena (docs/designs/collaboration-arena.md §7.1/§13).
 *
 * The harness owns exactly what a game runner needs from the daemon: start it
 * against a prepared subject root, expose the two ingress surfaces with typed
 * admission/completion barriers, provide the global idleness barrier, and hand
 * back the ordered semantic evidence. Game logic that cares about a specific
 * delivery awaits its handle, not global idleness.
 */
import { Daemon, type DaemonEvaluationOptions } from '../daemon.js'
import { EvaluationEventCollector } from './artifacts.js'
import { compositeEvaluationObserver, type EvaluationCapabilityProfile, type EvaluationEvent } from './events.js'
import type {
  DaemonEvaluationEnvironment,
  DeliveryHandle,
  EvaluationPlatformEvent,
  RefereeEvent
} from './environment.js'

export interface DaemonEvaluationHarnessOptions {
  /** Prepared subject root (config.json + agents/<id>/agent.json). */
  root: string
  environment: DaemonEvaluationEnvironment
  runId: string
  capabilityProfile?: EvaluationCapabilityProfile
  /** Scripted ACP hosts (deterministic mode's reproducible subject, §8.1). */
  hostFactory?: NonNullable<ConstructorParameters<typeof Daemon>[0]>['hostFactory']
  /** Values redacted from every recorded artifact. */
  secrets?: readonly string[]
  onObserverError?: (error: unknown) => void
}

export class DaemonEvaluationHarness {
  private readonly daemon: Daemon
  private readonly collector: EvaluationEventCollector
  private started = false

  constructor(options: DaemonEvaluationHarnessOptions) {
    this.collector = new EvaluationEventCollector(options.secrets)
    const evaluation: DaemonEvaluationOptions = {
      observer: compositeEvaluationObserver(this.collector),
      runId: options.runId,
      environment: options.environment,
      capabilityProfile: options.capabilityProfile ?? { memory: 'off', collaboration: 'configured' },
      ...(options.onObserverError ? { onObserverError: options.onObserverError } : {})
    }
    this.daemon = new Daemon({
      root: options.root,
      evaluation,
      probeRuntimes: async () => [],
      ...(options.hostFactory ? { hostFactory: options.hostFactory } : {})
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.daemon.start()
    this.started = true
  }

  /** §4.1 real-path platform injection — no preselected agent; routing decides. */
  inject(event: EvaluationPlatformEvent): DeliveryHandle {
    return this.daemon.injectPlatformEvent(event)
  }

  /** §4.2 trusted pre-addressed referee delivery. */
  deliverReferee(event: RefereeEvent): DeliveryHandle {
    return this.daemon.deliverRefereeEvent(event)
  }

  /** Concurrent wave: every event passes admission (a synchronous claim inside
   *  the daemon) before any completion is awaited, so later deliveries cannot
   *  observe earlier turns' output (§7.1). */
  injectConcurrent(events: EvaluationPlatformEvent[]): DeliveryHandle[] {
    return events.map((event) => this.inject(event))
  }

  /** Convenience barrier: dispatch queues drained + post-turn chains settled. */
  async waitUntilIdle(timeoutMs = 30_000): Promise<void> {
    await this.daemon.waitForEvaluationIdle(timeoutMs)
  }

  events(): readonly EvaluationEvent[] {
    return this.collector.events()
  }

  eventCollector(): EvaluationEventCollector {
    return this.collector
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.daemon.stop()
  }
}
