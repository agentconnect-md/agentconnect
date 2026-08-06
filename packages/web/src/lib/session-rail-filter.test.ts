import { describe, expect, it } from 'vitest'
import {
  EMPTY_RAIL_AGENT_FILTER,
  railAgentFilterQuery,
  railSeedAgentIds,
  railSeedCollapsed,
  seedRailAgentFilter
} from './session-rail-filter'

describe('railSeedAgentIds', () => {
  it('prefers the resolved conversation roster', () => {
    expect(railSeedAgentIds([{ agentId: 'agent-a' }, { agentId: 'agent-b' }], ['agent-c'], 'agent-a')).toEqual([
      'agent-a',
      'agent-b'
    ])
  })

  it('falls back to the live roster for a conversation no resolver can answer for', () => {
    // A live playground conversation is client-side until its first turn
    // persists; seeding its owner alone filtered the rail to one participant of
    // a conversation with several.
    expect(railSeedAgentIds(null, ['agent-a', 'agent-b'], 'agent-a')).toEqual(['agent-a', 'agent-b'])
    expect(railSeedAgentIds([], ['agent-a', 'agent-b'], 'agent-a')).toEqual(['agent-a', 'agent-b'])
  })

  it('falls back to the owning agent for an ordinary session', () => {
    expect(railSeedAgentIds(undefined, [], 'agent-a')).toEqual(['agent-a'])
  })

  it('seeds nothing when nothing is known yet', () => {
    expect(railSeedAgentIds(undefined, [], undefined)).toEqual([])
  })
})

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

describe('railSeedCollapsed', () => {
  const seeded = (agentIds: string[]) => ({ agentIds, touched: false })

  it('widens a shared-conversation seed that answered with only the open thread', () => {
    // The reported bug: a Slack thread two agents worked in together exactly once.
    // Repeated `agentId` is an AND, so the CP answers with that one conversation —
    // measured against a real org whose agents own 48 and 86 sessions apart, and
    // 474 between everyone. The rail then had fewer than two rows and erased
    // itself, taking the picker that could have widened it.
    expect(railSeedCollapsed(seeded(['agent-a', 'agent-b']), 1, 1, false)).toBe(true)
  })

  it('widens a single-agent seed whose only session is the open one', () => {
    expect(railSeedCollapsed(seeded(['agent-a']), 1, 1, false)).toBe(true)
  })

  it('leaves a seed that found other conversations alone', () => {
    expect(railSeedCollapsed(seeded(['agent-a', 'agent-b']), 2, 2, false)).toBe(false)
    // `total` is the CP's count for the whole filtered list, so a first page that
    // fits in one row still speaks for the rest of it.
    expect(railSeedCollapsed(seeded(['agent-a']), 1, 86, false)).toBe(false)
  })

  it('never overrules a filter the reader set, however narrow its answer', () => {
    // Their question, their answer — widening it would silently discard the
    // agents they just picked.
    expect(railSeedCollapsed({ agentIds: ['agent-a', 'agent-b'], touched: true }, 1, 1, false)).toBe(false)
    expect(railSeedCollapsed({ agentIds: [], touched: true }, 0, 0, false)).toBe(false)
  })

  it('waits for the seeded page instead of widening on an in-flight one', () => {
    // Mid-flight is indistinguishable from collapsed here (no rows, zero total).
    // Widening on it would fire the unfiltered request on every single load.
    expect(railSeedCollapsed(seeded(['agent-a']), 0, 0, true)).toBe(false)
  })

  it('has nothing to widen before the conversation has seeded the filter', () => {
    expect(railSeedCollapsed(EMPTY_RAIL_AGENT_FILTER, 0, 0, false)).toBe(false)
  })
})
