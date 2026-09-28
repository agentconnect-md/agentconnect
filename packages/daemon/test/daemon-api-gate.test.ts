// An API turn passes its agent's Decision gate where it enters the daemon, before either dispatch shape; a console turn never does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionEvaluation } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import type { DecisionEvaluator } from '../src/decisions/evaluator.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const agentId = 'example-agent'
const decisionId = '33333333-3333-4333-8333-333333333333'
const chatId = '44444444-4444-4444-8444-444444444444'
const roots: string[] = []
const daemons: Daemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projection(admit: boolean) {
  return {
    gate: { type: 'gate', decisionId, when: { type: 'boolean', values: [admit] } },
    definitions: [
      {
        id: decisionId,
        name: 'On topic',
        providerId: 'typesafe',
        model: 'jev-latest',
        question: { type: 'boolean', instructions: 'Is it about the product?', criteria: { true: 'Yes', false: 'No' } }
      }
    ]
  }
}

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
      // AG-UI admits the opposite answer, so a turn shows which gate it read; a newer CP's protocol is kept and never read.
      apiGates: { 'ai-sdk-ui': projection(true), 'ag-ui': projection(false), 'future-protocol': projection(true) }
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
  const evaluate = vi.spyOn(internal.decisionEvaluator as DecisionEvaluator, 'evaluate')
  const answer = (value: boolean) =>
    evaluate.mockResolvedValue({
      status: 'answered',
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 1 },
      answer: { type: 'boolean', value, probability: value ? 0.9 : 0.1 }
    } satisfies DecisionEvaluation)
  let seq = 0
  const turn = (over: { origin?: string; targetSessionId?: string } = {}) =>
    internal.dispatchRelayOp(
      {
        source: 'webchat',
        agentId,
        sessionKey: chatId,
        msgId: `msg-${++seq}`,
        chatId,
        ...(over.targetSessionId ? { targetSessionId: over.targetSessionId } : {}),
        payload: {
          op: 'turn',
          text: 'Is the weather nice today?',
          user: 'Example user',
          ...(over.origin ? { origin: over.origin } : {})
        }
      },
      vi.fn()
    )
  return { internal, prompted, evaluate, answer, turn }
}

describe('API turn Decision gate', () => {
  it('refuses an API turn its gate answers no to, before anything is recorded, without reading the CP', async () => {
    const { internal, prompted, evaluate, answer, turn } = await start()
    answer(false)
    expect(await turn({ origin: 'ai-sdk-ui' })).toMatchObject({ accepted: false, reason: 'declined' })
    expect(evaluate.mock.calls[0]![0]).toMatchObject({
      decision: { id: decisionId },
      state: { currentMessage: { text: 'Is the weather nice today?' } }
    })
    expect(internal.cpClient).toBeUndefined()
    expect(prompted).toEqual([])
    expect(await internal.store.listSessions(agentId)).toHaveLength(0)
  })

  it('gates a session-targeted API turn the same way', async () => {
    const { evaluate, answer, turn } = await start()
    answer(false)
    expect(await turn({ origin: 'ai-sdk-ui', targetSessionId: 'example-session' })).toMatchObject({
      accepted: false,
      reason: 'declined'
    })
    expect(evaluate).toHaveBeenCalledOnce()
  })

  it('admits an API turn its gate matches, or whose evaluation is unavailable', async () => {
    const { evaluate, answer, turn } = await start()
    answer(true)
    expect(await turn({ origin: 'ai-sdk-ui' })).toMatchObject({ accepted: true })
    evaluate.mockResolvedValue({ status: 'unavailable', reason: 'provider' })
    expect(await turn({ origin: 'ai-sdk-ui' })).toMatchObject({ accepted: true })
  })

  it("records each gated API turn for the API row's Recent evaluations", async () => {
    const { internal, answer, turn } = await start()
    answer(false)
    await turn({ origin: 'ai-sdk-ui' })
    answer(true)
    await turn({ origin: 'ai-sdk-ui' })
    const orgId = internal.orgForAgent(agentId)
    const reader = internal.decisionApiGateEvaluations
    const req = { agentId, protocol: 'ai-sdk-ui' as const, limit: 20 }
    await vi.waitFor(async () => expect((await reader.list(orgId, req)).items).toHaveLength(2))
    const page = await reader.list(orgId, req)
    expect(page.items.map((item: { outcome: string }) => item.outcome)).toEqual(['triggered', 'skipped'])
    expect(page.items[1]).toMatchObject({
      messageId: 'msg-1',
      title: 'Is the weather nice today?',
      decisionId,
      answer: { type: 'boolean', value: false },
      requestedModel: 'jev-latest',
      detailsExpired: false
    })
    const { evaluation } = await reader.get(orgId, { agentId, protocol: 'ai-sdk-ui', seq: page.items[1].seq })
    expect(evaluation).toMatchObject({
      snapshot: { decisionId, condition: { type: 'boolean', values: [true] } },
      input: {
        currentMessage: { id: 'msg-1', sender: { id: 'Example user' }, text: 'Is the weather nice today?' },
        history: []
      },
      fullAnswer: { type: 'boolean', value: false },
      evidence: null
    })
  })

  it('gates each API turn by its own protocol gate', async () => {
    const { evaluate, answer, turn } = await start()
    answer(false)
    expect(await turn({ origin: 'ai-sdk-ui' })).toMatchObject({ accepted: false, reason: 'declined' })
    expect(await turn({ origin: 'ag-ui' })).toMatchObject({ accepted: true })
    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it('refuses a turn over a protocol this build does not know, without evaluating it', async () => {
    const { evaluate, prompted, turn } = await start()
    expect(await turn({ origin: 'future-protocol' })).toMatchObject({ accepted: false, reason: 'unsupported' })
    expect(evaluate).not.toHaveBeenCalled()
    expect(prompted).toEqual([])
  })

  it('never gates a console turn on the same agent', async () => {
    const { evaluate, answer, turn } = await start()
    answer(false)
    expect(await turn()).toMatchObject({ accepted: true })
    expect(evaluate).not.toHaveBeenCalled()
  })
})
