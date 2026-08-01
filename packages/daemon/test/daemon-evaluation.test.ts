import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ORGANIZATION_SUGGESTION_REVIEW_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'

const AGENT_ID = 'evaluation-agent'

function scaffold(opts: { runtimeCommand?: string; model?: string; autoAdopt?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-evaluation-daemon-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { test: { command: opts.runtimeCommand ?? 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', AGENT_ID)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: 'Evaluation Agent',
      status: 'active',
      runtime: 'test',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' },
      ...(opts.autoAdopt !== undefined
        ? { memory: { provider: 'managed', dreaming: { enabled: true, autoAdopt: opts.autoAdopt } } }
        : {}),
      ...(opts.model ? { runtimeOverrides: { model: opts.model } } : {})
    })
  )
  return root
}

function scriptedHost() {
  let onUpdate!: (sessionId: string, update: unknown) => void
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'eval-session-1'),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => ({ current: 'test-model', models: ['test-model'] })),
    prompt: vi.fn(async (sessionId: string) => {
      onUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read fixture',
        rawInput: { tool: 'read_fixture', arguments: { path: 'README.md' } }
      })
      onUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: { ok: true }
      })
      onUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'evaluation answer' }
      })
      return { stopReason: 'end_turn', usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4 } }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return {
    host,
    factory: (_agent: unknown, update: (sessionId: string, value: unknown) => void) => {
      onUpdate = update
      return host as any
    }
  }
}

describe('Daemon evaluation surface', () => {
  it('drives a full daemon turn and emits ordered semantic evidence without credentials', async () => {
    const collector = new EvaluationEventCollector()
    const { factory, host } = scriptedHost()
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: factory,
      evaluation: {
        observer: collector,
        runId: 'eval-run-1',
        capabilityProfile: { memory: 'configured', collaboration: 'off' }
      }
    })
    await daemon.start()

    const result = await daemon.runEvaluationTurn({
      agentId: AGENT_ID,
      conversationId: 'case-1',
      turnId: 'turn-1',
      text: 'Inspect the fixture'
    })

    expect(result).toMatchObject({
      turnId: 'turn-1',
      sessionId: 'eval-session-1',
      output: 'evaluation answer',
      stopReason: 'end_turn',
      usage: { used: 12 }
    })
    expect(host.prompt).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(collector.events().map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'turn.accepted',
          'memory.recall.requested',
          'memory.recall.completed',
          'turn.started',
          'acp.update',
          'memory.capture.requested',
          'memory.capture.completed',
          'turn.completed'
        ])
      )
    )
    const events = collector.events()
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
    expect(events.find((event) => event.type === 'turn.started')).toMatchObject({
      runId: 'eval-run-1',
      agentId: AGENT_ID,
      sessionId: 'eval-session-1',
      turnId: `${AGENT_ID}:turn-1`,
      data: { input: '[evaluation-user] Inspect the fixture', model: 'test-model' }
    })
    expect(events.find((event) => event.type === 'turn.completed')).toMatchObject({
      data: { output: 'evaluation answer', usage: { totalTokens: 12 } }
    })
    expect(
      events
        .filter((event) => event.type === 'memory.capture.requested' || event.type === 'memory.capture.completed')
        .map((event) => event.turnId)
    ).toEqual([`${AGENT_ID}:turn-1`, `${AGENT_ID}:turn-1`])

    await daemon.stop()
    collector.assertValid()
  }, 15_000)

  it('records a dream as a metered session with its original ACP activity', async () => {
    const collector = new EvaluationEventCollector()
    let onUpdate!: (sessionId: string, update: unknown) => void
    const proposal = JSON.stringify({ index: '# Memory', files: [] })
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'dream-session-1'),
      hasSession: vi.fn(() => true),
      usesMetaSystemPrompt: vi.fn(() => false),
      modelOptions: vi.fn(() => ({ current: 'test-model', models: ['test-model'] })),
      permissionModeOptions: vi.fn(() => ({ modes: ['read-only'] })),
      setSessionPermissionMode: vi.fn(async () => true),
      prompt: vi.fn(async (sessionId: string) => {
        onUpdate(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'PRIVATE MEMORY REASONING' }
        })
        onUpdate(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'dream-tool-1',
          title: 'Read PRIVATE /memory/preferences.md',
          kind: 'read',
          status: 'in_progress',
          rawInput: { path: '/memory/preferences.md', secret: 'PRIVATE TOOL INPUT' }
        })
        onUpdate(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'dream-tool-1',
          status: 'completed',
          rawOutput: { secret: 'PRIVATE TOOL OUTPUT' }
        })
        onUpdate(sessionId, {
          sessionUpdate: 'usage_update',
          used: 12,
          size: 128_000,
          cost: { amount: 0.05, currency: 'USD' }
        })
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: proposal }
        })
        return { stopReason: 'end_turn', usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4 } }
      }),
      discardSession: vi.fn(),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold({ autoAdopt: true }),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      },
      dreamOperationPolicy: 'test-only',
      evaluation: { observer: collector, runId: 'eval-run-dream' }
    })
    await daemon.start()
    const usageReports: any[] = []
    ;(daemon as any).cpClient = {
      emitEventSession: vi.fn(),
      emitSessionActivity: vi.fn(),
      emitUsageReport: vi.fn((report: unknown) => usageReports.push(report)),
      stop: vi.fn(async () => {})
    }

    const started = await (daemon as any).dreamRunner().start(AGENT_ID, { trigger: 'manual' })
    let dream
    await vi.waitFor(() => {
      dream = (daemon as any).store.getDream(AGENT_ID, started.dreamId)
      expect(dream?.status).toBe('adopted')
    })

    expect(dream).toMatchObject({
      executionSessionId: 'dream-session-1',
      runtime: 'test',
      model: 'test-model',
      stopReason: 'end_turn',
      usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4, costAmount: 0.05, costCurrency: 'USD' }
    })
    const session = (daemon as any).store.getSessionByAcpIdForAgent(AGENT_ID, 'dream-session-1')
    expect(session).toMatchObject({ platform: 'dream', channel: 'memory', thread: started.dreamId, state: 'idle' })
    expect((daemon as any).store.getUsage(session.key)).toMatchObject({
      totalTokens: 12,
      contextUsed: 12,
      contextSize: 128_000,
      costAmount: 0.05,
      costCurrency: 'USD'
    })
    const transcript = (daemon as any).store.threadTranscript('memory', started.dreamId) as Array<{
      kind: string
      text: string
      body?: string
      sender: string
      recipient?: string
    }>
    const history = transcript.map((row) => row.text).join('\n')
    const originalPrompt = host.prompt.mock.calls[0]![1][0]!.text
    expect(history).toContain('Memory dream started.')
    expect(history).toContain('Dream completed.')
    expect(transcript).toContainEqual(
      expect.objectContaining({ kind: 'text', sender: 'memory', recipient: AGENT_ID, text: originalPrompt })
    )
    expect(transcript).toContainEqual(expect.objectContaining({ kind: 'reasoning', text: 'PRIVATE MEMORY REASONING' }))
    const tool = transcript.find((row) => row.kind === 'tool')
    expect(tool).toMatchObject({ text: 'Read PRIVATE /memory/preferences.md' })
    expect(JSON.parse(tool!.body!)).toMatchObject({
      toolCallId: 'dream-tool-1',
      kind: 'read',
      status: 'completed',
      rawInput: { path: '/memory/preferences.md', secret: 'PRIVATE TOOL INPUT' },
      rawOutput: { secret: 'PRIVATE TOOL OUTPUT' }
    })
    expect(transcript).toContainEqual(expect.objectContaining({ kind: 'text', text: proposal }))
    expect(collector.events().map((event) => event.type)).toEqual([
      'memory.dream.started',
      'memory.dream.completed',
      'memory.dream.adopted'
    ])
    expect(JSON.stringify(collector.events())).not.toContain('PRIVATE')
    expect(JSON.stringify(collector.events())).not.toContain(proposal)
    expect(host.discardSession).toHaveBeenCalledWith('dream-session-1')

    const eventCount = collector.events().length
    onUpdate('dream-session-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'PRIVATE LATE DREAM UPDATE' }
    })
    expect((daemon as any).memoryExtractionQuarantines.size).toBe(1)
    expect(collector.events()).toHaveLength(eventCount)
    expect(
      (daemon as any).store
        .threadTranscript('memory', started.dreamId)
        .map((row: { text: string }) => row.text)
        .join('\n')
    ).not.toContain('PRIVATE LATE DREAM UPDATE')

    onUpdate('dream-session-1', {
      sessionUpdate: 'usage_update',
      used: 99,
      size: 256_000,
      cost: { amount: 0.09, currency: 'USD' }
    })
    expect((daemon as any).store.getUsage(session.key)).toMatchObject({
      totalTokens: 12,
      contextUsed: 99,
      contextSize: 256_000,
      costAmount: 0.09,
      costCurrency: 'USD'
    })
    expect(usageReports.at(-1)).toMatchObject({
      sessionId: 'dream-session-1',
      agentId: AGENT_ID,
      platform: 'dream',
      channel: 'memory',
      usage: {
        totalTokens: 12,
        contextUsed: 99,
        contextSize: 256_000,
        costAmount: 0.09,
        costCurrency: 'USD'
      }
    })
    expect(collector.events()).toHaveLength(eventCount)

    ;(daemon as any).recordDreamLifecycle({
      type: 'memory.dream.skill_accepted',
      dream: { ...dream, skills: [{ name: 'deploy-staging', description: 'Deploy to staging', state: 'accepted' }] },
      skillName: 'deploy-staging'
    })
    expect(collector.events().at(-1)).toMatchObject({
      type: 'memory.dream.skill_accepted',
      sessionId: 'dream-session-1',
      data: { dreamId: started.dreamId, skillName: 'deploy-staging' }
    })
    const reviewedHistory = (daemon as any).store
      .threadTranscript('memory', started.dreamId)
      .map((row: { text: string }) => row.text)
      .join('\n')
    expect(reviewedHistory).toContain('A recommended skill was accepted.')

    await daemon.stop()
    collector.assertValid()
  }, 15_000)

  it('does not attribute or price a configured model when the runtime still reports default', async () => {
    const collector = new EvaluationEventCollector()
    let onUpdate!: (sessionId: string, update: unknown) => void
    const proposal = JSON.stringify({ index: '# Memory', files: [] })
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'dream-default-model'),
      hasSession: vi.fn(() => true),
      usesMetaSystemPrompt: vi.fn(() => false),
      modelOptions: vi.fn(() => ({ current: 'default', models: ['default', 'gpt-5.6'] })),
      permissionModeOptions: vi.fn(() => ({ modes: ['read-only'] })),
      setSessionPermissionMode: vi.fn(async () => true),
      prompt: vi.fn(async (sessionId: string) => {
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: proposal }
        })
        return { stopReason: 'end_turn', usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4 } }
      }),
      discardSession: vi.fn(),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold({ runtimeCommand: 'codex-acp', model: 'gpt-5.6', autoAdopt: true }),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      },
      dreamOperationPolicy: 'test-only',
      evaluation: { observer: collector, runId: 'eval-run-dream-default-model' }
    })
    await daemon.start()

    const started = await (daemon as any).dreamRunner().start(AGENT_ID, { trigger: 'manual' })
    let dream
    await vi.waitFor(() => {
      dream = (daemon as any).store.getDream(AGENT_ID, started.dreamId)
      expect(dream?.status).toBe('adopted')
    })

    expect(dream).not.toHaveProperty('model')
    expect(dream?.usage).not.toHaveProperty('costAmount')
    const session = (daemon as any).store.getSessionByAcpIdForAgent(AGENT_ID, 'dream-default-model')
    expect((daemon as any).store.getUsage(session.key)).not.toHaveProperty('costAmount')

    await daemon.stop()
    collector.assertValid()
  }, 15_000)

  it('quarantines late Dream output when a runtime ignores cancellation', async () => {
    const collector = new EvaluationEventCollector()
    let onUpdate!: (sessionId: string, update: unknown) => void
    let promptStarted!: () => void
    let settlePrompt!: (value: { stopReason: string }) => void
    const startedPrompt = new Promise<void>((resolve) => {
      promptStarted = resolve
    })
    const promptResult = new Promise<{ stopReason: string }>((resolve) => {
      settlePrompt = resolve
    })
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'dream-ignored-cancel'),
      hasSession: vi.fn(() => true),
      usesMetaSystemPrompt: vi.fn(() => false),
      modelOptions: vi.fn(() => ({ current: 'test-model', models: ['test-model'] })),
      permissionModeOptions: vi.fn(() => ({ modes: ['read-only'] })),
      setSessionPermissionMode: vi.fn(async () => true),
      prompt: vi.fn(() => {
        promptStarted()
        return promptResult
      }),
      discardSession: vi.fn(),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      },
      dreamOperationPolicy: 'test-only',
      evaluation: { observer: collector, runId: 'eval-run-dream-ignored-cancel' }
    })
    await daemon.start()

    try {
      vi.useFakeTimers()
      const runner = (daemon as any).dreamRunner()
      const started = await runner.start(AGENT_ID, { trigger: 'manual' })
      await startedPrompt
      runner.cancel(AGENT_ID, started.dreamId)
      await vi.advanceTimersByTimeAsync(15_000)

      expect((daemon as any).memoryExtractionCollectors.size).toBe(0)
      expect((daemon as any).memoryExtractionQuarantines.size).toBe(1)
      onUpdate('dream-ignored-cancel', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'PRIVATE DREAM PROPOSAL' }
      })
      expect(JSON.stringify(collector.events())).not.toContain('PRIVATE DREAM PROPOSAL')
      expect(collector.events().some((event) => event.type === 'acp.update')).toBe(false)

      settlePrompt({ stopReason: 'end_turn' })
      await vi.advanceTimersByTimeAsync(0)
      expect((daemon as any).memoryExtractionQuarantines.size).toBe(1)
    } finally {
      settlePrompt({ stopReason: 'end_turn' })
      vi.useRealTimers()
      await daemon.stop()
    }
    expect((daemon as any).memoryExtractionQuarantines.size).toBe(0)
    collector.assertValid()
  }, 15_000)

  it('requires an observer so evaluation calls cannot silently produce no evidence', async () => {
    const { factory } = scriptedHost()
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    await expect(
      daemon.runEvaluationTurn({ agentId: AGENT_ID, conversationId: 'case-2', text: 'hello' })
    ).rejects.toThrow('evaluation observer is not enabled')
    await daemon.stop()
  }, 15_000)

  it('rejects a treatment profile without an observer before it can change daemon behavior', () => {
    const { factory } = scriptedHost()
    expect(
      () =>
        new Daemon({
          root: scaffold(),
          hostFactory: factory,
          evaluation: { capabilityProfile: { memory: 'off', collaboration: 'off' } }
        })
    ).toThrow('evaluation capability profile requires an evaluation observer')
  })

  it('publishes held organization-suggestion metadata without applying destructive CP decisions', async () => {
    const root = scaffold()
    const { factory } = scriptedHost()
    const seeder = new Daemon({ root, hostFactory: factory })
    await seeder.start()

    const dreamId = 'drm-held-organization-sync'
    const candidateId = '11111111-1111-4111-8111-111111111111'
    const dreamDir = join(root, 'agents', AGENT_ID, 'memory-dreams', dreamId)
    const bodyPath = join(dreamDir, 'organization', `${candidateId}.json`)
    const outputPath = join(dreamDir, 'output', 'MEMORY.md')
    const privateBody = '{"kind":"knowledge","content":"PRIVATE HELD BODY"}'
    mkdirSync(join(dreamDir, 'organization'), { recursive: true })
    mkdirSync(join(dreamDir, 'output'), { recursive: true })
    writeFileSync(bodyPath, privateBody)
    writeFileSync(outputPath, '# Held staging\n')
    ;(seeder as any).store.insertDream({
      dreamId,
      agentId: AGENT_ID,
      status: 'superseded',
      trigger: 'manual',
      sessionIds: ['session-1'],
      snapshotDigest: `sha256:${'b'.repeat(64)}`,
      organizationSuggestions: [
        {
          candidateId,
          kind: 'knowledge',
          operation: 'create',
          title: 'Safe metadata only',
          digest: `sha256:${'a'.repeat(64)}`,
          contentBytes: Buffer.byteLength(privateBody),
          state: 'proposed',
          sessionIds: ['session-1'],
          createdAt: '2026-08-01T00:00:00.000Z'
        }
      ],
      createdAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-08-01T00:01:00.000Z'
    })
    await seeder.stop()

    const daemon = new Daemon({ root, hostFactory: factory })
    await daemon.start()
    expect((daemon as any).registrationFeatures()).not.toContain(ORGANIZATION_SUGGESTION_REVIEW_FEATURE)
    expect((daemon as any).dreamRunnerInstance).toBeUndefined()

    const decision = { sourceAgentId: AGENT_ID, dreamId, candidateId, state: 'accepted' as const }
    const syncOrganizationSuggestions = vi.fn(async ({ suggestions }: { suggestions: unknown[] }) => ({
      decisions: suggestions.length > 0 ? [decision] : []
    }))
    ;(daemon as any).cpClient = {
      supportsServerFeature: vi.fn(() => true),
      syncOrganizationSuggestions,
      stop: vi.fn(async () => {})
    }

    await (daemon as any).syncOrganizationSuggestions()

    const runner = (daemon as any).dreamRunnerInstance
    expect(runner).toBeDefined()
    const inventory = runner.organizationSuggestionInventory()
    expect(syncOrganizationSuggestions).toHaveBeenCalledOnce()
    expect(syncOrganizationSuggestions).toHaveBeenCalledWith({ suggestions: inventory })
    expect(JSON.stringify(syncOrganizationSuggestions.mock.calls[0]![0])).not.toContain('PRIVATE HELD BODY')
    expect((daemon as any).store.getDream(AGENT_ID, dreamId).organizationSuggestions[0].state).toBe('proposed')
    expect(readFileSync(bodyPath, 'utf8')).toBe(privateBody)
    expect(readFileSync(outputPath, 'utf8')).toBe('# Held staging\n')

    await daemon.stop()

    const allowed = new Daemon({ root, hostFactory: factory, dreamOperationPolicy: 'test-only' })
    await allowed.start()
    expect((allowed as any).registrationFeatures()).toContain(ORGANIZATION_SUGGESTION_REVIEW_FEATURE)
    const allowedRunner = (allowed as any).dreamRunner()
    const allowedReview = vi.spyOn(allowedRunner, 'organizationSuggestionReview')
    ;(allowed as any).cpClient = {
      supportsServerFeature: vi.fn(() => true),
      syncOrganizationSuggestions,
      stop: vi.fn(async () => {})
    }

    await (allowed as any).syncOrganizationSuggestions()
    await vi.waitFor(() => expect(syncOrganizationSuggestions).toHaveBeenCalledTimes(3))

    expect(allowedReview).toHaveBeenCalledOnce()
    expect(allowedReview).toHaveBeenCalledWith(decision)
    expect((allowed as any).store.getDream(AGENT_ID, dreamId).organizationSuggestions[0].state).toBe('accepted')
    expect(() => readFileSync(bodyPath, 'utf8')).toThrow()
    await allowed.stop()
  }, 15_000)

  it('omits memory recall and capture evidence when the treatment is off', async () => {
    const collector = new EvaluationEventCollector()
    const { factory } = scriptedHost()
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: factory,
      evaluation: {
        observer: collector,
        runId: 'eval-run-memory-off',
        capabilityProfile: { memory: 'off', collaboration: 'off' }
      }
    })
    await daemon.start()

    await daemon.runEvaluationTurn({
      agentId: AGENT_ID,
      conversationId: 'case-memory-off',
      turnId: 'turn-memory-off',
      text: 'Do not use AgentConnect memory'
    })
    await daemon.waitForEvaluationIdle()

    expect(collector.events().some((event) => event.type.startsWith('memory.'))).toBe(false)
    expect(collector.events().map((event) => event.type)).toEqual(
      expect.arrayContaining(['turn.accepted', 'turn.started', 'turn.completed'])
    )
    await daemon.stop()
    collector.assertValid()
  }, 15_000)

  it('rejects peer delivery at the execution boundary when collaboration is off', async () => {
    const collector = new EvaluationEventCollector()
    const { factory } = scriptedHost()
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: factory,
      evaluation: {
        observer: collector,
        runId: 'eval-run-collaboration-off',
        capabilityProfile: { memory: 'off', collaboration: 'off' }
      }
    })
    await daemon.start()

    const result = await (daemon as any).messageAgent({
      callerAgentId: AGENT_ID,
      platform: 'webchat',
      callerChannel: 'caller-channel',
      toAgentId: 'peer-agent',
      text: 'must not be delivered',
      channel: 'target-channel'
    })

    expect(result).toMatchObject({ delivered: false, reason: 'capability_disabled' })
    expect(collector.events().find((event) => event.type === 'collaboration.delivery.rejected')).toMatchObject({
      agentId: AGENT_ID,
      data: { toAgentId: 'peer-agent', reason: 'capability_disabled' }
    })
    await daemon.stop()
    collector.assertValid()
  }, 15_000)
})
