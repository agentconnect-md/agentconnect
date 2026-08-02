import { describe, expect, it } from 'vitest'
import { EMPTY_RAIL_AGENT_FILTER, railAgentFilterQuery, seedRailAgentFilter } from './session-rail-filter'

describe('seedRailAgentFilter', () => {
  it('defaults to the open conversation’s agents', () => {
    expect(seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, ['agent-a', 'agent-b'])).toEqual({
      agentIds: ['agent-a', 'agent-b'],
      touched: false
    })
  })

  it('does not re-seed when the roster comes back in a different order', () => {
    // The roster is ordered by last activity, so the same two agents arrive
    // either way round as they take turns. Re-seeding on that would reshuffle
    // the reader's chips every time one of them spoke.
    const seeded = seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, ['agent-a', 'agent-b'])
    expect(seedRailAgentFilter(seeded, ['agent-b', 'agent-a'])).toBe(seeded)
  })

  it('drops duplicate and blank roster entries', () => {
    // A roster row whose agent the caller cannot see carries no id; seeding it
    // would send an empty `agentId` and filter the rail down to nothing.
    expect(seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, ['agent-a', '', 'agent-a']).agentIds).toEqual(['agent-a'])
  })

  it('stays empty while the conversation has not resolved', () => {
    expect(seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, [])).toBe(EMPTY_RAIL_AGENT_FILTER)
  })

  it('follows the route while untouched', () => {
    const seeded = seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, ['agent-a'])
    expect(seedRailAgentFilter(seeded, ['agent-b', 'agent-c'])).toEqual({
      agentIds: ['agent-b', 'agent-c'],
      touched: false
    })
  })

  it('keeps a cleared filter cleared when the reader opens another session', () => {
    // The whole point of the × on the chip: navigating the widened rail must not
    // silently re-narrow it to the row that was just clicked.
    const cleared = { agentIds: [], touched: true }
    expect(seedRailAgentFilter(cleared, ['agent-b'])).toBe(cleared)
  })

  it('keeps a chosen pair across conversations someone else owns', () => {
    const chosen = { agentIds: ['agent-c', 'agent-d'], touched: true }
    expect(seedRailAgentFilter(chosen, ['agent-b'])).toBe(chosen)
  })

  it('returns the same object when the seed does not move', () => {
    const seeded = seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, ['agent-a', 'agent-b'])
    expect(seedRailAgentFilter(seeded, ['agent-a', 'agent-b'])).toBe(seeded)
  })

  it('marks a filter the reader chose even when it matches the open conversation', () => {
    // Filtering to agent B and then opening B's own session leaves a filter that
    // looks identical to the default. The rail keeps its control on screen off
    // `touched`, so this flag may not be inferred by comparing agent ids.
    const chosen = { agentIds: ['agent-b'], touched: true }
    expect(seedRailAgentFilter(chosen, ['agent-b']).touched).toBe(true)
  })
})

describe('railAgentFilterQuery', () => {
  it('asks nothing while an untouched filter has no conversation yet', () => {
    expect(railAgentFilterQuery(EMPTY_RAIL_AGENT_FILTER)).toBeNull()
  })

  it('never asks unfiltered for a conversation whose agents are known', () => {
    // The regression this pins: deriving readiness from the session id rather than
    // from the seeded filter made the first render of every deep link fetch — and
    // paint — the org-wide list before snapping to the conversation's own agents.
    expect(railAgentFilterQuery(seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, ['agent-a']))).toEqual({
      agentId: ['agent-a']
    })
  })

  it('asks for every session once the reader clears the filter', () => {
    expect(railAgentFilterQuery({ agentIds: [], touched: true })).toEqual({})
  })

  it('carries every selected agent, which the CP reads as one shared conversation', () => {
    expect(railAgentFilterQuery({ agentIds: ['agent-c', 'agent-d'], touched: true })).toEqual({
      agentId: ['agent-c', 'agent-d']
    })
  })
})
