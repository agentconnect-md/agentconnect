import { describe, it, expect } from 'vitest'
import { PlacementResolver, type DutyHolderReader } from './placementResolver.js'
import { DaemonId } from '../domain/ids.js'
import { systemClock } from '../domain/clock.js'

const AGENT = '00000000-0000-0000-0000-00000000000a'
const MACHINE = DaemonId('00000000-0000-0000-0000-0000000000d0')
const MEMBER = DaemonId('00000000-0000-0000-0000-0000000000d1')
const SET = 'set-pool'

function duties(over: { holders?: DaemonId[]; confirmed?: DaemonId[] } = {}): DutyHolderReader {
  return {
    holdersOf: async () => over.holders ?? [],
    confirmedHoldersOf: async () => over.confirmed ?? []
  }
}

const setAgent = { agentId: AGENT, placementKind: 'set' as const, daemonId: null, setId: SET }
const machineAgent = { agentId: AGENT, placementKind: 'daemon' as const, daemonId: MACHINE, setId: null }
const unplaced = { agentId: AGENT, placementKind: 'daemon' as const, daemonId: null, setId: null }

// The three directory outcomes (#987): routable names the confirmed member; pending is a set agent
// nobody may be addressed at yet but a live member holds or will claim; dropped is the rest.
describe('PlacementResolver.resolveDirectory', () => {
  it('names the confirmed holder for a set agent, never an unconfirmed one', async () => {
    const resolver = new PlacementResolver({
      duties: duties({ holders: [MEMBER], confirmed: [MEMBER] }),
      clock: systemClock
    })
    expect(await resolver.resolveDirectory([setAgent])).toEqual([{ ...setAgent, daemonId: MEMBER }])
  })

  it('carries a set agent as PENDING while its grant is held but not yet confirmed', async () => {
    const resolver = new PlacementResolver({ duties: duties({ holders: [MEMBER] }), clock: systemClock })
    expect(await resolver.resolveDirectory([setAgent])).toEqual([{ ...setAgent, daemonId: null }])
  })

  it('carries a lapsed set agent as PENDING while a live member could claim it', async () => {
    const resolver = new PlacementResolver({
      duties: duties(),
      liveMembers: async (setId) => (setId === SET ? [MEMBER] : []),
      clock: systemClock
    })
    expect(await resolver.resolveDirectory([setAgent])).toEqual([{ ...setAgent, daemonId: null }])
  })

  it('drops a set agent with no holder and no live member — nothing can serve it', async () => {
    const resolver = new PlacementResolver({ duties: duties(), liveMembers: async () => [], clock: systemClock })
    expect(await resolver.resolveDirectory([setAgent])).toEqual([])
  })

  it('reads liveness once per set, not once per row', async () => {
    let calls = 0
    const resolver = new PlacementResolver({
      duties: duties(),
      liveMembers: async () => {
        calls += 1
        return [MEMBER]
      },
      clock: systemClock
    })
    const rows = [setAgent, { ...setAgent, agentId: '00000000-0000-0000-0000-00000000000b' }]
    expect(await resolver.resolveDirectory(rows)).toHaveLength(2)
    expect(calls).toBe(1)
  })

  it('a machine placement is routable from the column alone, and an unplaced row is dropped', async () => {
    const resolver = new PlacementResolver({ duties: duties(), liveMembers: async () => [MEMBER], clock: systemClock })
    expect(await resolver.resolveDirectory([machineAgent, unplaced])).toEqual([machineAgent])
  })
})
