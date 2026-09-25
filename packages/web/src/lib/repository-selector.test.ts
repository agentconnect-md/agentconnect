import { describe, expect, it } from 'vitest'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { placementDecisionProviders, repositoryDecisionBlock, repositorySelectorProviders } from './repository-selector'

const option = (over: Partial<DecisionProviderOption> = {}): DecisionProviderOption => ({
  id: 'typesafe',
  daemonId: 'daemon-1',
  memberSetId: null,
  name: 'TypeSafe',
  kind: 'typesafe',
  source: 'byok',
  readiness: { status: 'ready' },
  models: [{ id: 'jev-latest', label: 'Jev latest', questionTypes: ['choice'] }],
  ...over
})

const onDaemon = { placementKind: 'daemon' as const, daemon: 'daemon-1', setId: null }
const onGroup = { placementKind: 'set' as const, daemon: 'pool', setId: 'set-1' }
const SELECTOR = { providerId: 'typesafe', model: 'jev-latest' }

describe('repository selector availability', () => {
  it('reads the catalog of the daemon, or of the group or pool members, that runs the agent', () => {
    const own = option()
    const member = option({ daemonId: 'member-1', memberSetId: 'set-1' })
    const elsewhere = option({ daemonId: 'daemon-2' })
    expect(placementDecisionProviders([own, member, elsewhere], onDaemon)).toEqual([own])
    expect(placementDecisionProviders([own, member, elsewhere], onGroup)).toEqual([member])
    expect(placementDecisionProviders([own], { ...onGroup, setId: null })).toEqual([])
  })

  it('keeps only models the Control Plane accepts for Choice questions', () => {
    const mixed = option({
      models: [
        { id: 'jev-latest', label: 'Jev latest', questionTypes: ['choice'] },
        { id: 'jev-latest-score', label: 'Score', questionTypes: ['score'] }
      ]
    })
    expect(repositorySelectorProviders([mixed, option({ id: 'unknown' })])).toEqual([
      { ...mixed, models: [mixed.models[0]] }
    ])
  })

  it('names why By decision is unavailable: no ready provider first, then no selector', () => {
    expect(repositoryDecisionBlock([], onDaemon, SELECTOR)).toBe('provider')
    expect(repositoryDecisionBlock([option({ readiness: { status: 'daemon_offline' } })], onDaemon, SELECTOR)).toBe(
      'provider'
    )
    expect(repositoryDecisionBlock([option()], onDaemon, null)).toBe('selector')
    expect(repositoryDecisionBlock([option()], onDaemon, SELECTOR)).toBeNull()
  })
})
