import { describe, expect, it } from 'vitest'
import { sessionResumeMembers, sessionResumeState } from './session-resume'

describe('sessionResumeState', () => {
  const placements = new Map([
    ['agent-a', { daemonId: 'daemon-1' }],
    ['agent-b', { daemonId: 'daemon-2' }],
    ['agent-pool', { setId: 'pool-set' }]
  ])

  it('allows resume while every agent remains on its session daemon', () => {
    expect(
      sessionResumeState(
        [
          { agentId: 'agent-a', daemonId: 'daemon-1' },
          { agentId: 'agent-b', daemonId: 'daemon-2' }
        ],
        placements
      )
    ).toBe('available')
  })

  it('disables resume after an agent moves', () => {
    expect(sessionResumeState([{ agentId: 'agent-a', daemonId: 'daemon-old' }], placements)).toBe('unavailable')
  })

  it('fails closed for missing session ownership or current placement', () => {
    expect(sessionResumeState([{ agentId: 'agent-a', daemonId: null }], placements)).toBe('unavailable')
    expect(sessionResumeState([{ agentId: 'agent-c', daemonId: 'daemon-3' }], placements)).toBe('unavailable')
  })

  it('reports checking while detail metadata is loading', () => {
    expect(sessionResumeState(null, placements)).toBe('checking')
  })

  it('allows resume on a pool agent whose content sits in the pool store, whatever member recorded it', () => {
    expect(
      sessionResumeState([{ agentId: 'agent-pool', daemonId: 'rolled-member', contentSetId: 'pool-set' }], placements)
    ).toBe('available')
    // The recorder was reaped and SetNulled — the store still holds the rows.
    expect(sessionResumeState([{ agentId: 'agent-pool', daemonId: null, contentSetId: 'pool-set' }], placements)).toBe(
      'available'
    )
  })

  it('fails closed when a pool agent’s content is not in its current set', () => {
    // Moved onto the pool after recording on a private store.
    expect(sessionResumeState([{ agentId: 'agent-pool', daemonId: 'daemon-1', contentSetId: null }], placements)).toBe(
      'unavailable'
    )
    // Moved between sets.
    expect(
      sessionResumeState([{ agentId: 'agent-pool', daemonId: 'daemon-1', contentSetId: 'other-set' }], placements)
    ).toBe('unavailable')
    // Pinned to a machine now; the pool store is not its placement.
    expect(sessionResumeState([{ agentId: 'agent-a', daemonId: null, contentSetId: 'pool-set' }], placements)).toBe(
      'unavailable'
    )
  })

  it('checks every conversation member on a flat session route', () => {
    const selected = { agentId: 'agent-a', daemonId: 'daemon-1' }
    const members = sessionResumeMembers(
      [selected, { agentId: 'agent-b', daemonId: 'daemon-old' }],
      selected,
      true,
      false
    )

    expect(sessionResumeState(members, placements)).toBe('unavailable')
  })

  it('fails closed while flat-route conversation membership is loading', () => {
    expect(sessionResumeMembers(undefined, { agentId: 'agent-a', daemonId: 'daemon-1' }, true, true)).toBeNull()
  })

  it('stays unavailable when a required conversation lookup fails', () => {
    const members = sessionResumeMembers(undefined, { agentId: 'agent-a', daemonId: 'daemon-1' }, true, false)
    expect(sessionResumeState(members, placements)).toBe('unavailable')
  })
})
