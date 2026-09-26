import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DECISION_MODEL_SELECTION_V1_FEATURE,
  type DecisionEvaluation,
  type ExecutorCandidate,
  type ExecutorPrepareReq,
  type ExecutorPrepareResult,
  type RdMsgHook,
  type RuntimeStrategyEntries
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import * as codeHostTurnFinal from '../src/codehost/turn-final.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import type { ExecutorPlane } from '../src/execution/executor-plane.js'
import { fakeCpClient } from './webchat-continuation-fixture.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { buildHookMessage } from '../src/messages/hook-message.js'
import type { DecisionEvaluator } from '../src/decisions/evaluator.js'
import { WAIT } from './wait-support.js'

const agentId = 'example-agent'
const decisionId = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []
const daemons: Daemon[] = []
const pullHook = (): RdMsgHook => ({
  source: 'hook',
  agentId,
  hookId: 'example-hook',
  deliveryKey: 'delivery-1',
  msgId: 'example-hook:delivery-1',
  sessionKey: 'example-org/example-repo#42',
  firedAt: '2026-01-01T00:00:00.000Z',
  event: 'issue_comment:created',
  github: {
    repoId: '100',
    repoFullName: 'example-org/example-repo',
    sourceInstallationId: '200',
    subjectKind: 'pull_request',
    pullNumber: 42
  },
  context: {
    source: 'github',
    event: 'issue_comment',
    action: 'created',
    number: 42,
    repo: 'example-org/example-repo',
    senderLogin: 'reviewer',
    bodyExcerpt: 'Review the login change',
    subject: { body: 'Fix login' }
  }
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function scaffold(chat = false) {
  const root = mkdtempSync(join(tmpdir(), 'ac-model-decision-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { test: { command: 'node', args: ['unused'] }, alternative: { command: 'node', args: ['unused'] } }
    })
  )
  const dir = join(root, 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: agentId,
      name: 'Example agent',
      runtime: 'test',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: chat
        ? [
            {
              id: 'int-model',
              platform: 'slack',
              core: { bindRules: [{ match: { kind: 'mention' } }] },
              config: { botToken: 'xoxb', appToken: 'xapp' }
            }
          ]
        : [],
      memory: { provider: 'none' },
      allowRuntimeChangesInChat: true,
      runtimeOverrides: { model: 'model-standard' },
      modelSelection: {
        decisionId,
        rules: [{ when: { type: 'boolean', values: [true] }, runtime: 'test', model: 'model-capable' }]
      }
    })
  )
  return root
}

async function start(root: string) {
  const models = new Map<string, string>()
  type Settings = { effort?: string; permissionMode: string; fastMode?: boolean }
  const settings = new Map<string, Settings>()
  const promptSettings: Settings[] = []
  const prompted: string[] = []
  const executionRuntimes: string[] = []
  const started: Array<{ runtime: string; model?: string }> = []
  const daemon = new Daemon({
    root,
    slackAppFactory: fakeSlackAppFactory(),
    evaluation: { observer: new EvaluationEventCollector(), runId: 'model-selection' },
    hostFactory: (agent, onUpdate) =>
      ({
        start: async () => {
          started.push({ runtime: agent.runtime, model: agent.runtimeOverrides?.model })
        },
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => {
          const id = `acp-${models.size}`
          models.set(id, 'model-standard')
          settings.set(id, {
            effort: agent.reasoningEffort,
            permissionMode: agent.permissionMode,
            fastMode: agent.fastMode
          })
          return id
        },
        loadSession: async (id: string) => {
          models.set(id, 'model-standard')
          settings.set(id, {
            effort: agent.reasoningEffort,
            permissionMode: agent.permissionMode,
            fastMode: agent.fastMode
          })
          return true
        },
        hasSession: (id: string) => models.has(id),
        modelOptions: (id: string) => ({
          current: models.get(id),
          models: ['model-standard', 'model-capable', 'model-manual']
        }),
        setSessionModel: async (id: string, model: string) => {
          models.set(id, model)
          return true
        },
        setSessionEffort: async (id: string, effort: string) => {
          settings.get(id)!.effort = effort
          return true
        },
        setSessionPermissionMode: async (id: string, mode: string) => {
          settings.get(id)!.permissionMode = mode
          return true
        },
        setSessionFastMode: async (id: string, fast: boolean) => {
          settings.get(id)!.fastMode = fast
          return true
        },
        prompt: async (id: string) => {
          prompted.push(models.get(id)!)
          promptSettings.push({ ...settings.get(id)! })
          executionRuntimes.push(agent.runtime)
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } })
          return { stopReason: 'end_turn' }
        }
      }) as any
  })
  daemons.push(daemon)
  await daemon.start()
  const internal = daemon as any
  if (internal.connByIntegration.has('int-model')) {
    internal.connByIntegration.set('int-model', {
      workspaceId: () => 'T_FAKE_TEAM',
      setStatus: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
      postMessage: vi.fn(async () => 'reply-1'),
      postBlocks: vi.fn(async () => 'status-bar'),
      updateBlocks: vi.fn(async () => {})
    })
  }
  internal.cpClient = {
    ...fakeCpClient(),
    emitEventSession: vi.fn(),
    emitIntegrationChannels: vi.fn(),
    supportsServerFeature: (feature: string) => feature === DECISION_MODEL_SELECTION_V1_FEATURE,
    decisionGet: vi.fn(async () => ({
      decision: {
        id: decisionId,
        name: 'Complexity',
        providerId: 'typesafe',
        model: 'jev-latest',
        question: {
          type: 'boolean',
          instructions: 'Is currentMessage.text complex?',
          criteria: { true: 'Complex', false: 'Simple' }
        }
      }
    }))
  }
  vi.spyOn(internal.runtimeFacts, 'canSwitchModels').mockReturnValue(true)
  vi.spyOn(internal.runtimeFacts, 'profileFor').mockReturnValue({
    models: ['model-standard', 'model-capable', 'model-manual']
  })
  const evaluate = vi.spyOn(internal.decisionEvaluator as DecisionEvaluator, 'evaluate').mockResolvedValue({
    status: 'answered',
    model: 'jev-latest',
    usage: { inputTokens: 1, outputTokens: 1 },
    answer: { type: 'boolean', value: true, probability: 0.9 }
  } satisfies DecisionEvaluation)
  const turn = async (conversationId: string, text = 'Opening request') => {
    await daemon.runEvaluationTurn({ agentId, conversationId, text })
    await daemon.waitForEvaluationIdle()
  }
  return { daemon, internal, prompted, promptSettings, executionRuntimes, started, evaluate, turn }
}

describe('session-pinned Decision model', () => {
  it('shares one code-host snapshot between model and repository selection before opening a runtime', async () => {
    const { internal, evaluate, started } = await start(scaffold())
    const read = vi.spyOn(codeHostTurnFinal, 'codeHostPullRequestContext').mockResolvedValue({
      description: 'Fix login',
      commitMessages: ['Handle expired sessions'],
      diff: '-return cached\n+return refresh()',
      reasons: []
    })
    const hook = pullHook()
    const msg = buildHookMessage(hook, 'trace-1')
    const channel = transcriptChannelKey(msg.channel, msg.transportScope)
    await internal.store.recordObservations(agentId, channel, [
      { ts: 'prior', thread: msg.thread, sender: 'author', text: 'The retry still fails' },
      { ts: msg.transcriptTs, thread: msg.thread, sender: msg.sender.id, text: msg.text }
    ])
    const run = {
      key: 'pr-session',
      plan: {},
      entry: {
        agentId,
        hookContext: hook,
        initAbort: new AbortController(),
        msg
      }
    }
    await internal.selectSessionModel(run, undefined)
    expect(read).toHaveBeenCalledOnce()
    expect(evaluate.mock.calls[0]![0].state).toMatchObject({
      source: 'github',
      subject: { kind: 'pull_request', number: 42, body: 'Fix login' },
      currentMessage: { text: 'Review the login change' },
      history: [{ text: 'The retry still fails' }],
      pullRequest: { commitMessages: 'Handle expired sessions', diff: '-return cached\n+return refresh()' }
    })
    expect(started).toEqual([])
    const selected = internal.sessionRuntimes.get(run.key)
    expect(selected.model).toBe('model-capable')
    await internal.selectSessionModel(run, { decisionModel: JSON.stringify(selected) })
    expect(read).toHaveBeenCalledOnce()
    expect(evaluate).toHaveBeenCalledOnce()
    const agent = internal.agents.get(agentId)
    agent.workspace.additionalRepos = [
      { repoFullName: 'example-org/related-repo', repoId: '300', materialize: 'decision' }
    ]
    agent.repositorySelector = { providerId: 'typesafe', model: 'jev-latest' }
    evaluate.mockResolvedValueOnce({
      status: 'answered',
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 1 },
      answer: { type: 'choice', value: 'r1', confidence: 0.9, probabilities: { r1: 0.9, none: 0.1 } }
    })
    await internal.selectSessionRepositories(run, undefined)
    expect(evaluate.mock.calls[1]![0].state).toEqual({ ...evaluate.mock.calls[0]![0].state, workspace: {} })
    expect(read).toHaveBeenCalledOnce()
  })

  it('selects from observed chat history before the opening message, scoped to its bot and conversation', async () => {
    const { daemon, internal, evaluate, prompted } = await start(scaffold(true))
    const message = (n: number, text: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
      msgId: `slack:C1:1720000000.00000${n}`,
      traceId: `trace-${n}`,
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: `1720000000.00000${n}`,
      sender: { id: 'U1', isBot: false },
      text,
      mentionedBots: [],
      isDm: false,
      ...over
    })
    const route = (msg: NormalizedMessage) => internal.onInboundOutcome(msg, ['int-model'])
    expect(await route(message(1, 'The migration keeps failing'))).toMatchObject({ kind: 'rejected' })
    expect(await route(message(2, 'It also breaks login', { sender: { id: 'U2', isBot: false } }))).toMatchObject({
      kind: 'rejected'
    })
    await route(message(3, 'Unrelated conversation', { channel: 'C2' }))
    await internal.store.recordObservations(agentId, transcriptChannelKey('C1', 'other-bot'), [
      { ts: '1720000000.000004', thread: null, sender: 'U3', text: 'Another bot conversation' }
    ])
    expect(evaluate).not.toHaveBeenCalled()
    expect(await internal.store.listSessions(agentId)).toHaveLength(0)

    const definition = await internal.cpClient.decisionGet()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => (release = resolve))
    internal.cpClient.decisionGet.mockClear().mockImplementationOnce(async () => {
      await waiting
      return definition
    })
    const opening = message(5, 'Can you fix that?', {
      mentionedBots: ['U_FAKE_BOT'],
      quoted: { sender: 'U2', text: 'It also breaks login' }
    })
    const dispatched = await route(opening)
    await vi.waitFor(() => expect(internal.cpClient.decisionGet).toHaveBeenCalledOnce(), WAIT)
    await route(message(6, 'A later message must not affect the choice'))
    release()
    expect(await dispatched.handle.completion).toMatchObject({ status: 'completed' })
    await daemon.waitForEvaluationIdle()
    expect(evaluate).toHaveBeenCalledOnce()
    const state = evaluate.mock.calls[0]![0].state
    expect(state).toMatchObject({
      source: 'chat',
      currentMessage: {
        id: '1720000000.000005',
        sender: { id: 'U1' },
        text: 'Can you fix that?',
        quote: { sender: 'U2', text: 'It also breaks login' }
      },
      addressing: { mentions: ['U_FAKE_BOT'], target: { agentId, via: 'mention' } },
      context: { partial: false }
    })
    expect(state.history).toEqual([
      expect.objectContaining({ sender: { id: 'U1' }, text: 'The migration keeps failing' }),
      expect.objectContaining({ sender: { id: 'U2' }, text: 'It also breaks login' })
    ])
    const followup = await route(message(7, 'Thanks', { thread: '1720000000.000005' }))
    expect(await followup.handle.completion).toMatchObject({ status: 'completed' })
    await daemon.waitForEvaluationIdle()
    expect(evaluate).toHaveBeenCalledOnce()
    expect(prompted).toEqual(['model-capable', 'model-capable'])
    const oversized = await route(message(8, 'A large error log\n'.repeat(3000), { mentionedBots: ['U_FAKE_BOT'] }))
    expect(await oversized.handle.completion).toMatchObject({ status: 'completed' })
    await daemon.waitForEvaluationIdle()
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(evaluate.mock.calls[1]![0].state).toMatchObject({ history: [], truncated: true })
    expect(prompted.at(-1)).toBe('model-capable')
  })

  it.each([true, false])('marks independent relay history as partial (Decision routed=%s)', async (routed) => {
    const { daemon, internal, evaluate, prompted } = await start(scaffold(true))
    const { decision } = await internal.cpClient.decisionGet()
    if (routed)
      internal.agents.get(agentId).integrations[0].core = {
        bindRules: [{ channel: 'C1', match: { kind: 'decision' } }],
        decisions: {
          bindings: [{ channel: 'C1', consumer: { type: 'shared_bot_routing' }, enabled: true }],
          definitions: []
        }
      }
    const ack = await internal.handleRelayIm({
      source: 'im',
      agentId,
      integrationId: 'int-model',
      sessionKey: 'C1/1720000000.000002',
      msgId: 'forward-1',
      chatId: 'C1',
      payload: {
        msgId: 'slack:C1:1720000000.000002',
        traceId: 'trace-forward',
        source: 'user',
        platform: 'slack',
        channel: 'C1',
        thread: '1720000000.000002',
        sender: { id: 'U1', isBot: false },
        text: 'Can you fix that?',
        mentionedBots: [],
        isDm: false
      },
      ...(routed
        ? {
            trustedRouteSelection: {
              selectionId: '2:router:example-bot',
              hostSeq: 2,
              decisionId,
              question: decision.question,
              requestedModel: decision.model,
              result: { status: 'not_evaluated', reason: 'all_participants' },
              effect: 'participant',
              constrained: false,
              targetAgentIds: [agentId],
              evaluatedMessageId: 'slack:C1:1720000000.000002',
              partial: { partial: false, reasons: [], omittedMessages: 0 },
              hostDaemonId: '44444444-4444-4444-8444-444444444444'
            },
            backfill: [
              { ts: '1720000000.000001', thread: '1720000000.000001', sender: 'U2', text: 'The migration broke login' }
            ]
          }
        : {})
    })
    expect(ack).toMatchObject({ accepted: true, ...(routed ? { routeAdmission: 'admitted' } : {}) })
    await vi.waitFor(() => expect(prompted).toEqual(['model-capable']), WAIT)
    await daemon.waitForEvaluationIdle()
    expect(evaluate).toHaveBeenCalledOnce()
    expect(evaluate.mock.calls[0]![0].state).toMatchObject({
      source: 'chat',
      currentMessage: { text: 'Can you fix that?' },
      history: routed ? [{ text: 'The migration broke login', sender: { id: 'U2' } }] : [],
      context: { partial: true, reasons: ['forwarded_history'] }
    })
  })

  it.each([true, false])('honors a manual runtime pair only with the chat grant (allowed=%s)', async (allowed) => {
    const { internal, prompted, executionRuntimes, evaluate } = await start(scaffold())
    internal.agents.get(agentId).allowRuntimeChangesInChat = allowed
    const done = vi.fn()
    await internal.webchatTransport.dispatchWebchatTurn(
      agentId,
      'manual',
      'Opening request',
      { id: 'example-user' },
      { output: vi.fn(), done },
      undefined,
      undefined,
      { runtime: 'alternative', model: 'model-manual' }
    )
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(executionRuntimes).toEqual([allowed ? 'alternative' : 'test'])
    expect(prompted).toEqual([allowed ? 'model-manual' : 'model-capable'])
    expect(evaluate).toHaveBeenCalledTimes(allowed ? 0 : 1)
  })

  it('isolates selected runtimes across conversations and retains the pair after configuration changes', async () => {
    const { internal, executionRuntimes, started, evaluate, turn } = await start(scaffold())
    internal.agents.get(agentId).modelSelection.rules[0].runtime = 'alternative'
    await turn('first')
    internal.agents.get(agentId).modelSelection = undefined
    await turn('second')
    await turn('first')
    expect(executionRuntimes).toEqual(['alternative', 'test', 'alternative'])
    expect(started).toContainEqual({ runtime: 'alternative', model: 'model-capable' })
    expect(internal.agents.get(agentId).runtime).toBe('test')
    expect(evaluate).toHaveBeenCalledOnce()
    const selected = (await internal.store.listSessions(agentId)).find(
      (row: { decisionModel?: string }) => row.decisionModel
    )
    expect(JSON.parse(selected.decisionModel)).toEqual({
      runtime: 'alternative',
      model: 'model-capable',
      effort: '',
      permissionMode: 'default',
      fastMode: false
    })
    expect((await internal.statusInfoFrom(agentId, selected.key, selected.acpSessionId)).runtime).toBe('alternative')
  })

  it('prepares and relocates executors with the session runtime after the binding changes', async () => {
    const { internal, turn } = await start(scaffold())
    internal.agents.get(agentId).modelSelection.rules[0].runtime = 'alternative'
    await turn('routed')
    const row = (await internal.store.listSessions(agentId))[0]
    const executorId = '44444444-4444-4444-8444-444444444444'
    const replacementId = '55555555-5555-4555-8555-555555555555'
    const endpoint = { host: '192.0.2.10', port: 7100 }
    const prepare = vi.fn(async (request: ExecutorPrepareReq): Promise<ExecutorPrepareResult> => ({
      status: 'ready',
      generation: 1,
      endpoint,
      psk: Buffer.alloc(32, 7).toString('base64url'),
      runtimeRoot: '/home/agent/runtime',
      liveCount: 1,
      runtimeLaunch: { command: request.runtime!, args: [] }
    }))
    internal.cpClient.connected = () => true
    internal.cpClient.executorPrepare = prepare
    internal.cpClient.executorCandidates = async () => ({
      candidates: [
        {
          daemonId: replacementId,
          endpoint,
          strategies: { host: { available: true } },
          hostedSessions: 0,
          runtimes: [{ runtime: 'alternative', authRequired: false }]
        }
      ]
    })
    internal.sessionIsolation.set(row.key, 'session')
    vi.spyOn(internal, 'hostedSessionCount').mockResolvedValue(1)
    const plane: ExecutorPlane = internal.executorPlane
    const choices = [{ daemonId: executorId, strategy: 'host' }]
    const first = await plane.prepareAt(agentId, row.key, choices)
    expect(first).toHaveProperty('placed.executorDaemonId', executorId)
    expect(plane.runtimeDefFor(row.key, internal.runtimes.test).command).toBe('alternative')
    if (!('placed' in first)) throw new Error('Expected a prepared executor')
    await plane.suspendIdle(first.placed.subject)
    internal.agents.get(agentId).modelSelection = undefined
    prepare.mockResolvedValueOnce({ status: 'offline', lastSeenAt: null })
    const resumed = await plane.prepareAt(agentId, row.key, choices)
    expect(resumed).toHaveProperty('placed.executorDaemonId', replacementId)
    expect(prepare.mock.calls.map(([request]) => request.runtime)).toEqual([
      'alternative',
      'alternative',
      'alternative'
    ])
    expect(plane.runtimeDefFor(row.key, internal.runtimes.test).command).toBe('alternative')
    expect(internal.agents.get(agentId).runtime).toBe('test')
  })

  it('evaluates once, preserves the choice after config changes and manual overrides, and evaluates new sessions', async () => {
    const { internal, prompted, evaluate, turn } = await start(scaffold())
    await turn('first')
    await turn('first', 'An unrelated follow-up')
    expect(evaluate).toHaveBeenCalledOnce()
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          source: 'chat',
          currentMessage: { text: 'Opening request' },
          history: [],
          truncated: false
        }
      }),
      expect.any(AbortSignal)
    )
    expect(prompted).toEqual(['model-capable', 'model-capable'])
    const row = (await internal.store.listSessions(agentId))[0]
    expect(JSON.parse(row.decisionModel)).toEqual({
      runtime: 'test',
      model: 'model-capable',
      effort: '',
      permissionMode: 'default',
      fastMode: false
    })
    internal.agents.get(agentId).modelSelection.rules[0].model = 'model-standard'
    await turn('first')
    expect(prompted.at(-1)).toBe('model-capable')
    await internal.store.setModelOverride(row.key, 'model-manual')
    await turn('first')
    expect(prompted.at(-1)).toBe('model-manual')
    await internal.store.clearRuntimeConfigOverrides(agentId)
    await turn('first')
    expect(prompted.at(-1)).toBe('model-capable')
    await turn('second')
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(prompted.at(-1)).toBe('model-standard')
  })

  it.skipIf(process.platform === 'win32').each([true, false])(
    'persists the runtime and run settings across restart without retrying Jev (fallback=%s)',
    async (fallback) => {
      const root = scaffold()
      const first = await start(root)
      const configured = first.internal.agents.get(agentId)
      Object.assign(configured, { reasoningEffort: 'low', permissionMode: 'plan', fastMode: true })
      Object.assign(configured.modelSelection.rules[0], {
        runtime: 'alternative',
        effort: 'high',
        permissionMode: 'default',
        fastMode: false
      })
      const expected = fallback
        ? { effort: 'low', permissionMode: 'plan', fastMode: true }
        : { effort: 'high', permissionMode: 'default', fastMode: false }
      if (fallback) first.evaluate.mockResolvedValue({ status: 'unavailable', reason: 'timeout' })
      await first.turn('first')
      expect(first.prompted).toEqual([fallback ? 'model-standard' : 'model-capable'])
      expect(first.promptSettings).toEqual([expected])
      expect(first.internal.cpClient.emitEventSession).toHaveBeenLastCalledWith(expect.objectContaining(expected))
      Object.assign(configured, { reasoningEffort: 'medium', permissionMode: 'default', fastMode: false })
      configured.modelSelection = undefined
      await first.turn('first', 'A follow-up')
      expect(first.promptSettings.at(-1)).toEqual(expected)
      expect(first.internal.cpClient.emitEventSession).toHaveBeenLastCalledWith(expect.objectContaining(expected))
      await first.daemon.stop()
      daemons.splice(daemons.indexOf(first.daemon), 1)
      const second = await start(root)
      await second.turn('first', 'Another request')
      expect(second.evaluate).not.toHaveBeenCalled()
      expect(second.prompted).toEqual([fallback ? 'model-standard' : 'model-capable'])
      expect(second.executionRuntimes).toEqual([fallback ? 'test' : 'alternative'])
      expect(second.promptSettings).toEqual([expected])
      expect(second.internal.cpClient.emitEventSession).toHaveBeenLastCalledWith(expect.objectContaining(expected))
      const row = (await second.internal.store.listSessions(agentId))[0]
      await second.internal.store.setEffortOverride(row.key, 'medium')
      await second.internal.store.setPermissionModeOverride(row.key, 'ask')
      await second.internal.store.setFastModeOverride(row.key, !expected.fastMode)
      await second.turn('first', 'Manual settings')
      const manualSettings = {
        effort: 'medium',
        permissionMode: 'ask',
        fastMode: !expected.fastMode
      }
      expect(second.promptSettings.at(-1)).toEqual(manualSettings)
      expect(second.internal.cpClient.emitEventSession).toHaveBeenLastCalledWith(
        expect.objectContaining(manualSettings)
      )
      second.internal.agents.get(agentId).allowRuntimeChangesInChat = false
      await second.turn('first', 'Configured settings')
      expect(second.promptSettings.at(-1)).toEqual(expected)
      expect(second.internal.cpClient.emitEventSession).toHaveBeenLastCalledWith(expect.objectContaining(expected))
    }
  )
})

it('judges a resumed session’s targets in the strategy its verdict recorded, loaded before model selection', async () => {
  const root = scaffold()
  const first = await start(root)
  await first.turn('first')
  const key = (await first.internal.store.listSessions(agentId))[0].key
  expect(await first.internal.store.getSessionExecutor(key)).toMatchObject({ birthStrategy: 'host' })
  await first.daemon.stop()
  daemons.splice(daemons.indexOf(first.daemon), 1)

  const path = join(root, 'agents', agentId, 'agent.json')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), execution: 'srt' }))
  const second = await start(root)
  const agent = second.internal.agents.get(agentId)
  expect(second.internal.agentStrategy(agent)).toBe('srt')
  const seen: string[] = []
  const select = second.internal.selectSessionModel.bind(second.internal)
  vi.spyOn(second.internal, 'selectSessionModel').mockImplementation(async (...args: unknown[]) => {
    seen.push(second.internal.sessionStrategy(agent, key))
    return await select(...args)
  })
  await second.turn('first', 'A follow-up after the restart')
  expect(seen).toEqual(['host'])
})

describe('a target judged where the session could land (session-executors.md §5)', () => {
  const executorId = '44444444-4444-4444-8444-444444444444'
  const key = 'birth-session'
  const catalog = ['model-standard', 'model-capable', 'model-manual']
  const live = (models = catalog) => ({ available: true, models, modelsSource: 'probed' as const })
  const missing = { available: false, unavailableReason: 'this runtime is not installed on this host' }

  /** A session-isolated birth on a group: `alternative` as this holder reports it, and one candidate's runtimes. */
  async function birth(opts: {
    holder: RuntimeStrategyEntries
    candidate?: ExecutorCandidate['runtimes']
    execution?: string
    holderHosted?: number
    manual?: { runtime: string; model: string }
  }) {
    const { internal, evaluate } = await start(scaffold())
    const agent = internal.agents.get(agentId)
    agent.modelSelection.rules[0].runtime = 'alternative'
    if (opts.execution) agent.execution = opts.execution
    vi.spyOn(internal.runtimeFacts, 'profileFor').mockImplementation((runtime: unknown) => ({
      runtime,
      models: catalog,
      strategies: runtime === 'alternative' ? opts.holder : { host: live(), microsandbox: live() }
    }))
    const executorCandidates = vi.fn(async () => ({
      candidates: opts.candidate
        ? [
            {
              daemonId: executorId,
              endpoint: { host: '192.0.2.10', port: 7100 },
              strategies: { host: { available: true }, microsandbox: { available: true } },
              capacity: 32,
              hostedSessions: 0,
              runtimes: opts.candidate
            }
          ]
        : []
    }))
    Object.assign(internal.cpClient, {
      connected: () => true,
      memberSet: () => ({ setId: 'example-set', name: 'Example group' }),
      executorCandidates
    })
    vi.spyOn(codeHostTurnFinal, 'codeHostPullRequestContext').mockResolvedValue({
      description: 'Fix login',
      commitMessages: [],
      diff: '',
      reasons: []
    })
    vi.spyOn(internal, 'hostedSessionCount').mockResolvedValue(opts.holderHosted ?? 0)
    const prepareAt = vi
      .spyOn(internal.executorPlane as ExecutorPlane, 'prepareAt')
      .mockResolvedValue({ refused: 'full' })
    internal.sessionIsolation.set(key, 'session')
    const run = {
      key,
      plan: {},
      entry: {
        agentId,
        hookContext: pullHook(),
        initAbort: new AbortController(),
        msg: buildHookMessage(pullHook(), 'trace-birth'),
        ...(opts.manual ? { webchat: { runtime: opts.manual } } : {})
      }
    }
    // The two calls `openSession` makes, sharing one answer as it does.
    const candidates = internal.birthCandidates(agentId, key)
    await internal.selectSessionModel(run, undefined, candidates)
    const selected = internal.sessionRuntimes.get(key)
    await internal.placeSessionOnExecutor(internal.sessionAgent(agentId, key), key, candidates)
    return { internal, evaluate, selected, executorCandidates, prepareAt }
  }

  it.each([
    ['a live list that names the model', live()],
    [
      'a cached list, which stays permissive',
      { available: true, models: ['model-other'], modelsSource: 'cached' as const }
    ],
    ['no list yet, which stays permissive', { available: true }]
  ])('accepts a runtime only a candidate runs, from %s, and places the session there on one ask', async (_, entry) => {
    const { selected, executorCandidates, prepareAt, evaluate } = await birth({
      holder: { host: missing },
      candidate: [{ runtime: 'alternative', authRequired: false, strategies: { host: entry } }]
    })
    expect(evaluate).toHaveBeenCalledOnce()
    expect(selected).toMatchObject({ runtime: 'alternative', model: 'model-capable' })
    expect(prepareAt).toHaveBeenCalledWith(agentId, key, [{ daemonId: executorId, strategy: 'host' }])
    expect(executorCandidates).toHaveBeenCalledOnce()
  })

  it('accepts a manual pair only a candidate runs', async () => {
    const { selected, executorCandidates } = await birth({
      holder: { host: missing },
      candidate: [{ runtime: 'alternative', authRequired: false, strategies: { host: live() } }],
      manual: { runtime: 'alternative', model: 'model-manual' }
    })
    expect(selected).toEqual({ runtime: 'alternative', model: 'model-manual' })
    expect(executorCandidates).toHaveBeenCalledOnce()
  })

  it('keeps the session off a lighter candidate whose catalog lacks the model the holder has', async () => {
    const { internal, selected, prepareAt } = await birth({
      holder: { host: live() },
      candidate: [{ runtime: 'alternative', authRequired: false, strategies: { host: live(['model-standard']) } }],
      holderHosted: 9
    })
    expect(selected).toMatchObject({ runtime: 'alternative', model: 'model-capable' })
    expect(prepareAt).not.toHaveBeenCalled()
    expect(internal.sessionExecutorVerdicts.get(key)).toEqual({
      stayedHomeReason: 'no_candidate',
      birthStrategy: 'host'
    })
  })

  it.each([
    [
      'falls back from',
      { available: false, unavailableReason: 'the microsandbox image does not provide this runtime' },
      'test'
    ],
    ['keeps', live(), 'alternative']
  ])('%s a runtime by what the microsandbox image offers, not the host install', async (_, image, runtime) => {
    const { selected } = await birth({ holder: { host: live(), microsandbox: image }, execution: 'microsandbox' })
    expect(selected).toMatchObject({ runtime })
  })

  it('never lets a Decision choose the strategy: a target only another strategy runs falls back, and the session keeps the agent’s', async () => {
    const { selected, prepareAt, executorCandidates } = await birth({
      // Both the holder and the candidate run the target in a VM, and neither on the host.
      holder: { host: missing, microsandbox: live() },
      candidate: [
        { runtime: 'alternative', authRequired: false, strategies: { host: missing, microsandbox: live() } },
        { runtime: 'test', authRequired: false, strategies: { host: live() } }
      ],
      execution: 'host',
      holderHosted: 9
    })
    expect(selected).toMatchObject({ runtime: 'test', model: 'model-standard' })
    expect(prepareAt).toHaveBeenCalledWith(agentId, key, [{ daemonId: executorId, strategy: 'host' }])
    expect(executorCandidates).toHaveBeenCalledOnce()
  })
})
