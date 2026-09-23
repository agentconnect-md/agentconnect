import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECISION_MODEL_SELECTION_V1_FEATURE, type DecisionEvaluation } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import { fakeCpClient } from './webchat-continuation-fixture.js'

const agentId = 'example-agent'
const decisionId = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function scaffold() {
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
      integrations: [],
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
  const prompted: string[] = []
  const executionRuntimes: string[] = []
  const started: Array<{ runtime: string; model?: string }> = []
  const daemon = new Daemon({
    root,
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
          return id
        },
        loadSession: async (id: string) => {
          models.set(id, 'model-standard')
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
        prompt: async (id: string) => {
          prompted.push(models.get(id)!)
          executionRuntimes.push(agent.runtime)
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } })
          return { stopReason: 'end_turn' }
        }
      }) as any
  })
  daemons.push(daemon)
  await daemon.start()
  const internal = daemon as any
  internal.cpClient = {
    ...fakeCpClient(),
    emitEventSession: vi.fn(),
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
  const evaluate = vi.spyOn(internal.decisionEvaluator, 'evaluate').mockResolvedValue({
    status: 'answered',
    model: 'jev-latest',
    usage: { inputTokens: 1, outputTokens: 1 },
    answer: { type: 'boolean', value: true, probability: 0.9 }
  } satisfies DecisionEvaluation)
  const turn = async (conversationId: string, text = 'Opening request') => {
    await daemon.runEvaluationTurn({ agentId, conversationId, text })
    await daemon.waitForEvaluationIdle()
  }
  return { daemon, internal, prompted, executionRuntimes, started, evaluate, turn }
}

describe('session-pinned Decision model', () => {
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
    expect(JSON.parse(selected.decisionModel)).toEqual({ runtime: 'alternative', model: 'model-capable' })
    expect((await internal.statusInfoFrom(agentId, selected.key, selected.acpSessionId)).runtime).toBe('alternative')
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
    expect(JSON.parse(row.decisionModel)).toEqual({ runtime: 'test', model: 'model-capable' })
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
    'persists the runtime pair across restart without retrying Jev (fallback=%s)',
    async (fallback) => {
      const root = scaffold()
      const first = await start(root)
      first.internal.agents.get(agentId).modelSelection.rules[0].runtime = 'alternative'
      if (fallback) first.evaluate.mockResolvedValue({ status: 'unavailable', reason: 'timeout' })
      await first.turn('first')
      expect(first.prompted).toEqual([fallback ? 'model-standard' : 'model-capable'])
      await first.daemon.stop()
      daemons.splice(daemons.indexOf(first.daemon), 1)
      const second = await start(root)
      await second.turn('first', 'Another request')
      expect(second.evaluate).not.toHaveBeenCalled()
      expect(second.prompted).toEqual([fallback ? 'model-standard' : 'model-capable'])
      expect(second.executionRuntimes).toEqual([fallback ? 'test' : 'alternative'])
    }
  )
})
