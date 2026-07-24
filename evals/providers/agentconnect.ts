import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderResponse } from 'promptfoo'
import {
  EvaluationCaseSchema,
  EvaluationRunner,
  RawAcpEvaluationRunner,
  redactEvaluationValue,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationTreatment
} from '../../packages/daemon/src/evaluation/index.js'

type ProviderMode = 'daemon' | 'raw-acp'

interface AgentConnectProviderConfig {
  mode?: ProviderMode
  name?: string
  subjectRoot?: string
  /** Base evaluation artifact directory; per-trial evidence is written below runs/. */
  artifactRoot?: string
  agentId?: string
  treatment?: EvaluationTreatment
  otel?: boolean
  commit?: string
  dirty?: boolean
}

interface AgentConnectProviderOptions {
  id?: string
  label?: string
  config?: AgentConnectProviderConfig
}

interface EvaluationRunnerLike {
  run(evaluationCase: EvaluationCase): Promise<EvaluationCaseResult>
}

export interface AgentConnectProviderDependencies {
  daemonRunner?: (options: ConstructorParameters<typeof EvaluationRunner>[0]) => EvaluationRunnerLike
  rawRunner?: (options: ConstructorParameters<typeof RawAcpEvaluationRunner>[0]) => EvaluationRunnerLike
  repositoryState?: () => { commit?: string; dirty?: boolean }
}

const SECRET_KEY =
  /(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|cookie|connection[_-]?string|database[_-]?(?:url|uri)|dsn)/i

function environmentSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value!)
}

function booleanEnvironment(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return undefined
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  throw new Error(`${name} must be true or false`)
}

let cachedRepositoryState: { commit?: string; dirty?: boolean } | undefined

function repositoryState(): { commit?: string; dirty?: boolean } {
  if (cachedRepositoryState) return cachedRepositoryState
  const repositoryRoot = resolve(__dirname, '../..')
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {
      return undefined
    }
  }
  const commit = git(['rev-parse', '--verify', 'HEAD'])
  const status = git(['status', '--porcelain=v1', '--untracked-files=normal'])
  cachedRepositoryState = {
    ...(commit ? { commit } : {}),
    ...(status !== undefined ? { dirty: status.length > 0 } : {})
  }
  return cachedRepositoryState
}

function providerError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error)
  return String(redactEvaluationValue(message || 'AgentConnect evaluation failed', secrets))
}

function structuredCase(prompt: string, context: CallApiContextParams | undefined, agentId?: string): EvaluationCase {
  const trimmed = prompt.trim()
  if (trimmed.startsWith('{')) return EvaluationCaseSchema.parse(JSON.parse(trimmed))
  if (!agentId) {
    throw new Error('plain-text evaluation prompts require provider config.agentId')
  }
  const metadataCaseId = context?.test?.metadata?.caseId
  return EvaluationCaseSchema.parse({
    id:
      typeof metadataCaseId === 'string' && metadataCaseId.trim()
        ? metadataCaseId.trim()
        : context?.testCaseId || 'promptfoo-case',
    turns: [{ agentId, text: prompt }]
  })
}

function tokenUsage(result: EvaluationCaseResult): ProviderResponse['tokenUsage'] | undefined {
  const prompt = result.metrics.promptTokens
  const completion = result.metrics.completionTokens
  const cached = result.metrics.cachedTokens
  // cached is an ATIF-style subset of prompt, not an additional token bucket.
  const knownBuckets = [prompt, completion].filter((value): value is number => value !== undefined)
  const aggregate = knownBuckets.length > 0 ? knownBuckets.reduce((sum, value) => sum + value, 0) : undefined
  // Older embedded runners may only surface ACP totalTokens on scripted turns.
  const fallbackTotal = result.turns.reduce((sum, turn) => sum + (turn.usage?.used ?? 0), 0)
  const total = result.metrics.totalTokens ?? aggregate ?? (fallbackTotal > 0 ? fallbackTotal : undefined)
  const numRequests = result.metrics.turns
  if (total === undefined && numRequests === undefined) return undefined
  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(completion !== undefined ? { completion } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(numRequests !== undefined ? { numRequests } : {})
  }
}

function configuredTreatment(config: AgentConnectProviderConfig, mode: ProviderMode): EvaluationTreatment {
  if (mode === 'raw-acp') {
    return {
      name: config.name?.trim() || 'raw-acp',
      memory: 'off',
      collaboration: 'off'
    }
  }
  return (
    config.treatment ?? {
      name: config.name?.trim() || 'daemon-core',
      memory: 'off',
      collaboration: 'off'
    }
  )
}

/** Promptfoo adapter for one isolated AgentConnect treatment. Promptfoo owns
 * enumeration, repeats, assertions, and reports; this adapter only drives the
 * real product paths and returns evidence locations. */
export default class AgentConnectProvider implements ApiProvider {
  public readonly config: AgentConnectProviderConfig
  public label?: string
  private readonly providerId: string
  private readonly dependencies: AgentConnectProviderDependencies

  constructor(options: AgentConnectProviderOptions = {}, dependencies: AgentConnectProviderDependencies = {}) {
    this.config = options.config ?? {}
    this.label = options.label
    this.providerId = options.id ?? `agentconnect:${this.config.name ?? this.config.mode ?? 'daemon'}`
    this.dependencies = dependencies
    if (this.config.mode && this.config.mode !== 'daemon' && this.config.mode !== 'raw-acp') {
      throw new Error(`unsupported AgentConnect evaluation mode: ${String(this.config.mode)}`)
    }
  }

  id(): string {
    return this.providerId
  }

  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    options?: CallApiOptionsParams
  ): Promise<ProviderResponse> {
    const secrets = environmentSecrets()
    let evaluationCase: EvaluationCase
    try {
      evaluationCase = structuredCase(prompt, context, this.config.agentId)
    } catch (error) {
      return {
        error: providerError(error, secrets),
        metadata: {
          schemaVersion: 'agentconnect.promptfoo/v1',
          status: 'invalid_case'
        }
      }
    }

    const mode = this.config.mode ?? 'daemon'
    const treatment = configuredTreatment(this.config, mode)
    try {
      if (options?.abortSignal?.aborted) throw new Error('AgentConnect evaluation was aborted before launch')
      const subjectRoot = this.config.subjectRoot?.trim() || process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
      if (!subjectRoot) throw new Error('AGENTCONNECT_EVAL_SUBJECT_ROOT is required')
      const artifactBase = resolve(
        this.config.artifactRoot?.trim() ||
          process.env.AGENTCONNECT_EVAL_ARTIFACT_ROOT?.trim() ||
          '.artifacts/evaluation'
      )
      const artifactRoot = resolve(artifactBase, 'runs')
      const detectedRepository = this.dependencies.repositoryState?.() ?? repositoryState()
      const commit =
        this.config.commit?.trim() ||
        process.env.AGENTCONNECT_EVAL_COMMIT?.trim() ||
        process.env.GITHUB_SHA?.trim() ||
        detectedRepository.commit
      const agentConnect = {
        ...(commit ? { commit } : {}),
        dirty: this.config.dirty ?? booleanEnvironment('AGENTCONNECT_EVAL_DIRTY') ?? detectedRepository.dirty ?? true
      }
      const otel = this.config.otel ?? booleanEnvironment('AGENTCONNECT_EVAL_OTEL') ?? false
      let runner: EvaluationRunnerLike

      if (mode === 'raw-acp') {
        const runnerOptions: ConstructorParameters<typeof RawAcpEvaluationRunner>[0] = {
          subjectRoot,
          artifactRoot,
          name: treatment.name,
          agentConnect,
          otel,
          secrets
        }
        runner = this.dependencies.rawRunner?.(runnerOptions) ?? new RawAcpEvaluationRunner(runnerOptions)
      } else {
        const runnerOptions: ConstructorParameters<typeof EvaluationRunner>[0] = {
          subjectRoot,
          artifactRoot,
          treatment,
          agentConnect,
          otel,
          secrets
        }
        runner = this.dependencies.daemonRunner?.(runnerOptions) ?? new EvaluationRunner(runnerOptions)
      }

      const result = await runner.run(evaluationCase)
      const metadata = {
        schemaVersion: 'agentconnect.promptfoo/v1',
        caseId: evaluationCase.id,
        mode,
        treatment,
        runId: result.runId,
        status: result.status,
        artifacts: {
          directory: result.artifactDir,
          manifest: result.manifestPath,
          events: result.eventsPath,
          trajectory: result.trajectoryPath
        }
      }
      if (result.status !== 'passed') {
        return {
          output: result.output,
          error: `${result.status}: ${providerError(result.error?.message ?? 'evaluation did not pass', secrets)}`,
          metadata,
          tokenUsage: tokenUsage(result)
        }
      }
      return { output: result.output, metadata, tokenUsage: tokenUsage(result) }
    } catch (error) {
      return {
        error: providerError(error, secrets),
        metadata: {
          schemaVersion: 'agentconnect.promptfoo/v1',
          caseId: evaluationCase.id,
          mode,
          treatment,
          status: 'infra_error'
        }
      }
    }
  }
}
