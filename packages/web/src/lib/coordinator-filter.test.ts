import { describe, expect, it } from 'vitest'
import { COORDINATOR_FILTER_V1_FEATURE } from '@agentconnect.md/protocol'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import {
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
    expect(providers.map((p) => [p.id, p.daemonId, p.models.map((m) => m.id)])).toEqual([
      ['typesafe', 'daemon-1', ['jev-1.13.0', 'jev-latest']]
    ])
  })

  it('names a filter by its catalog labels, else by its ids', () => {
    expect(coordinatorFilterLabel({ providerId: 'typesafe', model: 'jev-1.13.0' }, [option({})])).toBe(
      'TypeSafe · Jev 1.13'
    )
    expect(coordinatorFilterLabel({ providerId: 'openai', model: 'gpt-6-luna' }, [])).toBe('openai · gpt-6-luna')
  })
})
