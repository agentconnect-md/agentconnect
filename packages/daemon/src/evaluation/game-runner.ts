/**
 * The Collaboration Arena's stateful game runner
 * (docs/designs/collaboration-arena.md §8/§9/§11).
 *
 * A game is an event loop, not a list of turns: each iteration asks the world
 * for the next delivery WAVE, injects the whole wave before awaiting any
 * completion (so later deliveries cannot see earlier turns' output), then hands
 * the drained outbound effects back to the world in `sequence` order. The world
 * decides what events occur and whether the game succeeds; the daemon decides
 * how agents, sessions, messages, permissions, and collaboration behave.
 *
 * Determinism claims are honest per §8.1: fixed seeds and delivery order make
 * the ENVIRONMENT and referee deterministic; exact reproducibility is
 * guaranteed only for scripted ACP hosts. Every wave's composition and each
 * admission outcome is recorded in `world-events.jsonl`, so a trial is always
 * explainable even when it is not reproducible.
 */
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Daemon } from '../daemon.js'
import { DAEMON_VERSION } from '../version.js'
import {
  EVALUATION_RUN_SCHEMA_VERSION,
  atomicWrite,
  redactEvaluationValue,
  writeEvaluationRunManifest,
  type EvaluationRunManifest,
  type EvaluationRunStatus
} from './artifacts.js'
import { evaluationEventsToAtif, writeAtifTrajectory } from './atif.js'
import { DaemonEvaluationHarness } from './daemon-harness.js'
import type { EvaluationCapabilityProfile } from './events.js'
import type {
  DaemonEvaluationEnvironment,
  DeliveryAdmission,
  DeliveryHandle,
  EvaluationPlatformEvent,
  RefereeEvent
} from './environment.js'
import type { OutboundEffectInput, OutboundRejection } from './virtual-connections.js'

/** One recorded outbound attempt — delivered or rejected — as the world stores
 *  it (§7.2): monotonic `sequence`, resolved integration, trusted sender. */
export interface RecordedOutboundEffect extends OutboundEffectInput {
  sequence: number
  /** Trusted owner of the integration (resolved by the world, never claimed). */
  agentId?: string
  status: 'delivered' | 'rejected'
  reason?: OutboundRejection
  messageId?: string
}

export interface GameWave {
  platformEvents: EvaluationPlatformEvent[]
  refereeEvents: RefereeEvent[]
}

export interface GameWaveRecord {
  step: number
  platformEvents: readonly EvaluationPlatformEvent[]
  refereeEvents: readonly RefereeEvent[]
  admissions: readonly DeliveryAdmission[]
}

/** The three §9 result layers, computed by the world after the loop ends. */
export interface GameVerdict {
  terminalReason: string
  /** §9.2 product invariants — hard gates, counted over ATTEMPTED effects. */
  invariants: Record<string, number>
  /** §9.3 game outcome. */
  outcome: Record<string, unknown>
  /** §9.3 efficiency metrics. */
  metrics: Record<string, number>
  /** §9.1: the referee's own internal-consistency check. */
  refereeConsistent: boolean
}

/** The world surface the runner drives — rules, hidden state, scoring, and the
 *  outbound authorization sink live behind it (game logic never enters Daemon). */
export interface CollaborationGameWorld {
  readonly environment: DaemonEvaluationEnvironment
  isTerminal(): boolean
  /** The next delivery wave. An empty wave with a non-terminal world stalls the
   *  game and is terminated as `stalled`. */
  nextDeliveries(): GameWave
  /** Effects recorded since the last drain, in `sequence` order. */
  drainOutboundEffects(): readonly RecordedOutboundEffect[]
  applyEffects(effects: readonly RecordedOutboundEffect[]): void
  /** Optional live-ingress port (§8): the runner supplies an inject function so
   *  the world can deliver peer fan-out the MOMENT an effect lands, while other
   *  turns are still open — production timing, which the daemon's turn-final
   *  context refresh depends on. */
  attachLiveIngress?(inject: (event: EvaluationPlatformEvent) => Promise<DeliveryHandle>): void
  /** Handles for live-injected deliveries since the last drain. */
  drainLiveHandles?(): DeliveryHandle[]
  /** §8.1 decision log: the wave's composition and each admission outcome. */
  noteWave(record: GameWaveRecord): void
  terminate(reason: string): void
  verdict(): GameVerdict
  /** Ordered world-events (referee events + outbound effects) for world-events.jsonl. */
  worldEventRecords(): readonly Record<string, unknown>[]
  /** Compiled topology + alias map (§5.1) for topology.json. */
  topologyArtifact(): unknown
}

export interface CollaborationGameRunnerOptions {
  /** Prepared subject root (config.json + agents/<id>/agent.json). */
  root: string
  world: CollaborationGameWorld
  artifactDir: string
  game: string
  seed: number
  mode: 'deterministic' | 'stress'
  subjectKind: 'scripted' | 'real'
  runId?: string
  hostFactory?: NonNullable<ConstructorParameters<typeof Daemon>[0]>['hostFactory']
  capabilityProfile?: EvaluationCapabilityProfile
  limits?: { maxSteps?: number; timeoutMs?: number }
  /** Root agent + display metadata for the ATIF trajectory. */
  agents: { agentId: string; name: string }[]
  secrets?: readonly string[]
}

export interface CollaborationGameResult {
  runId: string
  status: EvaluationRunStatus
  valid: boolean
  gameResult: Record<string, unknown>
  verdict: GameVerdict
  steps: number
  artifactDir: string
  paths: {
    manifest: string
    events: string
    trajectory: string
    worldEvents: string
    gameResult: string
    topology: string
  }
  error?: { code: string; message: string }
}

export const GAME_RESULT_SCHEMA_VERSION = 'agentconnect.game-result/v1' as const

class GameTimeoutError extends Error {
  readonly code = 'GAME_TIMEOUT'

  constructor(label: string) {
    super(`${label} exceeded the game deadline`)
    this.name = 'GameTimeoutError'
  }
}

async function beforeDeadline<T>(deadlineMs: number, label: string, start: () => Promise<T>): Promise<T> {
  const remaining = deadlineMs - Date.now()
  if (remaining <= 0) throw new GameTimeoutError(label)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GameTimeoutError(label)), remaining)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class CollaborationGameRunner {
  constructor(private readonly options: CollaborationGameRunnerOptions) {}

  async run(): Promise<CollaborationGameResult> {
    const options = this.options
    const runId = options.runId ?? randomUUID()
    const startedAtMs = Date.now()
    const deadlineMs = startedAtMs + (options.limits?.timeoutMs ?? 120_000)
    const maxSteps = options.limits?.maxSteps ?? 64
    const world = options.world
    mkdirSync(options.artifactDir, { recursive: true, mode: 0o700 })
    const paths = {
      manifest: join(options.artifactDir, 'run.json'),
      events: join(options.artifactDir, 'events.jsonl'),
      trajectory: join(options.artifactDir, 'trajectory.json'),
      worldEvents: join(options.artifactDir, 'world-events.jsonl'),
      gameResult: join(options.artifactDir, 'game-result.json'),
      topology: join(options.artifactDir, 'topology.json')
    }

    const observationErrors: unknown[] = []
    const harness = new DaemonEvaluationHarness({
      root: options.root,
      environment: world.environment,
      runId,
      ...(options.hostFactory ? { hostFactory: options.hostFactory } : {}),
      ...(options.capabilityProfile ? { capabilityProfile: options.capabilityProfile } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      onObserverError: (error) => observationErrors.push(error)
    })

    let status: EvaluationRunStatus = 'passed'
    let failure: { code: string; message: string } | undefined
    let steps = 0
    try {
      await beforeDeadline(deadlineMs, 'daemon startup', () => harness.start())
      // Live ingress: peer fan-out enters the daemon as soon as an effect is
      // delivered, not at the wave barrier (see CollaborationGameWorld).
      world.attachLiveIngress?.((event) => harness.inject(event))
      // ── the §8 wave loop ──
      while (!world.isTerminal()) {
        if (steps >= maxSteps) {
          world.terminate('step_limit')
          break
        }
        const wave = world.nextDeliveries()
        if (wave.platformEvents.length === 0 && wave.refereeEvents.length === 0) {
          world.terminate('stalled')
          break
        }
        // All events pass admission before any completion is awaited.
        const handles = await harness.injectConcurrent(wave.platformEvents)
        const refereeHandles = await Promise.all(wave.refereeEvents.map((event) => harness.deliverReferee(event)))
        const all = [...handles, ...refereeHandles]
        const admissions = await beforeDeadline(deadlineMs, `wave ${steps} admission`, () =>
          Promise.all(all.map((handle) => handle.admission))
        )
        world.noteWave({
          step: steps,
          platformEvents: wave.platformEvents,
          refereeEvents: wave.refereeEvents,
          admissions
        })
        await beforeDeadline(deadlineMs, `wave ${steps} completion`, () =>
          Promise.all(all.map((handle) => handle.completion))
        )
        const effects = world.drainOutboundEffects()
        world.applyEffects(effects)
        // Drain the live-injected cascade: a delivered post can wake peers whose
        // own posts wake further peers. Each generation is settled and applied
        // before the loop asks the world for the next wave.
        let cascade = world.drainLiveHandles?.() ?? []
        let generations = 0
        while (cascade.length > 0 && generations < maxSteps) {
          generations += 1
          await beforeDeadline(deadlineMs, `wave ${steps} cascade ${generations}`, () =>
            Promise.all(cascade.map((handle) => handle.completion))
          )
          world.applyEffects(world.drainOutboundEffects())
          cascade = world.drainLiveHandles?.() ?? []
        }
        steps += 1
      }
      await beforeDeadline(deadlineMs, 'daemon idle wait', () =>
        harness.waitUntilIdle(Math.max(1, deadlineMs - Date.now()))
      )
      harness.eventCollector().assertValid()
    } catch (error) {
      const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
      failure = {
        code:
          typeof candidate?.code === 'string'
            ? candidate.code
            : typeof candidate?.name === 'string'
              ? candidate.name
              : 'GAME_ERROR',
        message: typeof candidate?.message === 'string' ? candidate.message : 'collaboration game failed'
      }
      status = 'infra_error'
      if (!world.isTerminal()) world.terminate('infra_error')
    } finally {
      try {
        await harness.stop()
      } catch (error) {
        failure ??= { code: 'SHUTDOWN_FAILED', message: (error as Error).message }
        status = 'infra_error'
      }
    }
    if (observationErrors.length > 0 && status === 'passed') {
      status = 'infra_error'
      failure ??= { code: 'EVALUATION_OBSERVER_ERROR', message: 'evaluation observer rejected semantic evidence' }
    }

    // Redact BEFORE anything is returned or written: the verdict and failure
    // strings can carry text a real subject's runtime echoed.
    const redactionSecrets = options.secrets ?? []
    if (failure) {
      failure = redactEvaluationValue(failure, redactionSecrets) as { code: string; message: string }
    }
    const verdict = redactEvaluationValue(world.verdict(), redactionSecrets) as GameVerdict
    if (status === 'passed' && !verdict.refereeConsistent) {
      status = 'infra_error'
      failure ??= { code: 'REFEREE_INCONSISTENT', message: 'game referee lost internal consistency' }
    }
    // §9.1 trial validity over REAL subjects: a runtime that never authenticated
    // or timed out is an infra_error, never an agent failure. Provider-level
    // failures always invalidate; generic turn failures invalidate only when the
    // game did not complete (a completed game that absorbed one failed turn is
    // a legitimate trial — the failures stay visible in events.jsonl).
    if (status === 'passed') {
      const observedEvents = harness.events()
      const turnFailures = observedEvents.filter(
        (event) => event.type === 'turn.failed' || event.type === 'turn.timed_out'
      )
      const providerFailure = turnFailures.some(
        (event) =>
          event.type === 'turn.timed_out' ||
          event.data.code === 'provider_auth_required' ||
          event.data.code === 'provider_quota_exhausted'
      )
      if (providerFailure || (turnFailures.length > 0 && verdict.terminalReason !== 'completed')) {
        status = 'infra_error'
        failure ??= {
          code: providerFailure ? 'PROVIDER_FAILURE' : 'TURN_FAILURES',
          message: `${turnFailures.length} agent turn(s) failed or timed out before the game could complete`
        }
      }
    }
    // §9.2 hard gates: any attempted invariant violation fails the trial even
    // when the game outcome scored well. Never averaged away.
    if (status === 'passed' && Object.values(verdict.invariants).some((count) => count > 0)) {
      status = 'safety_failed'
    }
    const valid =
      (status as EvaluationRunStatus) !== 'infra_error' && (status as EvaluationRunStatus) !== 'invalid_case'

    const events = harness.events()
    const finishedAtMs = Date.now()
    const gameResult: Record<string, unknown> = {
      schemaVersion: GAME_RESULT_SCHEMA_VERSION,
      game: options.game,
      seed: options.seed,
      mode: options.mode,
      subjectKind: options.subjectKind,
      valid,
      terminalReason: verdict.terminalReason,
      outcome: verdict.outcome,
      invariants: verdict.invariants,
      metrics: {
        ...verdict.metrics,
        steps,
        turns: events.filter((event) => event.type === 'turn.completed').length,
        latencyMs: Math.max(0, finishedAtMs - startedAtMs)
      },
      ...(failure ? { error: failure } : {})
    }

    // ── artifacts: the existing three plus the three game layers (§11) ──
    harness.eventCollector().writeJsonl(paths.events)
    const rootAgent = options.agents[0]
    writeAtifTrajectory(
      paths.trajectory,
      evaluationEventsToAtif(events, {
        runId,
        rootAgentId: rootAgent?.agentId ?? 'unknown',
        defaultAgentVersion: 'unknown',
        agents: Object.fromEntries(
          options.agents.map((agent) => [
            agent.agentId,
            {
              name: agent.name,
              version: 'unknown',
              extra: { runtime: 'scripted', agentconnect_version: DAEMON_VERSION }
            }
          ])
        )
      }),
      options.secrets ?? []
    )
    // Game artifacts pass through the same redaction as the product trace: a
    // real subject's runtime can echo template credentials into room speech.
    const secrets = redactionSecrets
    const worldLines = world
      .worldEventRecords()
      .map((record) => JSON.stringify(redactEvaluationValue(record, secrets)))
      .join('\n')
    atomicWrite(paths.worldEvents, worldLines.length > 0 ? `${worldLines}\n` : '')
    atomicWrite(paths.gameResult, `${JSON.stringify(redactEvaluationValue(gameResult, secrets), null, 2)}\n`)
    atomicWrite(
      paths.topology,
      `${JSON.stringify(redactEvaluationValue(world.topologyArtifact(), secrets), null, 2)}\n`
    )
    const manifest: EvaluationRunManifest = {
      schemaVersion: EVALUATION_RUN_SCHEMA_VERSION,
      runId,
      caseId: options.game,
      treatment: {
        name: options.subjectKind === 'scripted' ? 'scripted-hosts' : 'real-agents',
        memory: options.capabilityProfile?.memory ?? 'off'
      },
      subject: { runtime: options.subjectKind },
      agentConnect: { commit: process.env.GITHUB_SHA ?? 'unknown', dirty: true },
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      status,
      metrics: {
        latencyMs: Math.max(0, finishedAtMs - startedAtMs),
        turns: events.filter((event) => event.type === 'turn.completed').length,
        toolCalls: events.filter(
          (event) =>
            event.type === 'acp.update' &&
            (event.data.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate === 'tool_call'
        ).length
      },
      ...(failure ? { error: failure } : {}),
      artifacts: { events: basename(paths.events), trajectory: basename(paths.trajectory) },
      metadata: {
        game: options.game,
        seed: options.seed,
        mode: options.mode,
        worldEvents: basename(paths.worldEvents),
        gameResult: basename(paths.gameResult),
        topology: basename(paths.topology)
      }
    }
    writeEvaluationRunManifest(paths.manifest, manifest, options.secrets ?? [])

    return {
      runId,
      status,
      valid,
      gameResult,
      verdict,
      steps,
      artifactDir: options.artifactDir,
      paths,
      ...(failure ? { error: failure } : {})
    }
  }
}
