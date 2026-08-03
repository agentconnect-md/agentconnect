/**
 * Promptfoo adapter for the Collaboration Arena
 * (docs/designs/collaboration-arena.md §12).
 *
 * One provider invocation is ONE complete game. Promptfoo owns treatment
 * enumeration, repeated seeds/trials (§8.1 — real agents report observed
 * reliability, never a reproducible single score), reporting, and CI output;
 * this adapter only drives the real game engine and returns evidence
 * locations. Raw ACP is not a control for games — compare scripted vs real
 * subjects, commits, or capability ablations instead.
 */
import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderResponse } from 'promptfoo'
import { resolve, sep } from 'node:path'
import { runCrossRoomCounting, runSameRoomCounting, runWerewolf } from '../games/engine.js'
import type { GameSubjectSpec } from '../games/subject.js'
import {
  environmentSecrets,
  redactEvaluationValue,
  safeSegment,
  type CollaborationGameResult
} from '../../packages/daemon/src/evaluation/index.js'

export interface GameCase {
  kind: 'game'
  id: string
  game: 'counting' | 'werewolf'
  scenario: 'same-room' | 'cross-room'
  seed: number
  target: number
  /** cross-room only: last number counted in the origin room. */
  boundary?: number
  /** werewolf only: safety cap on day/night rounds. */
  maxRounds?: number
  /** same-room only: room member aliases. The cross-room topology is fixed
   *  per §10.2 (two rooms bridged by one identity); werewolf is the fixed
   *  §10.3 seven-player setup. */
  agentIds: string[]
  timeoutMs?: number
}

/** Validate a §12 game case (hand-rolled: `zod` is not resolvable from the
 *  repo-root evals tree; wire-schema validation stays in the daemon package). */
export function parseGameCase(raw: unknown): GameCase {
  if (typeof raw !== 'object' || raw === null) throw new Error('game case must be a JSON object')
  const record = raw as Record<string, unknown>
  if (record.kind !== 'game') throw new Error('game case requires kind: "game"')
  if (typeof record.id !== 'string' || record.id.length === 0) throw new Error('game case requires a non-empty id')
  if (record.game !== 'counting' && record.game !== 'werewolf') {
    throw new Error(`unsupported game: ${String(record.game)}`)
  }
  const scenario = record.scenario ?? 'same-room'
  if (record.game === 'werewolf' && record.scenario !== undefined && record.scenario !== 'same-room') {
    throw new Error('werewolf plays in the fixed §10.3 same-room setup — omit scenario')
  }
  if (scenario !== 'same-room' && scenario !== 'cross-room') {
    throw new Error(`unsupported counting scenario: ${String(record.scenario)}`)
  }
  if (record.game === 'werewolf' && record.agentIds !== undefined) {
    throw new Error('werewolf uses the fixed §10.3 seven-player topology — omit agentIds')
  }
  const maxRounds = record.maxRounds
  if (
    maxRounds !== undefined &&
    (record.game !== 'werewolf' ||
      typeof maxRounds !== 'number' ||
      !Number.isInteger(maxRounds) ||
      maxRounds < 1 ||
      maxRounds > 20)
  ) {
    throw new Error('maxRounds is a werewolf field: an integer in [1, 20]')
  }
  const seed = record.seed ?? 42
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0)
    throw new Error('seed must be a non-negative integer')
  const target = record.target ?? 12
  if (typeof target !== 'number' || !Number.isInteger(target) || target < 1 || target > 50) {
    throw new Error('target must be an integer in [1, 50]')
  }
  const boundary = record.boundary
  if (scenario === 'same-room' && boundary !== undefined) {
    throw new Error('boundary is a cross-room field')
  }
  if (
    boundary !== undefined &&
    (typeof boundary !== 'number' || !Number.isInteger(boundary) || boundary < 1 || boundary >= target)
  ) {
    throw new Error('boundary must be an integer inside the target range')
  }
  const agentIds = record.agentIds ?? ['agent-a', 'agent-b', 'agent-c', 'agent-d']
  if (scenario === 'cross-room' && record.agentIds !== undefined) {
    throw new Error('cross-room counting uses the fixed §10.2 topology — omit agentIds')
  }
  if (
    !Array.isArray(agentIds) ||
    agentIds.length < 2 ||
    agentIds.length > 8 ||
    agentIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    throw new Error('agentIds must be 2–8 non-empty aliases')
  }
  const timeoutMs = record.timeoutMs
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000)
  ) {
    throw new Error('timeoutMs must be an integer in [1, 1800000]')
  }
  return {
    kind: 'game',
    id: record.id,
    game: record.game,
    scenario,
    seed,
    target,
    ...(boundary !== undefined ? { boundary } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    agentIds: agentIds as string[],
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  }
}

interface CollaborationGameProviderConfig {
  /** Who plays: scripted hosts (default, credential-free) or the operator's
   *  real-runtime subject template. */
  subject?: 'scripted' | 'real'
  name?: string
  /** Real subjects: template root (or AGENTCONNECT_EVAL_SUBJECT_ROOT). */
  subjectRoot?: string
  /** Real subjects: template agent ids mapped onto game seats in order
   *  (or AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS, comma-separated). */
  templateAgentIds?: string[]
  artifactRoot?: string
}

interface CollaborationGameProviderOptions {
  id?: string
  label?: string
  config?: CollaborationGameProviderConfig
}

export interface CollaborationGameProviderDependencies {
  /** Test seams; production runs the real engine. */
  runGame?: (options: Parameters<typeof runSameRoomCounting>[0]) => Promise<CollaborationGameResult>
  runCrossRoomGame?: (options: Parameters<typeof runCrossRoomCounting>[0]) => Promise<CollaborationGameResult>
  runWerewolfGame?: (options: Parameters<typeof runWerewolf>[0]) => Promise<CollaborationGameResult>
}

function parseCase(prompt: string): GameCase {
  const trimmed = prompt.trim()
  if (!trimmed.startsWith('{')) throw new Error('collaboration game cases must be JSON (see §12)')
  return parseGameCase(JSON.parse(trimmed))
}

export default class CollaborationGameProvider implements ApiProvider {
  public readonly config: CollaborationGameProviderConfig
  public label?: string
  private readonly providerId: string
  private readonly dependencies: CollaborationGameProviderDependencies

  constructor(
    options: CollaborationGameProviderOptions = {},
    dependencies: CollaborationGameProviderDependencies = {}
  ) {
    this.config = options.config ?? {}
    this.label = options.label
    this.providerId = options.id ?? `agentconnect:collab:${this.config.name ?? this.config.subject ?? 'scripted'}`
    this.dependencies = dependencies
    if (this.config.subject && this.config.subject !== 'scripted' && this.config.subject !== 'real') {
      throw new Error(`unsupported collaboration game subject: ${String(this.config.subject)}`)
    }
  }

  id(): string {
    return this.providerId
  }

  private subjectSpec(): GameSubjectSpec {
    if ((this.config.subject ?? 'scripted') === 'scripted') return { kind: 'scripted' }
    const subjectRoot = this.config.subjectRoot?.trim() || process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
    if (!subjectRoot) {
      throw new Error(
        'real-agent game trials need a subject template: set AGENTCONNECT_EVAL_SUBJECT_ROOT (or provider config.subjectRoot)'
      )
    }
    const templateAgentIds =
      this.config.templateAgentIds ??
      process.env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS?.split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    if (!templateAgentIds || templateAgentIds.length === 0) {
      throw new Error(
        'real-agent game trials need template agents: set AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS (or provider config.templateAgentIds)'
      )
    }
    return { kind: 'real', subjectRoot, templateAgentIds }
  }

  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    options?: CallApiOptionsParams
  ): Promise<ProviderResponse> {
    let gameCase: GameCase
    try {
      gameCase = parseCase(prompt)
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        metadata: { schemaVersion: 'agentconnect.promptfoo/v1', status: 'invalid_case' }
      }
    }
    try {
      if (options?.abortSignal?.aborted) throw new Error('collaboration game was aborted before launch')
      const subject = this.subjectSpec()
      const artifactBase = resolve(
        this.config.artifactRoot?.trim() ||
          process.env.AGENTCONNECT_EVAL_ARTIFACT_ROOT?.trim() ||
          '.artifacts/evaluation'
      )
      // Per-trial directory: promptfoo repeats land side by side. The case id
      // is untrusted input — collapse it to one safe path segment and verify
      // the resolved directory stays below the configured root.
      const artifactDir = resolve(
        artifactBase,
        'games',
        safeSegment(gameCase.id),
        subject.kind,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      )
      if (artifactDir !== artifactBase && !artifactDir.startsWith(`${artifactBase}${sep}`)) {
        throw new Error('collaboration game artifact directory escaped the configured artifact root')
      }
      const result =
        gameCase.game === 'werewolf'
          ? await (this.dependencies.runWerewolfGame ?? runWerewolf)({
              seed: gameCase.seed,
              ...(gameCase.maxRounds !== undefined ? { maxRounds: gameCase.maxRounds } : {}),
              artifactDir,
              subject,
              ...(gameCase.timeoutMs !== undefined ? { timeoutMs: gameCase.timeoutMs } : {})
            })
          : gameCase.scenario === 'cross-room'
            ? await (this.dependencies.runCrossRoomGame ?? runCrossRoomCounting)({
                seed: gameCase.seed,
                target: gameCase.target,
                ...(gameCase.boundary !== undefined ? { boundary: gameCase.boundary } : {}),
                artifactDir,
                subject,
                ...(gameCase.timeoutMs !== undefined ? { timeoutMs: gameCase.timeoutMs } : {})
              })
            : await (this.dependencies.runGame ?? runSameRoomCounting)({
                seed: gameCase.seed,
                target: gameCase.target,
                agents: gameCase.agentIds,
                artifactDir,
                subject,
                ...(gameCase.timeoutMs !== undefined ? { timeoutMs: gameCase.timeoutMs } : {})
              })
      const metadata = {
        schemaVersion: 'agentconnect.promptfoo/v1',
        caseId: gameCase.id,
        game: gameCase.game,
        scenario: gameCase.scenario,
        subjectKind: subject.kind,
        runId: result.runId,
        status: result.status,
        gameResult: result.gameResult,
        artifacts: {
          directory: result.artifactDir,
          manifest: result.paths.manifest,
          events: result.paths.events,
          trajectory: result.paths.trajectory,
          worldEvents: result.paths.worldEvents,
          gameResult: result.paths.gameResult,
          topology: result.paths.topology
        }
      }
      const output = JSON.stringify(result.gameResult)
      // Trial-validity and safety layers (§9.1/§9.2) are provider errors; a
      // valid trial with a low game score is a legitimate result Promptfoo may
      // aggregate (pass^k over repeats), matching the expected-low philosophy.
      if (!result.valid || result.status === 'safety_failed') {
        return {
          output,
          error: `${result.status}: ${result.error?.message ?? 'collaboration game did not produce a valid, safe trial'}`,
          metadata
        }
      }
      return { output, metadata }
    } catch (error) {
      return {
        error: String(
          redactEvaluationValue(error instanceof Error ? error.message : String(error), environmentSecrets())
        ),
        metadata: { schemaVersion: 'agentconnect.promptfoo/v1', caseId: gameCase.id, status: 'infra_error' }
      }
    }
  }
}
