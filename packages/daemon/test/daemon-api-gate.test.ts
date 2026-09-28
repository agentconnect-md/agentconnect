// An API turn passes its agent's Decision gate before admission; a console turn on the same agent never does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionEvaluation } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import type { DecisionEvaluator } from '../src/decisions/evaluator.js'
import { fakeCpClient } from './webchat-continuation-fixture.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const agentId = 'example-agent'
const decisionId = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []
const daemons: Daemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-api-gate-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: { test: { command: 'node', args: [] } } })
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
      apiGates: { 'ai-sdk-ui': { type: 'gate', decisionId, when: { type: 'boolean', values: [true] } } }
    })
  )
  return root
}

async function start() {
  const prompted: string[] = []
  const daemon = new Daemon({
    root: scaffold(),
    slackAppFactory: fakeSlackAppFactory(),
    evaluation: { observer: new EvaluationEventCollector(), runId: 'api-gate' },
    hostFactory: (_agent, onUpdate) =>
      ({
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => 'acp-1',
        loadSession: async () => true,
        hasSession: () => true,
        prompt: async (id: string) => {
          prompted.push(id)
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
    decisionGet: vi.fn(async () => ({
      decision: {
        id: decisionId,
        name: 'On topic',
        providerId: 'typesafe',
        model: 'jev-latest',
        question: { type: 'boolean', instructions: 'Is it about the product?', criteria: { true: 'Yes', false: 'No' } }
      }
    }))
  }
  const evaluate = vi.spyOn(internal.decisionEvaluator as DecisionEvaluator, 'evaluate')
  const answer = (value: boolean) =>
    evaluate.mockResolvedValue({
      status: 'answered',
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 1 },
      answer: { type: 'boolean', value, probability: value ? 0.9 : 0.1 }
    } satisfies DecisionEvaluation)
  const turn = (conversationId: string, origin?: 'ai-sdk-ui') => {
    const done = vi.fn()
    const ack = internal.webchatTransport.dispatchWebchatTurn(
      agentId,
      conversationId,
      'Is the weather nice today?',
      { id: 'example-user', name: 'Example user' },
      { output: vi.fn(), done },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      origin
    )
    return { ack, done }
  }
  return { internal, prompted, evaluate, answer, turn }
}

describe('API turn Decision gate', () => {
  it('refuses an API turn its gate answers no to, before anything is recorded', async () => {
    const { internal, prompted, evaluate, answer, turn } = await start()
    answer(false)
    const { ack } = turn('api-declined', 'ai-sdk-ui')
    expect(await ack).toMatchObject({ accepted: false, reason: 'declined' })
    expect(internal.cpClient.decisionGet).toHaveBeenCalledWith(
      expect.objectContaining({ requesterAgentId: agentId, decisionId, purpose: 'api_gate' })
    )
    expect(evaluate.mock.calls[0]![0].state).toMatchObject({ currentMessage: { text: 'Is the weather nice today?' } })
    expect(prompted).toEqual([])
    expect(await internal.store.listSessions(agentId)).toHaveLength(0)
  })

  it('admits an API turn its gate matches', async () => {
    const { answer, turn } = await start()
    answer(true)
    const { ack, done } = turn('api-admitted', 'ai-sdk-ui')
    expect(await ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
  })

  it('admits an API turn whose evaluation is unavailable', async () => {
    const { evaluate, turn } = await start()
    evaluate.mockResolvedValue({ status: 'unavailable', reason: 'provider' })
    expect(await turn('api-unavailable', 'ai-sdk-ui').ack).toMatchObject({ accepted: true })
  })

  it('never gates a console turn on the same agent', async () => {
    const { evaluate, answer, turn } = await start()
    answer(false)
    expect(await turn('console').ack).toMatchObject({ accepted: true })
    expect(evaluate).not.toHaveBeenCalled()
  })
})
