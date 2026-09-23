import { describe, expect, it, vi } from 'vitest'
import type { DecisionToolDefinition } from '@agentconnect.md/protocol'
import { DecisionEvaluator } from '../src/decisions/evaluator.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { ALL_TOOL_NAMES, toolsForIntegrations } from '../src/mcp/tools.js'

const decision: DecisionToolDefinition = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Needs a reply',
  providerId: 'typesafe',
  model: 'jev-latest',
  question: {
    type: 'boolean',
    instructions: 'Does currentMessage need a reply?',
    criteria: { true: 'Yes', false: 'No' }
  }
}
const ctx: SessionContext = {
  agentId: '22222222-2222-4222-8222-222222222222',
  platform: 'webchat',
  channel: 'example-channel',
  thread: 'example-thread',
  deliveryThread: 'example-thread',
  isDm: true,
  tools: toolsForIntegrations([], { decisions: true })
}
const state = { history: ['Earlier context'], currentMessage: 'Please help with this question' }

function setup() {
  const abort = new AbortController()
  const list = vi.fn(async () => ({ items: [decision], nextCursor: null }))
  const get = vi.fn(async (): Promise<{ decision: DecisionToolDefinition | null }> => ({ decision }))
  const providerFetch = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: 'jev-1.13.0',
      answers: { decision: { type: 'noul', noul: 0.8 } },
      usage: { input_tokens: 12, output_tokens: 1 }
    })
  )
  const credentials = vi.fn(async () => ({ credentials: { apiKey: 'example-key', endpoint: null, headers: {} } }))
  const evaluator = new DecisionEvaluator({
    orgForAgent: () => 'example-org',
    credentials,
    keyServer: () => undefined,
    fetch: providerFetch
  })
  const assertCurrent = vi.fn(() => abort.signal.throwIfAborted())
  const deps = {
    canRun: () => !abort.signal.aborted,
    decisions: {
      list,
      get,
      evaluate: evaluator.evaluate.bind(evaluator),
      turn: () => ({ signal: abort.signal, assertCurrent })
    }
  } as unknown as OpsDeps
  const run = (args: Record<string, unknown> = { decisionId: decision.id, state }) =>
    executeTool(ctx, 'evaluateDecision', args, deps)
  return { abort, list, get, credentials, providerFetch, assertCurrent, deps, run }
}

describe('agent Decision tools', () => {
  it('offers the optional tools without platform integrations and reserves their names', () => {
    const names = ctx.tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['listDecisions', 'evaluateDecision']))
    expect(ALL_TOOL_NAMES).toEqual(expect.arrayContaining(['listDecisions', 'evaluateDecision']))
    expect(toolsForIntegrations([]).some((tool) => tool.name === 'evaluateDecision')).toBe(false)
  })

  it('binds discovery and evaluation to the caller and keeps all sample data on the provider path', async () => {
    const { deps, list, get, credentials, providerFetch, run } = setup()
    await expect(executeTool(ctx, 'listDecisions', { query: 'reply', limit: 2 }, deps)).resolves.toEqual({
      items: [decision],
      nextCursor: null
    })
    expect(list).toHaveBeenCalledWith({ requesterAgentId: ctx.agentId, query: 'reply', limit: 2 })
    expect(providerFetch).not.toHaveBeenCalled()
    await expect(run()).resolves.toMatchObject({
      decisionId: decision.id,
      evaluation: { status: 'answered', answer: { type: 'boolean', value: true, probability: 0.8 } }
    })
    expect(get).toHaveBeenCalledWith({ requesterAgentId: ctx.agentId, decisionId: decision.id })
    expect(credentials).toHaveBeenCalledWith({ agentId: ctx.agentId, provider: 'typesafe' }, expect.any(AbortSignal))
    expect(JSON.parse(providerFetch.mock.calls[0]![1]!.body as string)).toMatchObject({ state, model: decision.model })
    get.mockResolvedValueOnce({ decision: { ...decision, model: 'jev-preview' } })
    await run()
    expect(get).toHaveBeenCalledTimes(2)
    expect(JSON.parse(providerFetch.mock.calls[1]![1]!.body as string).model).toBe('jev-preview')
  })

  it('refuses unknown or unbound Decisions and propagates lookup failures without evaluating', async () => {
    const { get, providerFetch, run } = setup()
    get.mockResolvedValueOnce({ decision: null })
    await expect(run()).rejects.toThrow('not found or unavailable')
    get.mockRejectedValueOnce(new Error('Decision lookup unavailable'))
    await expect(run()).rejects.toThrow('lookup unavailable')
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('rejects identity/config overrides and oversized context before lookup', async () => {
    const { run, get } = setup()
    await expect(run({ decisionId: decision.id, state, agentId: 'another-agent' })).rejects.toThrow()
    await expect(run({ decisionId: decision.id, state, model: 'jev-preview' })).rejects.toThrow()
    await expect(run({ decisionId: decision.id, state: { text: 'x'.repeat(32 * 1024) } })).rejects.toThrow('32 KiB')
    expect(get).not.toHaveBeenCalled()
  })

  it('stops before provider dispatch if the originating turn ends during lookup', async () => {
    const { get, abort, providerFetch, run } = setup()
    get.mockImplementationOnce(async () => {
      abort.abort()
      return { decision }
    })
    await expect(run()).rejects.toThrow()
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('discards a provider result if the originating turn is no longer current', async () => {
    const { assertCurrent, providerFetch, run } = setup()
    providerFetch.mockImplementationOnce(async () => {
      assertCurrent.mockImplementation(() => {
        throw new Error('turn replaced')
      })
      return Response.json({ model: 'jev-latest', answers: { decision: { type: 'noul', noul: 0.8 } } })
    })
    await expect(run()).rejects.toThrow('turn replaced')
  })

  it('returns typed provider unavailability without retrying or exposing provider errors', async () => {
    const { providerFetch, run } = setup()
    providerFetch.mockResolvedValueOnce(new Response('example-provider-secret', { status: 401 }))
    await expect(run()).resolves.toEqual({
      decisionId: decision.id,
      evaluation: { status: 'unavailable', reason: 'credentials' }
    })
    expect(providerFetch).toHaveBeenCalledTimes(1)
  })
})
