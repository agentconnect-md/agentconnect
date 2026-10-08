import { metrics, type Attributes, type Meter } from '@opentelemetry/api'
import type { SourceCacheClass, SourceCacheShape } from './keys.js'
import type { SourceCacheReadOutcome } from './read-plan.js'
import type { SourceCacheLifecycleStatus, SourceCacheSweepCounts, SourceCacheSweepPass } from './sweep.js'
import type { SourceCacheWriteOutcome } from './write-back.js'

// Source Cache metrics (source-cache.md §12): labels are closed daemon-authored values, never an org, key, URL or repository.

export interface SourceCacheMetrics {
  /** One clone's cache outcome; a hit also counts the bundle row's bytes. */
  read(outcome: SourceCacheReadOutcome): void
  /** One write-back decision; a written bundle also counts its bytes. */
  writeBack(outcome: SourceCacheWriteOutcome, scope: { shape: SourceCacheShape; repoClass: SourceCacheClass }): void
  /** One completed sweep pass, its non-zero per-step row counts and released bytes. */
  sweepPass(pass: Extract<SourceCacheSweepPass, { kind: 'done' }>): void
  /** One lifecycle check's result; the status gauge reports the latest. */
  lifecycle(status: SourceCacheLifecycleStatus): void
}

type SourceCacheMeter = Pick<Meter, 'createCounter' | 'createObservableGauge'>

const READ_REASONS = new Set([
  'no-org',
  'unsupported-credential',
  'unauthorized',
  'no-pointer',
  'unusable-pointer',
  'unusable-bundle',
  'not-https',
  'error',
  'clone-failed',
  'stderr-unavailable',
  'download-warning',
  'no-bundle-refs',
  'inspect-failed',
  'connectivity',
  'cleanup-failed'
])
const WRITE_TRIGGERS = new Set(['miss', 'fallback', 'stale', 'delta'])
const WRITE_STAGES = new Set([
  'measure',
  'create',
  'reserve',
  'presign',
  'upload',
  'verify',
  'commit',
  'retag',
  'pointer'
])
const SKIP_REASONS = new Set([
  'lifecycle-missing',
  'class-mismatch',
  'unsupported-shim',
  'branch-diverged',
  'unresolved',
  'fallback-clone-failed',
  'fallback-stderr-unavailable',
  'fallback-download-warning',
  'fallback-no-bundle-refs',
  'fallback-inspect-failed',
  'fallback-connectivity',
  'fallback-cleanup-failed',
  'fallback-unknown',
  'no-tip',
  'unmeasured',
  'fresh',
  'in-flight',
  'busy',
  'store-unavailable',
  'pointer-moved',
  'over-cap',
  'reservation-too-large',
  'reservation-over-quota',
  'reservation-duplicate'
])
const READ_OUTCOMES = new Set(['hit', 'miss', 'fallback'])
const SHAPES = new Set(['full', 'blobless'])
const CLASSES = new Set(['anon', 'cred'])
const STATUSES: readonly SourceCacheLifecycleStatus[] = ['present', 'missing', 'unknown']
const SWEEP_STEPS = ['pending', 'unreferenced', 'pointers'] as const
const SWEEP_RESULTS: ReadonlyArray<[keyof SourceCacheSweepCounts, string]> = [
  ['claimed', 'claimed'],
  ['deleted', 'deleted'],
  ['objectDeleted', 'object_deleted'],
  ['alreadyGone', 'already_gone'],
  ['retagged', 'retagged'],
  ['failed', 'failed'],
  ['lost', 'lost'],
  ['changed', 'changed'],
  ['referenced', 'referenced']
]

/** A value outside its allowlist becomes `other`, so no free-form string ever reaches a label. */
const closed = (allowed: ReadonlySet<string>, value: string | undefined, absent = 'other'): string =>
  value === undefined ? absent : allowed.has(value) ? value : 'other'

const shapeOf = (shape: string): string => closed(SHAPES, shape)
const classOf = (repoClass: string | undefined): string => closed(CLASSES, repoClass, 'unknown')
// A finite, positive amount (bytes or rows); anything else records nothing.
const positiveOf = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

export function createSourceCacheMetrics(meter: SourceCacheMeter): SourceCacheMetrics {
  const reads = meter.createCounter('agentconnect.source_cache.reads', {
    unit: '{read}',
    description: 'Source Cache clone reads, by outcome, reason, shape and class'
  })
  const readBytes = meter.createCounter('agentconnect.source_cache.read_bytes', {
    unit: 'By',
    description: 'Bundle bytes clones were seeded from on a hit (the bundle row size)'
  })
  const writeBacks = meter.createCounter('agentconnect.source_cache.write_backs', {
    unit: '{write}',
    description: 'Source Cache write-back decisions, by outcome, reason, shape and class'
  })
  const writeBytes = meter.createCounter('agentconnect.source_cache.write_bytes', {
    unit: 'By',
    description: 'Bundle bytes written back to the Source Cache'
  })
  const sweepPasses = meter.createCounter('agentconnect.source_cache.sweep.passes', {
    unit: '{pass}',
    description: 'Completed Source Cache sweep passes'
  })
  const sweepRows = meter.createCounter('agentconnect.source_cache.sweep.rows', {
    unit: '{row}',
    description: 'Source Cache sweep row results, by step and result'
  })
  const sweepReleased = meter.createCounter('agentconnect.source_cache.sweep.released_bytes', {
    unit: 'By',
    description: 'Bytes released from org usage by the Source Cache sweep, by step'
  })
  const lifecycleChecks = meter.createCounter('agentconnect.source_cache.lifecycle.checks', {
    unit: '{check}',
    description: 'Bucket lifecycle checks, by resulting status'
  })
  const lifecycleGauge = meter.createObservableGauge('agentconnect.source_cache.lifecycle.status', {
    unit: '1',
    description: 'Bucket lifecycle status as a state set: 1 for the current status, 0 for the others'
  })
  let current: SourceCacheLifecycleStatus | undefined
  lifecycleGauge.addCallback((result) => {
    if (current === undefined) return
    for (const status of STATUSES) result.observe(status === current ? 1 : 0, { status })
  })

  return {
    read(outcome) {
      const shape = shapeOf(outcome.shape)
      const repoClass = classOf(outcome.repoClass)
      const reason = outcome.kind === 'hit' ? 'none' : closed(READ_REASONS, outcome.reason)
      reads.add(1, { outcome: closed(READ_OUTCOMES, outcome.kind), reason, shape, class: repoClass })
      if (outcome.kind === 'hit') {
        const bytes = positiveOf(outcome.bytes)
        if (bytes > 0) readBytes.add(bytes, { shape, class: repoClass })
      }
    },
    writeBack(outcome, scope) {
      const shape = shapeOf(scope.shape)
      const repoClass = classOf(scope.repoClass)
      let attributes: Attributes
      if (outcome.kind === 'written') {
        const trigger = closed(WRITE_TRIGGERS, outcome.trigger)
        attributes = { outcome: 'written', reason: trigger, shape, class: repoClass }
        const bytes = positiveOf(outcome.bytes)
        if (bytes > 0) writeBytes.add(bytes, { trigger, shape, class: repoClass })
      } else if (outcome.kind === 'skipped') {
        attributes = { outcome: 'skipped', reason: closed(SKIP_REASONS, outcome.reason), shape, class: repoClass }
      } else if (outcome.kind === 'failed') {
        attributes = { outcome: 'failed', reason: closed(WRITE_STAGES, outcome.stage), shape, class: repoClass }
      } else if (outcome.kind === 'lost-race') {
        attributes = { outcome: 'lost_race', reason: 'none', shape, class: repoClass }
      } else {
        attributes = { outcome: 'other', reason: 'other', shape, class: repoClass }
      }
      writeBacks.add(1, attributes)
    },
    sweepPass(pass) {
      sweepPasses.add(1)
      for (const step of SWEEP_STEPS) {
        const counts = pass[step]
        for (const [field, result] of SWEEP_RESULTS) {
          const n = positiveOf(counts[field])
          if (n > 0) sweepRows.add(n, { step, result })
        }
        const released = positiveOf(counts.releasedBytes)
        if (released > 0) sweepReleased.add(released, { step })
      }
    },
    lifecycle(status) {
      const known: SourceCacheLifecycleStatus = STATUSES.includes(status) ? status : 'unknown'
      current = known
      lifecycleChecks.add(1, { status: known })
    }
  }
}

/** The daemon's recorder on the global meter the NodeSDK exports. */
export const sourceCacheMetrics: SourceCacheMetrics = createSourceCacheMetrics(
  metrics.getMeter('@agentconnect.md/daemon-source-cache', '1.0.0')
)
