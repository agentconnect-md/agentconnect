import { describe, expect, it, vi } from 'vitest'
import type { DecisionDraftInput } from '@agentconnect.md/protocol/decision'
import type { DecisionPreviewInput } from '@agentconnect.md/protocol/decision-api'
import { createDecisionMockApi } from './mock-api'
import { createDecisionMockSeed, evaluateRepeatedMentionFixture, repeatedMentionFixture } from './fixtures'

const draft = (id: string): DecisionDraftInput => {
  const entry = createDecisionMockSeed().decisions.find((decision) => decision.id === id)!
  return { name: entry.name, providerId: entry.providerId, model: entry.model, question: entry.question }
}
const routerPreview = (): DecisionPreviewInput => ({
  decision: draft('support-category'),
  daemonId: 'example-daemon',
  state: { currentMessage: { text: 'Billing API failed' }, history: [] },
  consumer: {
    type: 'shared_bot_routing',
    botId: 'support-bot',
    config: createDecisionMockSeed().routings[0]!.config,
    targets: { type: 'new' }
  }
})

describe('Decision mock API', () => {
  it('supports isolated CRUD and preserves an inline-created Decision after a binding save fails', async () => {
    let fail = false
    const api = createDecisionMockApi({
      beforeSave: () => {
        if (fail) throw new Error('Simulated save failure')
      }
    })
    const created = await api.createDecision(draft('needs-response'))
    created.name = 'Unsaved edit'
    expect((await api.getDecision(created.id)).decision.name).toBe('Needs a response')
    fail = true
    const settings = {
      trigger: 'decision' as const,
      decisionBinding: {
        type: 'gate' as const,
        decisionId: created.id,
        when: { type: 'boolean' as const, values: [true] }
      }
    }
    await expect(api.saveChannel('moderation-channel', settings)).rejects.toThrow('Simulated save failure')
    expect((await api.getDecision(created.id)).usages).toEqual([])
    fail = false
    await api.saveChannel('moderation-channel', settings)
    await expect(api.deleteDecision(created.id)).rejects.toMatchObject({ status: 409 })
    await api.saveChannel('moderation-channel', { trigger: 'mention' })
    await api.deleteDecision(created.id)
    await expect(api.getDecision(created.id)).rejects.toMatchObject({ status: 404 })
    const channel = (await api.listChannels()).find((entry) => entry.id === 'new-channel')!
    channel.readiness.status = 'daemon_offline'
    expect((await api.listChannels()).find((entry) => entry.id === channel.id)!.readiness.status).toBe('ready')
    const preview = await api.preview({
      decision: draft('needs-response'),
      daemonId: 'example-daemon',
      state: {},
      consumer: { type: 'none' }
    })
    preview.readiness.status = 'daemon_offline'
    expect((await api.listProviders())[0]!.readiness.status).toBe('ready')
  })

  it('saves routing and scope atomically and requires explicit channel replacements', async () => {
    const api = createDecisionMockApi()
    const initial = await api.getRouting('support-bot')
    const config = initial.config!
    await expect(
      api.saveRouting('support-bot', {
        config,
        channelIds: ['new-channel', 'off-channel'],
        removals: [{ channelId: 'help-channel', settings: { trigger: 'mention' } }]
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(await api.getRouting('support-bot')).toEqual(initial)
    expect((await api.listChannels()).find((channel) => channel.id === 'new-channel')!.settings.trigger).toBe('mention')
    await expect(
      api.saveRouting('support-bot', { config, channelIds: ['new-channel'], removals: [] })
    ).rejects.toMatchObject({ status: 409 })
    const saved = await api.saveRouting('support-bot', {
      config,
      channelIds: ['new-channel'],
      removals: [{ channelId: 'help-channel', settings: { trigger: 'mention' } }]
    })
    expect(saved.channelIds).toEqual(['new-channel'])
    expect((await api.listChannels()).find((channel) => channel.id === 'help-channel')!.settings).toEqual({
      trigger: 'mention'
    })
    saved.config!.rules = []
    expect((await api.getRouting('support-bot')).config!.rules).toHaveLength(3)
  })

  it('preserves invalidated conditions as Needs review until the consumer is saved again', async () => {
    const api = createDecisionMockApi()
    await api.saveChannel('moderation-channel', {
      trigger: 'decision',
      decisionBinding: { type: 'gate', decisionId: 'frustration', when: { type: 'score', min: 1, max: 3 } }
    })
    const edit = draft('frustration')
    if (edit.question.type !== 'score') throw new Error('Expected Score fixture')
    edit.question.criteria.push('Severe')
    await api.updateDecision('frustration', edit)
    const channel = (await api.listChannels()).find((entry) => entry.id === 'moderation-channel')!
    expect(channel.readiness.status).toBe('needs_review')
    await api.updateDecision('frustration', { ...edit, name: 'Updated name' })
    expect((await api.listChannels()).find((entry) => entry.id === channel.id)!.readiness.status).toBe('needs_review')
    expect((await api.saveChannel(channel.id, channel.settings)).readiness.status).toBe('ready')
  })

  it('previews all Choice matches but keeps constrained thread/mention recipients', async () => {
    const api = createDecisionMockApi()
    const before = await api.getRouting('support-bot')
    const input = routerPreview()
    expect((await api.preview(input)).consumer).toMatchObject({
      matchedRuleIds: ['billing', 'technical'],
      effectiveAgentIds: ['billing-agent', 'technical-agent']
    })
    if (input.consumer.type !== 'shared_bot_routing') throw new Error('Expected routing fixture')
    for (const type of ['thread', 'mention'] as const) {
      input.consumer.targets = { type, agentIds: ['sales-agent'] }
      expect((await api.preview(input)).consumer).toMatchObject({
        matchedAgentIds: ['billing-agent', 'technical-agent'],
        effectiveAgentIds: ['sales-agent']
      })
    }
    expect(await api.getRouting('support-bot')).toEqual(before)
    input.consumer.config.rules[0]!.when = { type: 'choice', thresholds: { billing: 0.9 } }
    input.consumer.config.rules[1]!.when = { type: 'choice', thresholds: { technical: 0.9 } }
    expect((await api.preview(input)).consumer).toMatchObject({
      outcome: 'skip',
      effectiveAgentIds: [],
      usedOtherwise: true
    })
  })

  it('can skip repeated explicit mentions and passes model and context to the injected evaluator', async () => {
    const evaluate = vi.fn(evaluateRepeatedMentionFixture)
    const api = createDecisionMockApi({ evaluate })
    const result = await api.preview({
      decision: draft('needs-response'),
      daemonId: 'example-daemon',
      state: repeatedMentionFixture,
      consumer: {
        type: 'gate',
        channelId: 'moderation-channel',
        when: { type: 'boolean', values: [true] },
        targets: { type: 'mention', agentIds: ['moderator-agent'] }
      }
    })
    expect(result.mode).toBe('mock')
    expect(result.consumer).toMatchObject({ outcome: 'skip', effectiveAgentIds: [] })
    expect(evaluate.mock.calls[0]![0].model).toBe('jev-1.13.0')
    expect(evaluate.mock.calls[0]![1]).toEqual(repeatedMentionFixture)
  })

  it('distinguishes failed evaluation, missing configuration and successful skip', async () => {
    const input = routerPreview()
    if (input.consumer.type !== 'shared_bot_routing') throw new Error('Expected routing fixture')
    input.consumer.targets = { type: 'mention', agentIds: ['sales-agent'] }
    const failed = await createDecisionMockApi({ scenario: 'provider_unavailable' }).preview(input)
    expect(failed.evaluation).toEqual({ status: 'unavailable', reason: 'provider' })
    expect(failed.consumer).toMatchObject({ outcome: 'continue', effectiveAgentIds: ['sales-agent'] })
    const missing = await createDecisionMockApi({ scenario: 'missing_credentials' }).preview(input)
    expect(missing).toMatchObject({
      readiness: { status: 'missing_credentials' },
      evaluation: null,
      consumer: { outcome: 'blocked' }
    })
    const invalid = await createDecisionMockApi({
      evaluate: () => ({
        status: 'answered',
        model: 'jev-1.13.0',
        usage: { inputTokens: 1, outputTokens: 0 },
        answer: { type: 'choice', value: 'billing', probabilities: { billing: 1 }, confidence: 0.9 }
      })
    }).preview(input)
    expect(invalid.evaluation).toEqual({ status: 'unavailable', reason: 'invalid_response' })
  })

  it('rejects overlapping intervals and unknown targets without changing the saved route', async () => {
    const api = createDecisionMockApi()
    const saved = await api.getRouting('support-bot')
    const config = structuredClone(saved.config!)
    config.decisionId = 'frustration'
    config.rules = [
      { id: 'first', when: { type: 'score', min: 0, max: 2 }, action: { type: 'agent', agentId: 'billing-agent' } },
      { id: 'second', when: { type: 'score', min: 1, max: 3 }, action: { type: 'agent', agentId: 'technical-agent' } }
    ]
    await expect(
      api.saveRouting('support-bot', { config, channelIds: saved.channelIds, removals: [] })
    ).rejects.toMatchObject({ status: 400 })
    config.rules = [
      { id: 'unknown', when: { type: 'score', min: 0, max: 3 }, action: { type: 'agent', agentId: 'unknown-agent' } }
    ]
    await expect(
      api.saveRouting('support-bot', { config, channelIds: saved.channelIds, removals: [] })
    ).rejects.toMatchObject({ status: 400 })
    expect(await api.getRouting('support-bot')).toEqual(saved)
    const seed = createDecisionMockSeed()
    seed.bots[0]!.agents = seed.bots[0]!.agents.filter((agent) => agent.id !== 'technical-agent')
    expect((await createDecisionMockApi({ seed }).getRouting('support-bot')).readiness.status).toBe('needs_review')
  })

  it('exposes daemon-scoped BYOK/Cloud options without secrets or a provider mutation API', async () => {
    const api = createDecisionMockApi()
    expect((await api.listProviders('example-daemon')).map((provider) => provider.source)).toEqual([
      'byok',
      'ac_credits'
    ])
    expect(await api.listProviders('unknown-daemon')).toEqual([])
    await expect(api.createDecision({ ...draft('needs-response'), model: 'unsupported-model' })).rejects.toMatchObject({
      status: 400
    })
    const seed = createDecisionMockSeed('insufficient_credits')
    expect(seed.decisions.every((entry) => entry.providerId === 'typesafe-cloud')).toBe(true)
    expect(
      (await createDecisionMockApi({ seed }).listChannels()).find((channel) => channel.id === 'help-channel')!.readiness
        .status
    ).toBe('insufficient_credits')
  })
})
