import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { AcpHost, turnFailureCode } from '../acp/acp-host.js'
import { detectSandbox } from '../acp/sandbox.js'
import { effectiveRunInSandbox } from '../launch/prepare.js'
import { agentChildEnv } from '../agents/agent-env.js'
import { selectAgent } from '../agents/load-agents.js'
import { memoryProviderFor } from '../memory/provider.js'
import { loadConfig } from '../config/load-config.js'
import { Daemon, type DaemonEvaluationOptions, type DaemonEvaluationTurnResult } from '../daemon.js'
import { composeRuntimeLaunch } from '../launch/compose.js'
import { persistSkillSandboxRequirement } from '../skills/skill-sandbox-policy.js'
import { DAEMON_VERSION } from '../version.js'
import {
  EVALUATION_RUN_SCHEMA_VERSION,
  EvaluationEventCollector,
  redactEvaluationValue,
  type EvaluationRunManifest,
  type EvaluationRunStatus,
  writeEvaluationRunManifest
} from './artifacts.js'
import { evaluationEventsToAtif, writeAtifTrajectory } from './atif.js'
import {
  EvaluationCapabilityProfileSchema,
  EvaluationEventEmitter,
  compositeEvaluationObserver,
  type EvaluationCapabilityProfile,
  type EvaluationEvent
} from './events.js'
import { createEvaluationOtelObserver } from './telemetry.js'
import { evaluationTokenMetricsFromUsage } from './token-metrics.js'

export const EvaluationCaseTurnSchema = z.object({
  agentId: z.string().min(1),
  text: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  user: z.string().min(1).optional()
})

export const EvaluationCaseSchema = z.object({
  id: z.string().min(1),
  turns: z.array(EvaluationCaseTurnSchema).min(1),
  /** Additional agents copied into the disposable subject for collaboration cases. */
  fixtureAgentIds: z.array(z.string().min(1)).default([]),
  rootAgentId: z.string().min(1).optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(10 * 60_000)
    .default(120_000),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>
export type EvaluationCaseInput = z.input<typeof EvaluationCaseSchema>

export interface EvaluationTreatment extends EvaluationCapabilityProfile {
  name: string
}

export interface EvaluationRunnerOptions {
  /** Disposable template: config.json plus agents/<id>/agent.json and optional memory/. */
  subjectRoot: string
  artifactRoot: string
  treatment: EvaluationTreatment
  agentConnect?: { commit?: string; dirty?: boolean }
  otel?: boolean
  /** Explicit secrets to redact in addition to values discovered in template env files. */
  secrets?: readonly string[]
  /** Test/embedding seam. Production uses a real Daemon with real ACP runtimes. */
  daemonFactory?: (options: { root: string; evaluation: DaemonEvaluationOptions }) => Daemon
}

export interface EvaluationCaseResult {
  runId: string
  status: EvaluationRunStatus
  output: string
  turns: DaemonEvaluationTurnResult[]
  /** Aggregate metrics from every observed turn, including collaboration-spawned work. */
  metrics: NonNullable<EvaluationRunManifest['metrics']>
  artifactDir: string
  manifestPath: string
  eventsPath: string
  trajectoryPath: string
  error?: { code: string; message: string }
}

interface PreparedSubject {
  root: string
  cleanup(): void
  agents: Record<string, { name: string; runtime: string; model?: string; settings: Record<string, unknown> }>
  secrets: string[]
}

interface RuntimeEvidence {
  runtimeVersion?: string
  provider?: string
  acpVersion?: number
  model?: string
}

const SECRET_KEY =
  /(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|cookie|connection[_-]?string|database[_-]?(?:url|uri)|dsn)/i
const SECRET_FLAG =
  /^--?(?:token|secret|password|api[-_]?key|access[-_]?key|private[-_]?key|credential|auth|cookie|connection[-_]?string|database[-_]?(?:url|uri)|dsn)(?:=|$)/i

/** Secret-shaped values found in the process environment — shared by every
 *  evaluation runner's redaction set (exported for the game runners). */
export function environmentSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value!)
}

/** Recursively harvest secret-shaped values from a parsed config/agent object
 *  (exported for the game subject preparation). */
export function collectObjectSecrets(value: unknown, keyPath = '', output: string[] = []): string[] {
  if (typeof value === 'string') {
    if ((SECRET_KEY.test(keyPath) || /^controlPlane\.key$/i.test(keyPath)) && value.length >= 4) output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        const equals = item.indexOf('=')
        const flag = equals > 0 ? item.slice(0, equals) : item
        if (SECRET_FLAG.test(flag)) {
          const inline = equals > 0 ? item.slice(equals + 1) : undefined
          const following = equals < 0 && typeof value[index + 1] === 'string' ? value[index + 1] : undefined
          if (inline && inline.length >= 4) output.push(inline)
          if (following && following.length >= 4) output.push(following)
        }
      }
      collectObjectSecrets(item, keyPath, output)
    }
    return output
  }
  if (value && typeof value === 'object') {
    const named = value as { name?: unknown; key?: unknown; value?: unknown }
    const logicalName =
      typeof named.name === 'string' ? named.name : typeof named.key === 'string' ? named.key : undefined
    if (logicalName && SECRET_KEY.test(logicalName) && typeof named.value === 'string' && named.value.length >= 4) {
      output.push(named.value)
    }
    for (const [nestedKey, nested] of Object.entries(value)) {
      collectObjectSecrets(nested, keyPath ? `${keyPath}.${nestedKey}` : nestedKey, output)
    }
  }
  return output
}

/** Collapse an untrusted id into a safe single path segment (exported for the
 *  Promptfoo adapters' artifact directories). */
export function safeSegment(value: string): string {
  let safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.+$/, '')
  if (!safe) safe = 'evaluation'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`
  return safe.slice(0, 120).replace(/\.+$/, '') || 'evaluation'
}

function assertSafeAgentId(agentId: string): void {
  if (
    agentId === '.' ||
    agentId === '..' ||
    agentId.includes('/') ||
    agentId.includes('\\') ||
    agentId.includes('\0')
  ) {
    throw new Error(`evaluation agent id is not a safe path segment: ${JSON.stringify(agentId)}`)
  }
}

function assertNotSymlink(path: string, label: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`${label} may not contain symbolic links`)
}

function assertNoSymlinks(path: string, label: string): void {
  assertNotSymlink(path, label)
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path)) assertNoSymlinks(join(path, entry), label)
}

function runtimeEvidence(events: readonly EvaluationEvent[], agentId: string): RuntimeEvidence {
  const started = events.find((event) => event.agentId === agentId && event.type === 'turn.started')
  const runtimeVersion =
    typeof started?.data.runtimeVersion === 'string' && started.data.runtimeVersion
      ? started.data.runtimeVersion
      : undefined
  const provider =
    typeof started?.data.runtimeProvider === 'string' && started.data.runtimeProvider
      ? started.data.runtimeProvider
      : undefined
  const acpVersion =
    typeof started?.data.acpVersion === 'number' &&
    Number.isInteger(started.data.acpVersion) &&
    started.data.acpVersion > 0
      ? started.data.acpVersion
      : undefined
  const model = typeof started?.data.model === 'string' && started.data.model ? started.data.model : undefined
  return {
    ...(runtimeVersion ? { runtimeVersion } : {}),
    ...(provider ? { provider } : {}),
    ...(acpVersion ? { acpVersion } : {}),
    ...(model ? { model } : {})
  }
}

function tokenMetrics(events: readonly EvaluationEvent[]): {
  totalTokens?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
} {
  let totalTokens = 0
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let sawTotal = false
  let sawPrompt = false
  let sawCompletion = false
  let sawCached = false
  for (const event of events) {
    if (event.type !== 'turn.completed') continue
    const metrics = evaluationTokenMetricsFromUsage(event.data.usage)
    if (metrics.totalTokens !== undefined) {
      totalTokens += metrics.totalTokens
      sawTotal = true
    }
    if (metrics.promptTokens !== undefined) {
      promptTokens += metrics.promptTokens
      sawPrompt = true
    }
    if (metrics.completionTokens !== undefined) {
      completionTokens += metrics.completionTokens
      sawCompletion = true
    }
    if (metrics.cachedTokens !== undefined) {
      cachedTokens += metrics.cachedTokens
      sawCached = true
    }
  }
  return {
    ...(sawTotal ? { totalTokens } : {}),
    ...(sawPrompt ? { promptTokens } : {}),
    ...(sawCompletion ? { completionTokens } : {}),
    ...(sawCached ? { cachedTokens } : {})
  }
}

function errorShape(error: unknown, secrets: readonly string[] = []): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
  const code =
    typeof candidate?.code === 'string'
      ? candidate.code
      : typeof candidate?.name === 'string'
        ? candidate.name
        : 'EVALUATION_ERROR'
  return redactEvaluationValue(
    {
      code,
      message: typeof candidate?.message === 'string' ? candidate.message : 'evaluation failed'
    },
    secrets
  ) as { code: string; message: string }
}

class EvaluationTimeoutError extends Error {
  readonly code = 'EVALUATION_TIMEOUT'

  constructor(label: string) {
    super(`${label} exceeded the evaluation case deadline`)
    this.name = 'EvaluationTimeoutError'
  }
}

class ObservedTurnFailureError extends Error {
  readonly code = 'OBSERVED_TURN_FAILURE'

  constructor(event: EvaluationEvent) {
    const detail =
      typeof event.data.code === 'string'
        ? event.data.code
        : typeof event.data.errorName === 'string'
          ? event.data.errorName
          : event.type
    super(`${event.type} for agent ${event.agentId ?? 'unknown'} (${detail})`)
    this.name = 'ObservedTurnFailureError'
  }
}

class ObservedInfrastructureFailureError extends Error {
  readonly code = 'OBSERVED_INFRA_FAILURE'

  constructor(event: EvaluationEvent) {
    const detail =
      typeof event.data.code === 'string'
        ? event.data.code
        : typeof event.data.errorName === 'string'
          ? event.data.errorName
          : event.type
    super(`${event.type} for agent ${event.agentId ?? 'unknown'} (${detail})`)
    this.name = 'ObservedInfrastructureFailureError'
  }
}

class EvaluationObservationError extends Error {
  readonly code = 'EVALUATION_OBSERVER_ERROR'

  constructor(cause: unknown) {
    super('evaluation observer rejected semantic evidence', { cause })
    this.name = 'EvaluationObservationError'
  }
}

function isProviderFailureCode(value: unknown): boolean {
  return value === 'provider_auth_required' || value === 'provider_quota_exhausted'
}

function observedInfrastructureFailure(
  events: readonly EvaluationEvent[],
  profile: EvaluationCapabilityProfile
): EvaluationEvent | undefined {
  return events.find(
    (event) =>
      event.type === 'turn.timed_out' ||
      (event.type === 'turn.failed' && isProviderFailureCode(event.data.code)) ||
      (profile.memory === 'configured' &&
        (event.type === 'memory.recall.failed' || event.type === 'memory.capture.failed'))
  )
}

function failureStatus(
  error: unknown,
  prepared: PreparedSubject | undefined,
  events: readonly EvaluationEvent[],
  profile: EvaluationCapabilityProfile
): EvaluationRunStatus {
  if (!prepared) return 'invalid_case'
  if (
    error instanceof EvaluationTimeoutError ||
    error instanceof ObservedInfrastructureFailureError ||
    error instanceof EvaluationObservationError ||
    observedInfrastructureFailure(events, profile) ||
    isProviderFailureCode(turnFailureCode(error))
  ) {
    return 'infra_error'
  }
  return events.some((event) => event.type === 'turn.started') ? 'agent_failed' : 'infra_error'
}

async function beforeDeadline<T>(deadlineMs: number, label: string, start: () => Promise<T>): Promise<T> {
  const remaining = deadlineMs - Date.now()
  if (remaining <= 0) throw new EvaluationTimeoutError(label)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EvaluationTimeoutError(label)), remaining)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function prepareSubject(options: EvaluationRunnerOptions, agentIds: readonly string[]): PreparedSubject {
  const sourceRoot = resolve(options.subjectRoot)
  const configPath = join(sourceRoot, 'config.json')
  if (!existsSync(configPath)) throw new Error(`evaluation subject is missing ${configPath}`)
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-evaluation-'))
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  try {
    assertNoSymlinks(configPath, 'evaluation config')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const secrets = collectObjectSecrets(config)
    const runtimeDefinitions =
      config.runtimes && typeof config.runtimes === 'object' && !Array.isArray(config.runtimes)
        ? (config.runtimes as Record<string, unknown>)
        : {}
    const safeConfig = {
      ...config,
      daemonId: undefined,
      agentsDir: join(root, 'agents'),
      controlPlane: { enabled: false },
      relays: []
    }
    writeFileSync(join(root, 'config.json'), `${JSON.stringify(safeConfig, null, 2)}\n`, { mode: 0o600 })

    const agents: PreparedSubject['agents'] = {}
    const sourceAgentsDir = join(sourceRoot, 'agents')
    assertNotSymlink(sourceAgentsDir, 'evaluation agents directory')
    for (const agentId of [...new Set(agentIds)]) {
      assertSafeAgentId(agentId)
      const sourceAgentDir = join(sourceAgentsDir, agentId)
      const sourceAgentPath = join(sourceAgentDir, 'agent.json')
      if (!existsSync(sourceAgentPath)) throw new Error(`evaluation subject has no agent "${agentId}"`)
      assertNotSymlink(sourceAgentDir, `evaluation agent "${agentId}" directory`)
      assertNoSymlinks(sourceAgentPath, `evaluation agent "${agentId}" config`)
      const agent = JSON.parse(readFileSync(sourceAgentPath, 'utf8')) as Record<string, any>
      if (agent.id !== agentId) throw new Error(`evaluation agent directory/id mismatch for "${agentId}"`)
      if (
        typeof agent.runtime !== 'string' ||
        !Object.prototype.hasOwnProperty.call(runtimeDefinitions, agent.runtime)
      ) {
        throw new Error(`evaluation agent "${agentId}" requires an explicit runtime definition in config.json`)
      }
      if (options.treatment.memory === 'configured' && agent.memory?.provider === 'external') {
        throw new Error(
          `evaluation agent "${agentId}" uses external memory, which requires a separately isolated connection fixture`
        )
      }
      if (options.treatment.memory === 'configured' && agent.memory?.provider === 'none') {
        throw new Error(`evaluation agent "${agentId}" disables memory in a memory-configured treatment`)
      }
      collectObjectSecrets(agent, '', secrets)

      const targetAgentDir = join(root, 'agents', agentId)
      mkdirSync(targetAgentDir, { recursive: true, mode: 0o700 })
      const sourceMemory = join(sourceAgentDir, 'memory')
      if (options.treatment.memory === 'configured' && existsSync(sourceMemory)) {
        assertNoSymlinks(sourceMemory, `evaluation agent "${agentId}" memory`)
        cpSync(sourceMemory, join(targetAgentDir, 'memory'), {
          recursive: true,
          dereference: false
        })
      }

      const prepared = {
        ...agent,
        status: 'active',
        pause: false,
        integrations: [],
        crons: [],
        mcpServers: [],
        workspace: {
          mode: 'from-scratch',
          path: join(targetAgentDir, 'workspace'),
          gitBranch: 'main',
          pullOnNewSession: true,
          skills: []
        },
        ...(options.treatment.memory === 'off' ? { memory: { provider: 'none' } } : {})
      }
      // Raw ACP subjects do not pass through WorkspaceManager, and many runtimes
      // reject session/new when its cwd does not already exist.
      mkdirSync(prepared.workspace.path, { recursive: true, mode: 0o700 })
      writeFileSync(join(targetAgentDir, 'agent.json'), `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 })
      agents[agentId] = {
        name: typeof agent.name === 'string' && agent.name ? agent.name : agentId,
        runtime: typeof agent.runtime === 'string' && agent.runtime ? agent.runtime : 'unknown',
        ...(typeof agent.runtimeOverrides?.model === 'string' ? { model: agent.runtimeOverrides.model } : {}),
        settings: {
          ...(typeof agent.permissionMode === 'string' ? { permissionMode: agent.permissionMode } : {}),
          ...(typeof agent.reasoningEffort === 'string' ? { reasoningEffort: agent.reasoningEffort } : {}),
          ...(typeof agent.fastMode === 'boolean' ? { fastMode: agent.fastMode } : {}),
          ...(typeof agent.runInSandbox === 'boolean' ? { runInSandbox: agent.runInSandbox } : {}),
          ...(typeof agent.output?.mode === 'string' ? { outputMode: agent.output.mode } : {})
        }
      }
    }
    return { root, cleanup, agents, secrets: [...new Set(secrets.filter((secret) => secret.length >= 4))] }
  } catch (error) {
    cleanup()
    throw error
  }
}

export class EvaluationRunner {
  private readonly treatment: EvaluationTreatment

  constructor(private readonly options: EvaluationRunnerOptions) {
    this.treatment = {
      name: options.treatment.name.trim(),
      ...EvaluationCapabilityProfileSchema.parse(options.treatment)
    }
    if (!this.treatment.name) throw new Error('evaluation treatment name is required')
  }

  async run(rawCase: EvaluationCaseInput): Promise<EvaluationCaseResult> {
    const evaluationCase = EvaluationCaseSchema.parse(rawCase)
    const runId = randomUUID()
    const startedAtMs = Date.now()
    const deadlineMs = startedAtMs + evaluationCase.timeoutMs
    const startedAt = new Date(startedAtMs).toISOString()
    const artifactDir = join(
      resolve(this.options.artifactRoot),
      safeSegment(evaluationCase.id),
      safeSegment(this.treatment.name),
      runId
    )
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 })
    const eventsPath = join(artifactDir, 'events.jsonl')
    const trajectoryPath = join(artifactDir, 'trajectory.json')
    const manifestPath = join(artifactDir, 'run.json')
    const agentIds = [
      ...evaluationCase.turns.map((turn) => turn.agentId),
      ...evaluationCase.fixtureAgentIds,
      ...(evaluationCase.rootAgentId ? [evaluationCase.rootAgentId] : [])
    ]

    let prepared: PreparedSubject | undefined
    let daemon: Daemon | undefined
    let status: EvaluationRunStatus = 'passed'
    let failure: { code: string; message: string } | undefined
    const turns: DaemonEvaluationTurnResult[] = []
    const observationErrors: unknown[] = []
    let redactionSecrets = [...new Set([...(this.options.secrets ?? []), ...environmentSecrets()])]
    let collector = new EvaluationEventCollector(redactionSecrets)

    try {
      prepared = prepareSubject(this.options, agentIds)
      redactionSecrets = [...new Set([...redactionSecrets, ...prepared.secrets])]
      collector = new EvaluationEventCollector(redactionSecrets)
      const observer = compositeEvaluationObserver(
        collector,
        this.options.otel ? createEvaluationOtelObserver(DAEMON_VERSION) : undefined
      )
      const evaluation: DaemonEvaluationOptions = {
        observer,
        runId,
        capabilityProfile: this.treatment,
        onObserverError: (error) => observationErrors.push(error)
      }
      daemon = this.options.daemonFactory
        ? this.options.daemonFactory({ root: prepared.root, evaluation })
        : new Daemon({ root: prepared.root, evaluation, probeRuntimes: async () => [] })
      await beforeDeadline(deadlineMs, 'daemon startup', () => daemon!.start())
      for (const [index, turn] of evaluationCase.turns.entries()) {
        turns.push(
          await beforeDeadline(deadlineMs, `turn ${index + 1}`, () =>
            daemon!.runEvaluationTurn({
              agentId: turn.agentId,
              conversationId: turn.conversationId ?? `${evaluationCase.id}:${turn.agentId}`,
              turnId: turn.turnId ?? `${runId}:${index + 1}`,
              text: turn.text,
              ...(turn.user ? { user: turn.user } : {})
            })
          )
        )
      }
      await beforeDeadline(deadlineMs, 'daemon idle wait', () =>
        daemon!.waitForEvaluationIdle(Math.max(1, deadlineMs - Date.now()))
      )
      try {
        collector.assertValid()
      } catch (error) {
        throw new EvaluationObservationError(error)
      }
      const events = collector.events()
      const infrastructureFailure = observedInfrastructureFailure(events, this.treatment)
      if (infrastructureFailure) throw new ObservedInfrastructureFailureError(infrastructureFailure)
      const observedFailure = events.find((event) => event.type === 'turn.failed' || event.type === 'turn.cancelled')
      if (observedFailure) throw new ObservedTurnFailureError(observedFailure)
    } catch (error) {
      failure = errorShape(error, redactionSecrets)
      status = failureStatus(error, prepared, collector.events(), this.treatment)
    } finally {
      if (daemon) {
        try {
          await daemon.stop()
        } catch (error) {
          failure ??= errorShape(error, redactionSecrets)
          status = 'infra_error'
        }
      }
    }

    if (observationErrors.length > 0) {
      failure = errorShape(new EvaluationObservationError(new AggregateError(observationErrors)), redactionSecrets)
      status = 'infra_error'
    }

    try {
      const events = collector.events()
      const rootAgentId = evaluationCase.rootAgentId ?? evaluationCase.turns[0]!.agentId
      const agentMetadata = Object.fromEntries(
        Object.entries(prepared?.agents ?? {}).map(([agentId, agent]) => {
          const evidence = runtimeEvidence(events, agentId)
          const model = evidence.model ?? agent.model
          return [
            agentId,
            {
              name: agent.name,
              version: evidence.runtimeVersion ?? 'unknown',
              ...(model ? { modelName: model } : {}),
              extra: {
                runtime: agent.runtime,
                agentconnect_version: DAEMON_VERSION,
                settings: agent.settings,
                ...(evidence.provider ? { runtime_provider: evidence.provider } : {}),
                ...(evidence.acpVersion ? { acp_protocol_version: evidence.acpVersion } : {})
              }
            }
          ]
        })
      )
      collector.writeJsonl(eventsPath)
      writeAtifTrajectory(
        trajectoryPath,
        evaluationEventsToAtif(events, {
          runId,
          rootAgentId,
          defaultAgentVersion: 'unknown',
          agents: agentMetadata
        }),
        redactionSecrets
      )

      const rootOutputs = events
        .filter((event) => event.type === 'turn.completed' && event.agentId === rootAgentId)
        .map((event) => event.data.output)
        .filter((value): value is string => typeof value === 'string')
      const output = String(redactEvaluationValue(rootOutputs.at(-1) ?? turns.at(-1)?.output ?? '', redactionSecrets))
      const safeTurns = redactEvaluationValue(turns, redactionSecrets) as DaemonEvaluationTurnResult[]
      const finishedAtMs = Date.now()
      const subject = prepared?.agents[rootAgentId]
      const evidence = runtimeEvidence(events, rootAgentId)
      const model = evidence.model ?? subject?.model
      const metrics: NonNullable<EvaluationRunManifest['metrics']> = {
        latencyMs: Math.max(0, finishedAtMs - startedAtMs),
        turns: events.filter((event) => event.type === 'turn.completed').length,
        toolCalls: events.filter(
          (event) =>
            event.type === 'acp.update' &&
            (event.data.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate === 'tool_call'
        ).length,
        ...tokenMetrics(events)
      }
      const manifest: EvaluationRunManifest = {
        schemaVersion: EVALUATION_RUN_SCHEMA_VERSION,
        runId,
        caseId: evaluationCase.id,
        treatment: this.treatment,
        subject: {
          runtime: subject?.runtime ?? 'unknown',
          ...(model ? { model } : {}),
          ...(evidence.runtimeVersion ? { runtimeVersion: evidence.runtimeVersion } : {}),
          ...(evidence.provider ? { provider: evidence.provider } : {}),
          ...(evidence.acpVersion ? { acpVersion: evidence.acpVersion } : {}),
          ...(subject ? { settings: subject.settings } : {})
        },
        agentConnect: {
          commit: this.options.agentConnect?.commit?.trim() || process.env.GITHUB_SHA || 'unknown',
          dirty: this.options.agentConnect?.dirty ?? true
        },
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        status,
        metrics,
        ...(failure ? { error: failure } : {}),
        artifacts: { events: basename(eventsPath), trajectory: basename(trajectoryPath) },
        metadata: evaluationCase.metadata
      }
      writeEvaluationRunManifest(manifestPath, manifest, redactionSecrets)

      return {
        runId,
        status,
        output,
        turns: safeTurns,
        metrics,
        artifactDir,
        manifestPath,
        eventsPath,
        trajectoryPath,
        ...(failure ? { error: failure } : {})
      }
    } finally {
      prepared?.cleanup()
    }
  }
}

export interface RawAcpEvaluationRunnerOptions {
  subjectRoot: string
  artifactRoot: string
  name?: string
  agentConnect?: { commit?: string; dirty?: boolean }
  otel?: boolean
  secrets?: readonly string[]
}

/** Raw ACP control for harness-neutrality comparisons. It starts the subject's
 * exact runtime with verified native memory disabled, but supplies no AgentConnect
 * standing context, MCP server, transcript, routing, memory, or collaboration. */
export class RawAcpEvaluationRunner {
  constructor(private readonly options: RawAcpEvaluationRunnerOptions) {}

  async run(rawCase: EvaluationCaseInput): Promise<EvaluationCaseResult> {
    const evaluationCase = EvaluationCaseSchema.parse(rawCase)
    const uniqueAgents = [
      ...new Set([...evaluationCase.turns.map((turn) => turn.agentId), ...evaluationCase.fixtureAgentIds])
    ]
    if (uniqueAgents.length !== 1) throw new Error('raw ACP evaluation supports exactly one agent per case')
    const agentId = uniqueAgents[0]!
    if (evaluationCase.rootAgentId && evaluationCase.rootAgentId !== agentId) {
      throw new Error('raw ACP rootAgentId must match the only case agent')
    }

    const runId = randomUUID()
    const startedAtMs = Date.now()
    const deadlineMs = startedAtMs + evaluationCase.timeoutMs
    const startedAt = new Date(startedAtMs).toISOString()
    const treatment: EvaluationTreatment = {
      name: this.options.name?.trim() || 'raw-acp',
      memory: 'off'
    }
    const artifactDir = join(
      resolve(this.options.artifactRoot),
      safeSegment(evaluationCase.id),
      safeSegment(treatment.name),
      runId
    )
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 })
    const eventsPath = join(artifactDir, 'events.jsonl')
    const trajectoryPath = join(artifactDir, 'trajectory.json')
    const manifestPath = join(artifactDir, 'run.json')
    let prepared: PreparedSubject | undefined
    let host: AcpHost | undefined
    let status: EvaluationRunStatus = 'passed'
    let failure: { code: string; message: string } | undefined
    let redactionSecrets = [...new Set([...(this.options.secrets ?? []), ...environmentSecrets()])]
    let collector = new EvaluationEventCollector(redactionSecrets)
    const turns: DaemonEvaluationTurnResult[] = []
    const observationErrors: unknown[] = []
    let subject:
      | ({ name: string; runtime: string; model?: string; settings: Record<string, unknown> } & RuntimeEvidence)
      | undefined

    try {
      prepared = prepareSubject(
        {
          subjectRoot: this.options.subjectRoot,
          artifactRoot: this.options.artifactRoot,
          treatment,
          agentConnect: this.options.agentConnect,
          otel: this.options.otel,
          secrets: this.options.secrets
        },
        [agentId]
      )
      subject = prepared.agents[agentId]
      redactionSecrets = [...new Set([...redactionSecrets, ...prepared.secrets])]
      collector = new EvaluationEventCollector(redactionSecrets)
      const observer = compositeEvaluationObserver(
        collector,
        this.options.otel ? createEvaluationOtelObserver(DAEMON_VERSION) : undefined
      )
      const emitter = new EvaluationEventEmitter({
        observer,
        runId,
        onObserverError: (error) => observationErrors.push(error)
      })
      const cfg = loadConfig({ root: prepared.root })
      const agent = selectAgent(cfg.agentsDir!, agentId)
      const runtime = cfg.runtimes?.[agent.runtime]
      if (!runtime) throw new Error(`raw ACP subject runtime "${agent.runtime}" must be explicit in config.json`)
      const mechanism = detectSandbox()
      await persistSkillSandboxRequirement(prepared.root)
      if (!mechanism) throw new Error('raw ACP evaluation requires a supported Linux SRT/bwrap sandbox')
      const runInSandbox = effectiveRunInSandbox(true, agent.runInSandbox, mechanism)
      const baseEnv = agentChildEnv(agent)
      const runtimeEnv = Object.fromEntries(runtime.env.map((entry) => [entry.name, entry.value]))
      const memoryOffEnv = memoryProviderFor(
        { ...agent, memory: { provider: 'none' } },
        runtime,
        { ...runtimeEnv, ...baseEnv },
        undefined
      ).runtimeEnv()
      const composed = composeRuntimeLaunch({
        runtimeId: agent.runtime,
        runtime,
        provider: 'none',
        scopeDir: agent.dir,
        cwd: agent.workspace.path,
        runInSandbox,
        daemonRoot: prepared.root,
        agentsRoot: cfg.agentsDir,
        explicitEnv: { ...runtimeEnv, ...baseEnv, ...memoryOffEnv },
        sandboxMechanism: mechanism
      })
      let active: { sessionId: string; turnId: string; output: string; platform: string; channel: string } | undefined
      host = new AcpHost(composed.runtime, {
        onUpdate: (sessionId, update) => {
          if (!active || active.sessionId !== sessionId) return
          emitter.emit({
            type: 'acp.update',
            agentId,
            sessionId,
            turnId: active.turnId,
            platform: active.platform,
            channel: active.channel,
            data: { update }
          })
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
            active.output += String(update.content.text ?? '')
          }
        },
        onPermissionEvent: (sessionId, params, event) => {
          if (!active || active.sessionId !== sessionId) return
          const toolCallId = typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId : undefined
          const context = {
            agentId,
            sessionId,
            turnId: active.turnId,
            platform: active.platform,
            channel: active.channel
          }
          if (event.kind === 'requested') {
            emitter.emit({
              type: 'permission.requested',
              ...context,
              data: { ...(toolCallId ? { toolCallId } : {}), optionCount: params.options.length }
            })
            return
          }
          const outcome = event.response.outcome
          const selectedOption =
            'optionId' in outcome ? params.options.find((option) => option.optionId === outcome.optionId) : undefined
          const data = {
            source: event.source,
            ...(event.fallbackReason ? { fallbackReason: event.fallbackReason } : {}),
            outcome: outcome.outcome,
            ...('optionId' in outcome ? { optionId: outcome.optionId } : {}),
            ...(toolCallId ? { toolCallId } : {})
          }
          if (
            event.source === 'fallback' &&
            outcome.outcome === 'selected' &&
            (selectedOption?.kind === 'allow_once' || selectedOption?.kind === 'allow_always')
          ) {
            emitter.emit({ type: 'permission.auto_allowed', ...context, data })
          }
          emitter.emit({
            type: outcome.outcome === 'cancelled' ? 'permission.cancelled' : 'permission.resolved',
            ...context,
            data
          })
        },
        env: composed.launch.env,
        inheritProcessEnv: composed.launch.inheritProcessEnv,
        runtimeId: agent.runtime,
        isolateAccountApps: cfg.security.isolateAccountApps,
        sandbox: composed.launch.sandbox,
        configPrefs: {
          model: agent.runtimeOverrides?.model,
          permissionMode: agent.permissionMode,
          reasoningEffort: agent.reasoningEffort,
          fastMode: agent.fastMode
        }
      })
      await beforeDeadline(deadlineMs, 'raw ACP startup', () => host!.start())
      const runtimeAgentInfo = host.acpAgentInfo()
      subject = {
        ...subject!,
        ...(runtimeAgentInfo?.name ? { provider: runtimeAgentInfo.name } : {}),
        ...(runtimeAgentInfo?.version ? { runtimeVersion: runtimeAgentInfo.version } : {}),
        ...(host.acpProtocolVersion() ? { acpVersion: host.acpProtocolVersion() } : {})
      }
      const sessions = new Map<string, string>()
      for (const [index, turn] of evaluationCase.turns.entries()) {
        const conversationId = turn.conversationId ?? `${evaluationCase.id}:${agentId}`
        let sessionId = sessions.get(conversationId)
        if (!sessionId) {
          sessionId = await beforeDeadline(deadlineMs, `raw ACP session ${conversationId}`, () =>
            host!.newSession(agent.workspace.path, [])
          )
          sessions.set(conversationId, sessionId)
        }
        const selectedModel = host.modelOptions(sessionId)?.current
        if (selectedModel && selectedModel !== 'default') subject = { ...subject!, model: selectedModel }
        const turnId = turn.turnId ?? `${runId}:${index + 1}`
        emitter.emit({
          type: 'turn.accepted',
          agentId,
          sessionId,
          turnId,
          platform: 'raw-acp',
          channel: conversationId,
          data: { source: 'evaluation' }
        })
        emitter.emit({
          type: 'turn.started',
          agentId,
          sessionId,
          turnId,
          platform: 'raw-acp',
          channel: conversationId,
          data: {
            input: turn.text,
            runtime: agent.runtime,
            ...(subject.model ? { model: subject.model } : {}),
            ...(subject.provider ? { runtimeProvider: subject.provider } : {}),
            ...(subject.runtimeVersion ? { runtimeVersion: subject.runtimeVersion } : {}),
            ...(subject.acpVersion ? { acpVersion: subject.acpVersion } : {})
          }
        })
        active = { sessionId, turnId, output: '', platform: 'raw-acp', channel: conversationId }
        try {
          const response = await beforeDeadline(deadlineMs, `raw ACP turn ${index + 1}`, () =>
            host!.prompt(sessionId, [{ type: 'text', text: turn.text }])
          )
          const output = active.output
          emitter.emit({
            type: 'turn.completed',
            agentId,
            sessionId,
            turnId,
            platform: 'raw-acp',
            channel: conversationId,
            data: {
              output,
              ...(response.stopReason ? { stopReason: response.stopReason } : {}),
              ...(response.usage ? { usage: response.usage } : {})
            }
          })
          turns.push({
            turnId,
            sessionId,
            output,
            events: [],
            ...(response.stopReason ? { stopReason: response.stopReason } : {}),
            ...(response.usage?.totalTokens !== undefined ? { usage: { used: response.usage.totalTokens } } : {})
          })
        } catch (error) {
          emitter.emit({
            type: error instanceof EvaluationTimeoutError ? 'turn.timed_out' : 'turn.failed',
            agentId,
            sessionId,
            turnId,
            platform: 'raw-acp',
            channel: conversationId,
            data: {
              code: turnFailureCode(error),
              errorName: error instanceof Error ? error.name : 'UnknownError'
            }
          })
          throw error
        } finally {
          active = undefined
        }
      }
      try {
        collector.assertValid()
      } catch (error) {
        throw new EvaluationObservationError(error)
      }
    } catch (error) {
      failure = errorShape(error, redactionSecrets)
      status = failureStatus(error, prepared, collector.events(), treatment)
    } finally {
      if (host) {
        try {
          await host.stop()
        } catch (error) {
          failure ??= errorShape(error, redactionSecrets)
          status = 'infra_error'
        }
      }
    }

    if (observationErrors.length > 0) {
      failure = errorShape(new EvaluationObservationError(new AggregateError(observationErrors)), redactionSecrets)
      status = 'infra_error'
    }

    try {
      const events = collector.events()
      collector.writeJsonl(eventsPath)
      writeAtifTrajectory(
        trajectoryPath,
        evaluationEventsToAtif(events, {
          runId,
          rootAgentId: agentId,
          defaultAgentVersion: 'unknown',
          agents: {
            [agentId]: {
              name: subject?.name ?? agentId,
              version: subject?.runtimeVersion ?? 'unknown',
              ...(subject?.model ? { modelName: subject.model } : {}),
              extra: {
                runtime: subject?.runtime ?? 'unknown',
                execution: 'raw-acp',
                agentconnect_version: DAEMON_VERSION,
                settings: subject?.settings ?? {},
                ...(subject?.provider ? { runtime_provider: subject.provider } : {}),
                ...(subject?.acpVersion ? { acp_protocol_version: subject.acpVersion } : {})
              }
            }
          }
        }),
        redactionSecrets
      )
      const output = String(redactEvaluationValue(turns.at(-1)?.output ?? '', redactionSecrets))
      const safeTurns = redactEvaluationValue(turns, redactionSecrets) as DaemonEvaluationTurnResult[]
      const finishedAtMs = Date.now()
      const metrics: NonNullable<EvaluationRunManifest['metrics']> = {
        latencyMs: Math.max(0, finishedAtMs - startedAtMs),
        turns: events.filter((event) => event.type === 'turn.completed').length,
        toolCalls: events.filter(
          (event) =>
            event.type === 'acp.update' &&
            (event.data.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate === 'tool_call'
        ).length,
        ...tokenMetrics(events)
      }
      const manifest: EvaluationRunManifest = {
        schemaVersion: EVALUATION_RUN_SCHEMA_VERSION,
        runId,
        caseId: evaluationCase.id,
        treatment,
        subject: {
          runtime: subject?.runtime ?? 'unknown',
          ...(subject?.model ? { model: subject.model } : {}),
          ...(subject?.runtimeVersion ? { runtimeVersion: subject.runtimeVersion } : {}),
          ...(subject?.provider ? { provider: subject.provider } : {}),
          ...(subject?.acpVersion ? { acpVersion: subject.acpVersion } : {}),
          settings: { ...(subject?.settings ?? {}), execution: 'raw-acp' }
        },
        agentConnect: {
          commit: this.options.agentConnect?.commit?.trim() || process.env.GITHUB_SHA || 'unknown',
          dirty: this.options.agentConnect?.dirty ?? true
        },
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        status,
        metrics,
        ...(failure ? { error: failure } : {}),
        artifacts: { events: basename(eventsPath), trajectory: basename(trajectoryPath) },
        metadata: evaluationCase.metadata
      }
      writeEvaluationRunManifest(manifestPath, manifest, redactionSecrets)
      return {
        runId,
        status,
        output,
        turns: safeTurns,
        metrics,
        artifactDir,
        manifestPath,
        eventsPath,
        trajectoryPath,
        ...(failure ? { error: failure } : {})
      }
    } finally {
      prepared?.cleanup()
    }
  }
}
