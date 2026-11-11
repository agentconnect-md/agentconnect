import { describe, expect, it } from 'vitest'
import { COORDINATOR_FILTER_V1_FEATURE } from '@agentconnect.md/protocol'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import {
  agentFilterPlacement,
  COORDINATOR_FILTER_FEATURE,
  coordinatorFilterLabel,
  coordinatorFilterProviders,
  coordinatorFilterSupported
} from './coordinator-filter'

const option = (over: Partial<DecisionProviderOption>): DecisionProviderOption => ({
  id: 'typesafe',
  daemonId: 'daemon-1',
  name: 'TypeSafe',
  kind: 'typesafe',
  source: 'byok',
  readiness: { status: 'ready' },
  models: [
    { id: 'jev-1.13.0', label: 'Jev 1.13', questionTypes: ['boolean', 'choice', 'score'] },
    { id: 'jev-latest', label: 'Jev latest', questionTypes: ['boolean', 'choice', 'score'] }
  ],
  ...over
})

// auto-session-mode.md §4.7: the console offers the filter's Boolean-capable models once per provider.
describe('coordinator filter providers', () => {
  it('names the same capability the daemon advertises', () => {
    expect(COORDINATOR_FILTER_FEATURE).toBe(COORDINATOR_FILTER_V1_FEATURE)
    expect(coordinatorFilterSupported([COORDINATOR_FILTER_FEATURE])).toBe(true)
    expect(coordinatorFilterSupported(undefined)).toBe(false)
  })

  it('lists each provider once, a ready daemon first, with only the models the Control Plane accepts', () => {
    const providers = coordinatorFilterProviders([
      option({ daemonId: 'daemon-2', readiness: { status: 'missing_credentials' } }),
      option({}),
      option({
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai',
        models: [{ id: 'gpt-x', label: 'Unknown', questionTypes: ['boolean'] }]
      })
    ])
    expect(providers.map((p) => [p.id, p.name, p.daemonId, p.models.map((m) => m.id)])).toEqual([
      ['typesafe', 'Jev', 'daemon-1', ['jev-1.13.0', 'jev-latest']]
    ])
  })

  it('keeps only the providers of the placement: one machine, a group, or the pool', () => {
    const catalog = [
      option({ daemonId: 'daemon-1' }),
      option({
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai',
        daemonId: 'member-1',
        memberSetId: 'set-1',
        models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', questionTypes: ['boolean'] }]
      }),
      option({
        daemonId: 'pool-1',
        pool: true,
        models: [{ id: 'jev-preview', label: 'Jev preview', questionTypes: ['boolean'] }]
      })
    ]
    const ids = (placement: Parameters<typeof coordinatorFilterProviders>[1]) =>
      coordinatorFilterProviders(catalog, placement).map((p) => `${p.id}@${p.daemonId}`)
    expect(ids({ kind: 'daemon', daemonId: 'daemon-1' })).toEqual(['typesafe@daemon-1'])
    expect(ids({ kind: 'set', setId: 'set-1' })).toEqual(['openai@member-1'])
    expect(ids({ kind: 'pool' })).toEqual(['typesafe@pool-1'])
    expect(agentFilterPlacement({ placementKind: 'pool', setId: 'x', daemon: '' })).toEqual({ kind: 'pool' })
    expect(agentFilterPlacement({ placementKind: 'set', setId: 'set-1', daemon: '' })).toEqual({
      kind: 'set',
      setId: 'set-1'
    })
    expect(agentFilterPlacement({ placementKind: 'daemon', setId: null, daemon: 'daemon-1' })).toEqual({
      kind: 'daemon',
      daemonId: 'daemon-1'
    })
  })

  it('names a filter by its catalog labels, else by its ids', () => {
    expect(coordinatorFilterLabel({ providerId: 'typesafe', model: 'jev-1.13.0' }, [option({})])).toBe(
      'TypeSafe · Jev 1.13'
    )
    // Once the filter names the provider Jev, the model's label says it all.
    const named = coordinatorFilterProviders([option({})])
    expect(coordinatorFilterLabel({ providerId: 'typesafe', model: 'jev-1.13.0' }, named)).toBe('Jev 1.13')
    expect(coordinatorFilterLabel({ providerId: 'openai', model: 'gpt-6-luna' }, [])).toBe('openai · gpt-6-luna')
  })
})
