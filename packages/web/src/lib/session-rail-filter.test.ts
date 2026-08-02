import { describe, expect, it } from 'vitest'
import { EMPTY_RAIL_AGENT_FILTER, railAgentFilterQuery, seedRailAgentFilter } from './session-rail-filter'

describe('seedRailAgentFilter', () => {
  it('defaults to the open session’s agent', () => {
    expect(seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, 'agent-a')).toEqual({ agentIds: ['agent-a'], touched: false })
  })

  it('stays empty while the session has not resolved', () => {
    expect(seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, '')).toBe(EMPTY_RAIL_AGENT_FILTER)
  })

  it('follows the route while untouched', () => {
    const seeded = seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, 'agent-a')
    expect(seedRailAgentFilter(seeded, 'agent-b')).toEqual({ agentIds: ['agent-b'], touched: false })
  })

  it('keeps a cleared filter cleared when the reader opens another session', () => {
    // The whole point of the × on the chip: navigating the widened rail must not
    // silently re-narrow it to the row that was just clicked.
    const cleared: ReturnType<typeof seedRailAgentFilter> = { agentIds: [], touched: true }
    expect(seedRailAgentFilter(cleared, 'agent-b')).toBe(cleared)
  })

  it('keeps a chosen agent across sessions owned by someone else', () => {
    const chosen = { agentIds: ['agent-c'], touched: true }
    expect(seedRailAgentFilter(chosen, 'agent-b')).toBe(chosen)
  })

  it('returns the same object when the seed does not move', () => {
    const seeded = seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, 'agent-a')
    expect(seedRailAgentFilter(seeded, 'agent-a')).toBe(seeded)
  })

  it('marks a filter the reader chose even when it matches the open session', () => {
    // Filtering to agent B and then opening B's own session leaves a filter that
    // looks identical to the default. The rail keeps its control on screen off
    // `touched`, so this flag may not be inferred by comparing agent ids.
    const chosen = { agentIds: ['agent-b'], touched: true }
    expect(seedRailAgentFilter(chosen, 'agent-b').touched).toBe(true)
  })
})

describe('railAgentFilterQuery', () => {
  it('asks nothing while an untouched filter has no session yet', () => {
    expect(railAgentFilterQuery(EMPTY_RAIL_AGENT_FILTER)).toBeNull()
  })

  it('never asks unfiltered for a session whose agent is known', () => {
    // The regression this pins: deriving readiness from the session id rather than
    // from the seeded filter made the first render of every deep link fetch — and
    // paint — the org-wide list before snapping to the session's own agent.
    expect(railAgentFilterQuery(seedRailAgentFilter(EMPTY_RAIL_AGENT_FILTER, 'agent-a'))).toEqual({
      agentId: 'agent-a'
    })
  })

  it('asks for every session once the reader clears the filter', () => {
    expect(railAgentFilterQuery({ agentIds: [], touched: true })).toEqual({})
  })

  it('scopes to the agent the reader chose', () => {
    expect(railAgentFilterQuery({ agentIds: ['agent-c'], touched: true })).toEqual({ agentId: 'agent-c' })
  })
})
