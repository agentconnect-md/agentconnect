import { describe, it, expect } from 'vitest'
import {
  computeDutyComponents,
  planDutyReconcile,
  type ComputedComponent,
  type DutyMemberKey,
  type ExistingDutyGroup
} from './dutyGroup.js'

const agent = (id: string): DutyMemberKey => ({ kind: 'agent', refId: id })
const bot = (id: string): DutyMemberKey => ({ kind: 'bot', refId: id })
const comp = (...members: DutyMemberKey[]): ComputedComponent => ({ members })

describe('computeDutyComponents', () => {
  it('joins an agent with its bots into one component', () => {
    const out = computeDutyComponents(
      [
        { agentId: 'a1', botId: 'b1' },
        { agentId: 'a1', botId: 'b2' }
      ],
      []
    )
    expect(out).toEqual([comp(agent('a1'), bot('b1'), bot('b2'))])
  })

  it('clusters every agent of a shared bot at that bot', () => {
    const out = computeDutyComponents(
      [
        { agentId: 'a1', botId: 'shared' },
        { agentId: 'a2', botId: 'shared' },
        { agentId: 'a3', botId: 'other' }
      ],
      []
    )
    expect(out).toEqual([comp(agent('a1'), agent('a2'), bot('shared')), comp(agent('a3'), bot('other'))])
  })

  it('a shared bot transitively merges each agent’s other bots', () => {
    const out = computeDutyComponents(
      [
        { agentId: 'a1', botId: 'shared' },
        { agentId: 'a2', botId: 'shared' },
        { agentId: 'a2', botId: 'tg' }
      ],
      []
    )
    expect(out).toEqual([comp(agent('a1'), agent('a2'), bot('shared'), bot('tg'))])
  })

  it('every agent seeds a component; a botless one gets a singleton', () => {
    const out = computeDutyComponents([{ agentId: 'a1', botId: 'b1' }], [{ agentId: 'lone' }, { agentId: 'a1' }])
    expect(out).toEqual([comp(agent('a1'), bot('b1')), comp(agent('lone'))])
  })

  it('an agent listed after its edge keeps the merged component, not a duplicate singleton', () => {
    const out = computeDutyComponents(
      [
        { agentId: 'a1', botId: 'shared' },
        { agentId: 'a2', botId: 'shared' }
      ],
      [{ agentId: 'a1' }, { agentId: 'a2' }, { agentId: 'a3' }]
    )
    expect(out).toEqual([comp(agent('a1'), agent('a2'), bot('shared')), comp(agent('a3'))])
  })

  it('is deterministic regardless of input order', () => {
    const edges = [
      { agentId: 'a2', botId: 'b2' },
      { agentId: 'a1', botId: 'b1' }
    ]
    expect(computeDutyComponents(edges, [])).toEqual(computeDutyComponents([...edges].reverse(), []))
  })

  it('dedupes repeated edges', () => {
    const out = computeDutyComponents(
      [
        { agentId: 'a1', botId: 'b1' },
        { agentId: 'a1', botId: 'b1' }
      ],
      []
    )
    expect(out).toEqual([comp(agent('a1'), bot('b1'))])
  })
})

const held = (groupId: string, holder: string, ...members: DutyMemberKey[]): ExistingDutyGroup => ({
  groupId,
  held: true,
  holder,
  members
})
const vacant = (groupId: string, ...members: DutyMemberKey[]): ExistingDutyGroup => ({
  groupId,
  held: false,
  holder: null,
  members
})

describe('planDutyReconcile', () => {
  it('reports identical composition as unchanged', () => {
    const plan = planDutyReconcile([held('g1', 'm1', agent('a1'), bot('b1'))], [comp(agent('a1'), bot('b1'))])
    expect(plan).toEqual({ unchanged: ['g1'], writes: [], creates: [], deletes: [], superseded: [] })
  })

  it('creates a vacant group for a brand-new component', () => {
    const plan = planDutyReconcile([], [comp(agent('a1'), bot('b1'))])
    expect(plan.creates).toEqual([{ members: [agent('a1'), bot('b1')], grantTo: null }])
  })

  it('re-grants the same holder when a held group gains a bot (no eviction)', () => {
    const plan = planDutyReconcile(
      [held('g1', 'm1', agent('a1'), bot('b1'))],
      [comp(agent('a1'), bot('b1'), bot('b2'))]
    )
    expect(plan.writes).toEqual([{ groupId: 'g1', members: [agent('a1'), bot('b1'), bot('b2')], regrantTo: 'm1' }])
    expect(plan.superseded).toEqual([])
  })

  it('rewrites a vacant group without a grant', () => {
    const plan = planDutyReconcile([vacant('g1', agent('a1'), bot('b1'))], [comp(agent('a1'), bot('b1'), bot('b2'))])
    expect(plan.writes).toEqual([{ groupId: 'g1', members: [agent('a1'), bot('b1'), bot('b2')], regrantTo: null }])
  })

  it('merge: the larger held group keeps the merged group; the other holder is superseded', () => {
    const plan = planDutyReconcile(
      [held('gBig', 'mBig', agent('a1'), agent('a2'), bot('shared')), held('gSmall', 'mSmall', agent('a3'), bot('tg'))],
      [comp(agent('a1'), agent('a2'), agent('a3'), bot('shared'), bot('tg'))]
    )
    expect(plan.writes).toEqual([
      { groupId: 'gBig', members: [agent('a1'), agent('a2'), agent('a3'), bot('shared'), bot('tg')], regrantTo: 'mBig' }
    ])
    expect(plan.deletes).toEqual(['gSmall'])
    expect(plan.superseded).toEqual([{ groupId: 'gSmall', holder: 'mSmall' }])
  })

  it('merge tie on size breaks to the lower groupId', () => {
    const plan = planDutyReconcile(
      [held('g2', 'm2', agent('a2'), bot('b2')), held('g1', 'm1', agent('a1'), bot('b1'))],
      [comp(agent('a1'), agent('a2'), bot('b1'), bot('b2'))]
    )
    expect(plan.writes[0]!.groupId).toBe('g1')
    expect(plan.writes[0]!.regrantTo).toBe('m1')
    expect(plan.superseded).toEqual([{ groupId: 'g2', holder: 'm2' }])
  })

  it('merge of two groups held by the SAME member supersedes nobody', () => {
    const plan = planDutyReconcile(
      [held('g1', 'm1', agent('a1'), bot('b1')), held('g2', 'm1', agent('a2'), bot('b2'))],
      [comp(agent('a1'), agent('a2'), bot('b1'), bot('b2'))]
    )
    expect(plan.deletes).toEqual(['g2'])
    expect(plan.superseded).toEqual([])
  })

  it('a held group beats a larger vacant group for the merged identity', () => {
    const plan = planDutyReconcile(
      [vacant('gVac', agent('a1'), agent('a2'), bot('b1')), held('gHeld', 'm1', agent('a3'), bot('b2'))],
      [comp(agent('a1'), agent('a2'), agent('a3'), bot('b1'), bot('b2'))]
    )
    expect(plan.writes[0]).toMatchObject({ groupId: 'gHeld', regrantTo: 'm1' })
    expect(plan.deletes).toEqual(['gVac'])
  })

  it('split: the id and holder follow the larger fragment; the remainder inherits the holder', () => {
    const plan = planDutyReconcile(
      [held('g1', 'm1', agent('a1'), agent('a2'), bot('shared'), bot('tg'))],
      [comp(agent('a1'), agent('a2'), bot('shared')), comp(bot('tg'))]
    )
    expect(plan.writes).toEqual([
      { groupId: 'g1', members: [agent('a1'), agent('a2'), bot('shared')], regrantTo: 'm1' }
    ])
    expect(plan.creates).toEqual([{ members: [bot('tg')], grantTo: 'm1' }])
    expect(plan.superseded).toEqual([])
  })

  it('a fragment fed by two different held groups is created vacant', () => {
    const plan = planDutyReconcile(
      [held('g1', 'm1', agent('a1'), bot('b1'), bot('x1')), held('g2', 'm2', agent('a2'), bot('b2'), bot('x2'))],
      [comp(agent('a1'), bot('b1')), comp(agent('a2'), bot('b2')), comp(agent('a3'), bot('x1'), bot('x2'))]
    )
    expect(plan.writes.map((w) => w.groupId).sort()).toEqual(['g1', 'g2'])
    expect(plan.creates).toEqual([{ members: [agent('a3'), bot('x1'), bot('x2')], grantTo: null }])
  })

  it('deletes a group whose members all vanished and supersedes its holder', () => {
    const plan = planDutyReconcile([held('g1', 'm1', agent('a1'), bot('b1'))], [])
    expect(plan.deletes).toEqual(['g1'])
    expect(plan.superseded).toEqual([{ groupId: 'g1', holder: 'm1' }])
  })

  it('a vanished vacant group is deleted silently', () => {
    const plan = planDutyReconcile([vacant('g1', agent('a1'))], [])
    expect(plan).toEqual({ unchanged: [], writes: [], creates: [], deletes: ['g1'], superseded: [] })
  })

  it('is deterministic under input reordering', () => {
    const existing = [
      held('g2', 'm2', agent('a2'), bot('b2')),
      held('g1', 'm1', agent('a1'), bot('b1')),
      vacant('g3', agent('a3'))
    ]
    const components = [
      comp(agent('a1'), agent('a2'), bot('b1'), bot('b2')),
      comp(agent('a3'), bot('b3')),
      comp(agent('a4'))
    ]
    const a = planDutyReconcile(existing, components)
    const b = planDutyReconcile([...existing].reverse(), [...components].reverse())
    expect(a).toEqual(b)
  })
})
