import { describe, expect, it } from 'vitest'
import { EMPTY_RAIL_AGENT_FILTER, seedRailAgentFilter } from './session-rail-filter'

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
})
