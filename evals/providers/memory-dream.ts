/**
 * Promptfoo adapter for the memory-dream evaluation (memory-dreaming.md §5).
 *
 * One provider invocation is one complete run: save, correct, dream, recall.
 * The output is the agent's reply to the recall thread, scored by the shared
 * `outcome` assertion against the corrected value. It needs a real-runtime
 * subject template: a scripted host has no memory tools, so the engine gate for
 * this game is the Vitest contract in `evals/test/memory-dream.test.ts`.
 */
import { resolve } from 'node:path'
import type { ApiProvider, CallApiContextParams, ProviderResponse } from 'promptfoo'
import { environmentSecrets, redactEvaluationValue, safeSegment } from '../../packages/daemon/src/evaluation/index.js'
import { runMemoryDream, type MemoryDreamResult } from '../games/memory-dream.js'

export interface MemoryDreamCase {
  kind: 'memory-dream'
  id: string
  seed: number
  timeoutMs?: number
}

export function parseMemoryDreamCase(raw: unknown): MemoryDreamCase {
  if (typeof raw !== 'object' || raw === null) throw new Error('memory-dream case must be a JSON object')
  const record = raw as Record<string, unknown>
  if (record.kind !== 'memory-dream') throw new Error('memory-dream case requires kind: "memory-dream"')
  if (typeof record.id !== 'string' || record.id.length === 0) throw new Error('memory-dream case requires an id')
  const seed = record.seed ?? 42
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('seed must be a non-negative safe integer')
  }
  const timeoutMs = record.timeoutMs
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000)
  ) {
    throw new Error('timeoutMs must be an integer in [1, 1800000]')
  }
  return { kind: 'memory-dream', id: record.id, seed, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
}

interface MemoryDreamProviderConfig {
  name?: string
  subjectRoot?: string
  templateAgentId?: string
  artifactRoot?: string
}

export interface MemoryDreamProviderDependencies {
  run?: (options: Parameters<typeof runMemoryDream>[0]) => Promise<MemoryDreamResult>
}

export default class MemoryDreamProvider implements ApiProvider {
  public readonly config: MemoryDreamProviderConfig
  public label?: string
  private readonly providerId: string

  constructor(
    options: { id?: string; label?: string; config?: MemoryDreamProviderConfig } = {},
    private readonly dependencies: MemoryDreamProviderDependencies = {}
  ) {
    this.config = options.config ?? {}
    this.label = options.label
    this.providerId = options.id ?? `agentconnect-memory-dream:${this.config.name ?? 'real'}`
  }

  id(): string {
    return this.providerId
  }

  async callApi(prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const secrets = environmentSecrets()
    const redact = (message: string) => String(redactEvaluationValue(message, secrets))
    let evaluationCase: MemoryDreamCase
    try {
      evaluationCase = parseMemoryDreamCase(JSON.parse(prompt.trim()))
    } catch (error) {
      return {
        error: redact(error instanceof Error ? error.message : String(error)),
        metadata: { schemaVersion: 'agentconnect.memory-dream/v1', status: 'invalid_case' }
      }
    }
    try {
      const subjectRoot = this.config.subjectRoot?.trim() || process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
      const templateAgentId = this.config.templateAgentId?.trim() || process.env.AGENTCONNECT_EVAL_ROOT_AGENT?.trim()
      if (!subjectRoot || !templateAgentId) {
        throw new Error('AGENTCONNECT_EVAL_SUBJECT_ROOT and AGENTCONNECT_EVAL_ROOT_AGENT are required')
      }
      const artifactRoot = resolve(
        this.config.artifactRoot?.trim() ||
          process.env.AGENTCONNECT_EVAL_ARTIFACT_ROOT?.trim() ||
          '.artifacts/evaluation'
      )
      const trial = context?.test?.metadata?.trial
      const artifactDir = resolve(
        artifactRoot,
        'dreams',
        safeSegment(evaluationCase.id),
        safeSegment(`${evaluationCase.seed}-${typeof trial === 'string' ? trial : Date.now()}`)
      )
      const result = await (this.dependencies.run ?? runMemoryDream)({
        seed: evaluationCase.seed,
        artifactDir,
        subject: { kind: 'real', subjectRoot, templateAgentIds: [templateAgentId] },
        ...(evaluationCase.timeoutMs !== undefined ? { timeoutMs: evaluationCase.timeoutMs } : {})
      })
      const metadata = {
        schemaVersion: 'agentconnect.memory-dream/v1',
        caseId: evaluationCase.id,
        seed: evaluationCase.seed,
        status: result.status,
        steps: result.steps.map((step) => ({ name: step.name, status: step.status })),
        ...(result.dream
          ? { dream: { status: result.dream.status, minedSessions: result.dream.sessionIds.length } }
          : {}),
        artifacts: result.paths
      }
      if (result.status !== 'passed') {
        return {
          output: result.output,
          error: `${result.status}: ${redact(result.error ?? 'run did not pass')}`,
          metadata
        }
      }
      return { output: result.output, metadata }
    } catch (error) {
      return {
        error: redact(error instanceof Error ? error.message : String(error)),
        metadata: { schemaVersion: 'agentconnect.memory-dream/v1', caseId: evaluationCase.id, status: 'infra_error' }
      }
    }
  }
}
