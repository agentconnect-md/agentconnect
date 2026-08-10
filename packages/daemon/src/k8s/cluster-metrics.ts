import { metrics } from '@opentelemetry/api'

// Cold start and resume are different paths with different costs — the first pays PVC
// provisioning and an image pull, the second pays a PVC re-attach — so a single distribution
// over both cannot settle either target. Every stage carries the path it was measured on.
export type LaunchPath = 'cold' | 'resume' | 'warm'

// The stages a launch passes through, named for the boundary each one ends at.
export type LaunchStage =
  | 'claim_bound' // claim submitted → a Sandbox is named
  | 'mode_running' // resume patch acknowledged
  | 'pod_ready' // Sandbox reports Ready
  | 'shim_handshake' // pod → the shim's channel is bound
  | 'runtime_ready' // channel → the ACP runtime is up
  | 'session_replay' // session/load replay
  | 'first_token' // first token of the first turn

export type LaunchOutcome = 'ok' | 'timeout' | 'draining' | 'error'

// Fixed daemon-authored reasons only. A rejection reason is the one thing a failing handshake
// tells an operator, and a free-form string here would be both unbounded cardinality and a
// route for a peer-supplied value into a metric label.
export type HandshakeRejection = 'unauthenticated' | 'unknown_pod' | 'stale_generation' | 'unavailable' | 'malformed'

export type ChannelEvent = 'bound' | 'dropped' | 'reestablished'

export interface ClusterMetrics {
  /** One stage of a launch, tagged with the path it was measured on. */
  stage(stage: LaunchStage, path: LaunchPath, durationMs: number): void
  /** The whole launch, so the target can be read without summing stages. */
  launch(path: LaunchPath, outcome: LaunchOutcome, durationMs: number): void
  handshakeRejected(reason: HandshakeRejection): void
  /**
   * A TokenReview the API SERVER rejected, which is not the same event as this daemon refusing
   * a bound frame — one is an identity failure, the other our own fencing doing its job. D7
   * shipped a bug from exactly that conflation, so they stay separate counters.
   */
  tokenReviewRejected(): void
  /** A write we retried because the object moved under us. */
  writeRetry(kind: 'conflict' | 'rejected_precondition'): void
  /** A watch that had to re-LIST because its resume point was too old. */
  watchRelist(source: 'status' | 'in_band'): void
  channel(event: ChannelEvent): void
  /** A drain handshake that never completed, so the rollout could not confirm quiescence. */
  drainTimeout(): void
}

const meter = metrics.getMeter('@agentconnect.md/daemon-cluster', '1.0.0')

const stageDuration = meter.createHistogram('agentconnect.cluster.launch.stage_duration', {
  unit: 'ms',
  description: 'Duration of one cluster launch stage, by stage and launch path'
})
const launchDuration = meter.createHistogram('agentconnect.cluster.launch.duration', {
  unit: 'ms',
  description: 'End-to-end cluster launch duration, by launch path and outcome'
})
const handshakeRejections = meter.createCounter('agentconnect.cluster.shim.handshake_rejections', {
  unit: '{rejection}',
  description: 'Shim handshakes the daemon refused, by daemon-authored reason'
})
const tokenReviewRejections = meter.createCounter('agentconnect.cluster.shim.tokenreview_rejections', {
  unit: '{rejection}',
  description: 'ServiceAccount tokens the API server did not accept'
})
const writeRetries = meter.createCounter('agentconnect.cluster.api.write_retries', {
  unit: '{retry}',
  description: 'Kubernetes writes retried after the object moved under us'
})
const watchRelists = meter.createCounter('agentconnect.cluster.api.watch_relists', {
  unit: '{relist}',
  description: 'Watches re-LISTed because their resume point expired'
})
const channelEvents = meter.createCounter('agentconnect.cluster.shim.channel_events', {
  unit: '{event}',
  description: 'Shim channel binds, drops and re-establishments'
})
const drainTimeouts = meter.createCounter('agentconnect.cluster.drain.timeouts', {
  unit: '{timeout}',
  description: 'Drain handshakes that did not complete before their deadline'
})

// Attributes are a closed set of daemon-authored enums: no agent id, pod name, sandbox name or
// org id. Those are unbounded in a multi-tenant deployment, and an agent id in a metric label is
// also a tenant identifier sitting in a place nobody audits.
export const clusterMetrics: ClusterMetrics = {
  stage: (stage, path, durationMs) => stageDuration.record(durationMs, { stage, path }),
  launch: (path, outcome, durationMs) => launchDuration.record(durationMs, { path, outcome }),
  handshakeRejected: (reason) => handshakeRejections.add(1, { reason }),
  tokenReviewRejected: () => tokenReviewRejections.add(1),
  writeRetry: (kind) => writeRetries.add(1, { kind }),
  watchRelist: (source) => watchRelists.add(1, { source }),
  channel: (event) => channelEvents.add(1, { event }),
  drainTimeout: () => drainTimeouts.add(1)
}

/** A no-op recorder, so a host that does not want metrics needs no conditional at each site. */
export const noopClusterMetrics: ClusterMetrics = {
  stage: () => {},
  launch: () => {},
  handshakeRejected: () => {},
  tokenReviewRejected: () => {},
  writeRetry: () => {},
  watchRelist: () => {},
  channel: () => {},
  drainTimeout: () => {}
}

/**
 * Times the stages of one launch.
 *
 * Stages are measured as elapsed-since-the-previous-boundary rather than from the start, because
 * the question an operator asks is which stage is slow, and cumulative timings answer that only
 * by subtraction. The total is recorded separately so it does not depend on stages being complete.
 */
export class LaunchTimer {
  private last: number
  private readonly started: number
  private path?: LaunchPath
  // Stages measured before the path was known. The path is a property of the whole launch, and
  // the earliest stage — claim → bound — is the one that carries PVC provisioning, so emitting
  // it under a provisional tag would file cold-start time under whatever we had assumed.
  private readonly pending: Array<{ stage: LaunchStage; durationMs: number }> = []

  constructor(
    private readonly metrics: ClusterMetrics,
    private readonly now: () => number
  ) {
    this.started = now()
    this.last = this.started
  }

  /** The path is only knowable once the claim and the sandbox's mode have been observed. */
  observedPath(path: LaunchPath): void {
    this.path = path
    for (const entry of this.pending.splice(0)) this.metrics.stage(entry.stage, path, entry.durationMs)
  }

  mark(stage: LaunchStage): void {
    const at = this.now()
    const durationMs = at - this.last
    this.last = at
    if (this.path === undefined) {
      this.pending.push({ stage, durationMs })
      return
    }
    this.metrics.stage(stage, this.path, durationMs)
  }

  // A launch that failed before its path was observed is reported as `warm`: nothing was created
  // and nothing was resumed, so attributing it to either target would be a claim we cannot make.
  finish(outcome: LaunchOutcome): void {
    const path = this.path ?? 'warm'
    for (const entry of this.pending.splice(0)) this.metrics.stage(entry.stage, path, entry.durationMs)
    this.metrics.launch(path, outcome, this.now() - this.started)
  }
}
