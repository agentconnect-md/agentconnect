import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionUpdate } from '@agentclientprotocol/sdk'

import type { AcpHost } from '../../src/acp/acp-host.js'
import { Daemon, type DaemonEvaluationTurnResult } from '../../src/daemon.js'
import { EvaluationEventCollector } from '../../src/evaluation/artifacts.js'
import type { K8sRuntimePlane } from '../../src/k8s/runtime-plane.js'
import type { K8sDriver } from '../../src/k8s/driver.js'
import type { ResolvedRuntimeCatalog } from '../../src/runtimes/registry.js'
import type { TranscriptRow } from '../../src/store/local-store.js'
import type { ShimDialer } from '../../src/shim/dialer.js'
import {
  createEventLoopDriftSampler,
  measureWithTimeout,
  summarizeDurations,
  type RungSummary
} from './postgres-capacity-support.js'

const RUNTIME_ID = 'capacity-runtime'
const EMISSIONS_PER_PROMPT = 38

type OpenDataPlane = NonNullable<NonNullable<ConstructorParameters<typeof Daemon>[0]>['openDataPlane']>
type OpenedDataPlane = Awaited<ReturnType<OpenDataPlane>>

export interface PromptBehaviorContext {
  agentId: string
  promptOrdinal: number
  measured: boolean
}

export type PromptBehavior = { kind: 'error'; error: Error } | { kind: 'delay'; delayMs: number } | undefined

export interface PostgresDaemonHarnessOptions {
  concurrency: number
  streamDelayMs: number
  openDataPlane: OpenDataPlane
  organizationId?: string
  promptBehavior?: (context: PromptBehaviorContext) => PromptBehavior
}

export interface PromptObservation {
  agentId: string
  promptOrdinal: number
  measured: boolean
  updateKinds: string[]
  pauseCount: number
}

export interface HarnessObservations {
  prompts: PromptObservation[]
  sessionIds: string[]
  toolIds: string[]
  newSessionCalls: Record<string, number>
  loadSessionCalls: Record<string, number>
  discardSessionCalls: Record<string, number>
  promptSessionIds: Record<string, string[]>
  globalActive: number
  maxGlobalActive: number
  maxPerAgentActive: Record<string, number>
  overlapViolations: string[]
}

export interface FakeK8sRuntimePlane extends K8sRuntimePlane {
  ensureChannelCalls: string[]
  stopped: boolean
}

export interface MeasuredDaemonTurn {
  agentId: string
  conversationId: string
  turnId: string
  promptOrdinal: number
  elapsedMs: number
  infrastructureLatencyMs: number
  status: 'completed' | 'error' | 'timeout'
  output?: string
  error?: unknown
}

export interface DaemonRungResult {
  summary: RungSummary
  raw: {
    waves: number
    simulatedPauseMsPerTurn: number
    turns: MeasuredDaemonTurn[]
    latencySamples: number[]
    latencySummary: ReturnType<typeof summarizeDurations>
    infrastructureLatencySamples: number[]
    eventLoopSamples: number[]
    eventLoopSummary: ReturnType<typeof summarizeDurations>
  }
}

export interface HarnessVerification {
  completedOutputs: number
  terminalSessions: number
  reasoningRows: number
  toolRows: number
  resolvedOrganizationByAgent: Record<string, string>
}

interface MutableObservations extends HarnessObservations {
  perAgentActive: Record<string, number>
}

function validateRungSettings(settings: { minTurns: number; minWaves: number; turnTimeoutMs: number }): void {
  for (const [name, value] of [
    ['minTurns', settings.minTurns],
    ['minWaves', settings.minWaves]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  }
  if (!Number.isFinite(settings.turnTimeoutMs) || settings.turnTimeoutMs < 0) {
    throw new Error('turnTimeoutMs must be finite and nonnegative')
  }
}

function validateOptions(options: PostgresDaemonHarnessOptions): void {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('concurrency must be a positive safe integer')
  }
  if (!Number.isFinite(options.streamDelayMs) || options.streamDelayMs < 0) {
    throw new Error('streamDelayMs must be finite and nonnegative')
  }
}

function scaffoldRoot(concurrency: number): { root: string; agentIds: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'ac-postgres-capacity-'))
  const agentIds = Array.from(
    { length: concurrency },
    (_, index) => `capacity-agent-${String(index + 1).padStart(3, '0')}`
  )
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      limits: { maxAgents: concurrency, maxConcurrentSessions: concurrency },
      runtimes: { [RUNTIME_ID]: { command: 'capacity-runtime', args: [] } }
    })
  )
  for (const agentId of agentIds) {
    const agentDir = join(root, 'agents', agentId)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: agentId,
        status: 'active',
        runtime: RUNTIME_ID,
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
  }
  return { root, agentIds }
}

function runtimeCatalog(): ResolvedRuntimeCatalog {
  const runtime = { command: 'capacity-runtime', args: [], env: [] }
  return {
    runtimes: { [RUNTIME_ID]: runtime },
    entries: {
      [RUNTIME_ID]: {
        runtime,
        source: 'user',
        name: 'Capacity Runtime',
        version: 'test',
        skillsAgentId: null
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createFakeK8sRuntimePlane(workspaceRoot: string): FakeK8sRuntimePlane {
  let stopped = false
  const plane = {
    driver: {
      claimName: (agentId: string) => `capacity-${agentId}`
    } as unknown as K8sDriver,
    dialer: {} as ShimDialer,
    memberId: 'capacity-member',
    // No pool template behind the fake, so the probe path stays on its "probe alone" arm.
    runtimeImage: async (): Promise<string> => {
      throw new Error('the fake plane pins no pool runtime image')
    },
    ensureChannelCalls: [] as string[],
    get stopped() {
      return stopped
    },
    ensureChannel: async (agentId: string) => {
      plane.ensureChannelCalls.push(agentId)
    },
    withSandbox: async <T>(_agentId: string, work: () => Promise<T>) => work(),
    probeRuntimes: async () => ({ runtimes: [{ id: RUNTIME_ID, version: 'test', models: [] }] }),
    gitRunnerFor: () => undefined,
    workspaceFilesFor: () => undefined,
    workspaceFsFor: () => undefined,
    memoryFsFor: () => undefined,
    autoMergeFor: () => undefined,
    runsInSandbox: () => true,
    clearPath: async () => undefined,
    workspaceRootFor: () => workspaceRoot,
    launchedAgents: () => [],
    adoptAgent: async () => {},
    releaseAgent: () => {},
    suspendIdle: async () => 'absent' as const,
    discardAgent: async () => {},
    stop: async () => {
      stopped = true
    }
  } satisfies FakeK8sRuntimePlane
  return plane
}

function createScriptedHostFactory(
  streamDelayMs: number,
  observations: MutableObservations,
  behavior?: (context: PromptBehaviorContext) => PromptBehavior
): NonNullable<ConstructorParameters<typeof Daemon>[0]>['hostFactory'] {
  return (agent, onUpdate) => {
    const agentId = agent.id
    const sessionId = `capacity-session-${agentId}`
    let promptOrdinal = 0
    let live = false
    observations.sessionIds.push(sessionId)
    const emit = async (prompt: PromptObservation, update: SessionUpdate) => {
      onUpdate(sessionId, update)
      prompt.updateKinds.push(update.sessionUpdate)
      prompt.pauseCount += 1
      await delay(streamDelayMs)
    }
    const host = {
      start: async () => {},
      newSession: async () => {
        observations.newSessionCalls[agentId] = (observations.newSessionCalls[agentId] ?? 0) + 1
        if (live) throw new Error(`scripted host ${agentId} received overlapping session/new`)
        live = true
        return sessionId
      },
      loadSession: async (loadedSessionId: string) => {
        observations.loadSessionCalls[agentId] = (observations.loadSessionCalls[agentId] ?? 0) + 1
        if (loadedSessionId !== sessionId) throw new Error(`scripted host ${agentId} received an unknown session/load`)
        live = true
      },
      loadSupported: () => false,
      hasSession: (id: string) => live && id === sessionId,
      usesMetaSystemPrompt: () => false,
      promptSupports: () => true,
      modelOptions: () => ({ current: 'capacity-model', models: ['capacity-model'] }),
      permissionModeOptions: () => null,
      prompt: async (promptSessionId: string) => {
        if (!live || promptSessionId !== sessionId) {
          throw new Error(`scripted host ${agentId} received a prompt for a non-live session`)
        }
        ;(observations.promptSessionIds[agentId] ??= []).push(promptSessionId)
        promptOrdinal += 1
        const measured = promptOrdinal > 1
        const prompt: PromptObservation = { agentId, promptOrdinal, measured, updateKinds: [], pauseCount: 0 }
        observations.prompts.push(prompt)
        observations.globalActive += 1
        observations.perAgentActive[agentId] = (observations.perAgentActive[agentId] ?? 0) + 1
        observations.maxGlobalActive = Math.max(observations.maxGlobalActive, observations.globalActive)
        observations.maxPerAgentActive[agentId] = Math.max(
          observations.maxPerAgentActive[agentId] ?? 0,
          observations.perAgentActive[agentId]
        )
        if (observations.perAgentActive[agentId] > 1) observations.overlapViolations.push(agentId)
        try {
          const action = behavior?.({ agentId, promptOrdinal, measured })
          if (action?.kind === 'error') throw action.error
          if (action?.kind === 'delay') await delay(action.delayMs)
          await emit(prompt, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: `reasoning:${agentId}:${promptOrdinal}` }
          })
          for (let toolIndex = 1; toolIndex <= 6; toolIndex += 1) {
            const toolCallId = `tool:${agentId}:${promptOrdinal}:${toolIndex}`
            observations.toolIds.push(toolCallId)
            await emit(prompt, {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: `Tool ${toolIndex}`,
              status: 'in_progress',
              rawInput: { agentId, promptOrdinal, toolIndex }
            })
            for (let updateIndex = 1; updateIndex <= 5; updateIndex += 1) {
              await emit(prompt, {
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: updateIndex === 5 ? 'completed' : 'in_progress',
                rawOutput: { updateIndex }
              })
            }
          }
          await emit(prompt, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `answer:${agentId}:${promptOrdinal}` }
          })
          return { stopReason: 'end_turn' as const, usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4 } }
        } finally {
          observations.globalActive -= 1
          observations.perAgentActive[agentId] -= 1
        }
      },
      cancel: async () => {},
      discardSession: () => {
        observations.discardSessionCalls[agentId] = (observations.discardSessionCalls[agentId] ?? 0) + 1
        live = false
      },
      stop: async () => {
        live = false
      }
    }
    return host as unknown as AcpHost
  }
}

export async function createPostgresDaemonHarness(options: PostgresDaemonHarnessOptions) {
  validateOptions(options)
  const { root, agentIds } = scaffoldRoot(options.concurrency)
  const collector = new EvaluationEventCollector()
  const observations: MutableObservations = {
    prompts: [],
    sessionIds: [],
    toolIds: [],
    newSessionCalls: {},
    loadSessionCalls: {},
    discardSessionCalls: {},
    promptSessionIds: {},
    globalActive: 0,
    perAgentActive: {},
    maxGlobalActive: 0,
    maxPerAgentActive: {},
    overlapViolations: []
  }
  const plane = createFakeK8sRuntimePlane(join(root, 'sandbox-workspaces'))
  const organizationId = options.organizationId ?? 'benchmark-org'
  const resolvedOrganizationByAgent: Record<string, string> = {}
  const authoritativeOrgForAgent = (agentId?: string) => {
    if (agentId && agentIds.includes(agentId)) resolvedOrganizationByAgent[agentId] = organizationId
    return organizationId
  }
  let dataPlane: OpenedDataPlane | undefined
  const daemon = new Daemon({
    root,
    k8s: true,
    evaluation: { observer: collector, runId: `capacity-${Date.now()}`, capabilityProfile: { memory: 'off' } },
    hostFactory: createScriptedHostFactory(options.streamDelayMs, observations, options.promptBehavior),
    openDataPlane: async (_orgForAgent, onFailure) => {
      dataPlane = await options.openDataPlane(authoritativeOrgForAgent, onFailure)
      return dataPlane
    },
    startK8sPlane: async () => plane,
    startControlPlane: async () => {},
    resolveCatalog: async () => runtimeCatalog(),
    installed: (runtimes) => runtimes,
    probeRuntimes: async () => []
  })
  let closed = false
  let warmed = false
  let measuredTurns: MeasuredDaemonTurn[] = []
  try {
    await daemon.start()
  } catch (error) {
    try {
      await daemon.stop()
    } catch {}
    if (!plane.stopped) await plane.stop().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
    throw error
  }

  const runTurn = async (agentId: string, sequence: number, measured: boolean) => {
    const conversationId = `capacity-conversation:${agentId}`
    const turnId = `capacity-turn:${agentId}:${measured ? 'measured' : 'warm'}:${sequence}`
    return daemon.runEvaluationTurn({ agentId, conversationId, turnId, text: `capacity prompt ${sequence}` })
  }

  let closePromise: Promise<void> | undefined
  const result = {
    root,
    agentIds,
    plane,
    dataPlane: () => dataPlane,
    observations: (): HarnessObservations => ({
      prompts: observations.prompts.map((prompt) => ({ ...prompt, updateKinds: [...prompt.updateKinds] })),
      sessionIds: [...observations.sessionIds],
      toolIds: [...observations.toolIds],
      newSessionCalls: { ...observations.newSessionCalls },
      loadSessionCalls: { ...observations.loadSessionCalls },
      discardSessionCalls: { ...observations.discardSessionCalls },
      promptSessionIds: Object.fromEntries(
        Object.entries(observations.promptSessionIds).map(([agentId, sessionIds]) => [agentId, [...sessionIds]])
      ),
      globalActive: observations.globalActive,
      maxGlobalActive: observations.maxGlobalActive,
      maxPerAgentActive: { ...observations.maxPerAgentActive },
      overlapViolations: [...observations.overlapViolations]
    }),
    waitUntilIdle: (timeoutMs?: number) => daemon.waitForEvaluationIdle(timeoutMs),
    runRung: async (settings: {
      minTurns: number
      minWaves: number
      turnTimeoutMs: number
    }): Promise<DaemonRungResult> => {
      if (closed) throw new Error('daemon harness is closed')
      if (warmed) throw new Error('daemon harness supports exactly one rung')
      validateRungSettings(settings)
      warmed = true
      await Promise.all(agentIds.map((agentId, index) => runTurn(agentId, index + 1, false)))
      const sampler = createEventLoopDriftSampler()
      try {
        const startedAt = performance.now()
        const turns: MeasuredDaemonTurn[] = []
        let wave = 0
        let healthy = true
        while (healthy && (turns.length < settings.minTurns || wave < settings.minWaves)) {
          wave += 1
          const outcomes = await Promise.all(
            agentIds.map(async (agentId, agentIndex) => {
              const sequence = (wave - 1) * agentIds.length + agentIndex + 1
              const promptOrdinal = wave + 1
              const conversationId = `capacity-conversation:${agentId}`
              const turnId = `capacity-turn:${agentId}:measured:${sequence}`
              const outcome = await measureWithTimeout(
                () =>
                  daemon.runEvaluationTurn({ agentId, conversationId, turnId, text: `capacity prompt ${sequence}` }),
                settings.turnTimeoutMs
              )
              const infrastructureLatencyMs = Math.max(
                0,
                outcome.elapsedMs - EMISSIONS_PER_PROMPT * options.streamDelayMs
              )
              if (outcome.status === 'completed') {
                return {
                  agentId,
                  conversationId,
                  turnId,
                  promptOrdinal,
                  elapsedMs: outcome.elapsedMs,
                  infrastructureLatencyMs,
                  status: 'completed' as const,
                  output: (outcome.value as DaemonEvaluationTurnResult).output
                }
              }
              return {
                agentId,
                conversationId,
                turnId,
                promptOrdinal,
                elapsedMs: outcome.elapsedMs,
                infrastructureLatencyMs,
                status: outcome.status,
                ...(outcome.status === 'error' ? { error: outcome.error } : {})
              }
            })
          )
          turns.push(...outcomes)
          healthy = outcomes.every((outcome) => outcome.status === 'completed')
        }
        await daemon.waitForEvaluationIdle(Math.max(30_000, settings.turnTimeoutMs * 2))
        const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, Number.EPSILON)
        const eventLoopSamples = [...sampler.stop()]
        const completed = turns.filter((turn) => turn.status === 'completed').length
        const errors = turns.filter((turn) => turn.status === 'error').length
        const timeouts = turns.filter((turn) => turn.status === 'timeout').length
        const latencySamples = turns.map((turn) => turn.elapsedMs)
        const infrastructureLatencySamples = turns.map((turn) => turn.infrastructureLatencyMs)
        measuredTurns = turns
        return {
          summary: {
            concurrency: options.concurrency,
            attempted: turns.length,
            completed,
            errors,
            timeouts,
            throughput: completed / elapsedSeconds,
            infrastructureLatency: summarizeDurations(infrastructureLatencySamples),
            eventLoopDelay: summarizeDurations(eventLoopSamples)
          },
          raw: {
            waves: wave,
            simulatedPauseMsPerTurn: EMISSIONS_PER_PROMPT * options.streamDelayMs,
            turns,
            latencySamples,
            latencySummary: summarizeDurations(latencySamples),
            infrastructureLatencySamples,
            eventLoopSamples,
            eventLoopSummary: summarizeDurations(eventLoopSamples)
          }
        }
      } finally {
        sampler.stop()
      }
    },
    verification: async (): Promise<HarnessVerification> => {
      const measuredConversations = new Set(measuredTurns.map((turn) => turn.conversationId))
      const sessions =
        (await dataPlane?.store.listSessions())?.filter((session) => measuredConversations.has(session.channel)) ?? []
      const transcript: TranscriptRow[] = []
      for (const session of sessions)
        transcript.push(...(await dataPlane!.store.threadTranscript(session.channel, session.thread, session.agentId)))
      const reasoningRows = transcript.filter((row) => row.kind === 'reasoning' && !row.text.endsWith(':1')).length
      const toolRows = transcript.filter((row) => {
        if (row.kind !== 'tool' || !row.body) return false
        const body = JSON.parse(row.body) as { rawInput?: { promptOrdinal?: number } }
        return (body.rawInput?.promptOrdinal ?? 0) > 1
      }).length
      return {
        completedOutputs: measuredTurns.filter((turn) => turn.status === 'completed' && turn.output).length,
        terminalSessions: sessions.filter((session) => session.state === 'idle').length,
        reasoningRows,
        toolRows,
        resolvedOrganizationByAgent: { ...resolvedOrganizationByAgent }
      }
    },
    close: () => {
      if (closePromise) return closePromise
      const cleanup = async () => {
        let firstError: unknown
        try {
          await daemon.waitForEvaluationIdle(30_000)
        } catch (error) {
          firstError = error
        }
        try {
          collector.assertValid()
        } catch (error) {
          firstError ??= error
        }
        try {
          await daemon.stop()
        } catch (error) {
          firstError ??= error
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
        if (firstError) throw firstError
      }
      closePromise = cleanup()
      closed = true
      return closePromise
    }
  }
  return result
}
