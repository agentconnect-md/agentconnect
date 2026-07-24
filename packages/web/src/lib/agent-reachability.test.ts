import { describe, expect, it } from 'vitest'
import {
  buildAgentReachabilityGraph,
  reachabilityNeighborhood,
  type ReachabilityAgentPolicy
} from './agent-reachability'

const selected = (id: string, overrides: Partial<ReachabilityAgentPolicy> = {}): ReachabilityAgentPolicy => ({
  id,
  callPolicy: 'selected',
  allowedCallerAgentIds: [],
  outboundPolicy: 'selected',
  allowedTargetAgentIds: [],
  ...overrides
})

describe('agent reachability graph', () => {
  it('requires both source outbound and target inbound admission', () => {
    const graph = buildAgentReachabilityGraph([
      selected('a', { allowedTargetAgentIds: ['b', 'c'] }),
      selected('b', { allowedCallerAgentIds: ['a'] }),
      selected('c')
    ])

    expect(graph.edges).toEqual([{ fromAgentId: 'a', toAgentId: 'b' }])
  })

  it('treats all/all defaults as a complete directed graph', () => {
    const all = (id: string): ReachabilityAgentPolicy => ({
      id,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
    const graph = buildAgentReachabilityGraph([all('a'), all('b'), all('c')])

    expect(graph.edges).toHaveLength(6)
    expect(graph.components).toEqual([{ id: 0, agentIds: ['a', 'b', 'c'], cyclic: true, layer: 0 }])
  })

  it('layers the condensed graph from callers to targets', () => {
    const graph = buildAgentReachabilityGraph([
      selected('a', { allowedTargetAgentIds: ['b'] }),
      selected('b', { allowedCallerAgentIds: ['a'], allowedTargetAgentIds: ['c'] }),
      selected('c', { allowedCallerAgentIds: ['b'] })
    ])

    expect(graph.edges).toEqual([
      { fromAgentId: 'a', toAgentId: 'b' },
      { fromAgentId: 'b', toAgentId: 'c' }
    ])
    expect(graph.components.map(({ agentIds, cyclic, layer }) => ({ agentIds, cyclic, layer }))).toEqual([
      { agentIds: ['a'], cyclic: false, layer: 0 },
      { agentIds: ['b'], cyclic: false, layer: 1 },
      { agentIds: ['c'], cyclic: false, layer: 2 }
    ])
  })

  it('condenses a cycle before layering its downstream agents', () => {
    const graph = buildAgentReachabilityGraph([
      selected('a', { allowedCallerAgentIds: ['b'], allowedTargetAgentIds: ['b'] }),
      selected('b', { allowedCallerAgentIds: ['a'], allowedTargetAgentIds: ['a', 'c'] }),
      selected('c', { allowedCallerAgentIds: ['b'] })
    ])

    expect(graph.components.map(({ agentIds, cyclic, layer }) => ({ agentIds, cyclic, layer }))).toEqual([
      { agentIds: ['a', 'b'], cyclic: true, layer: 0 },
      { agentIds: ['c'], cyclic: false, layer: 1 }
    ])
  })

  it('finds transitive upstream and downstream reachability for a focus agent', () => {
    const graph = buildAgentReachabilityGraph([
      selected('a', { allowedTargetAgentIds: ['b'] }),
      selected('b', { allowedCallerAgentIds: ['a'], allowedTargetAgentIds: ['c'] }),
      selected('c', { allowedCallerAgentIds: ['b'], allowedTargetAgentIds: ['d'] }),
      selected('d', { allowedCallerAgentIds: ['c'] })
    ])

    const neighborhood = reachabilityNeighborhood(graph, 'c')
    expect([...neighborhood.upstreamAgentIds]).toEqual(expect.arrayContaining(['a', 'b']))
    expect([...neighborhood.downstreamAgentIds]).toEqual(['d'])
  })

  it('does not include the focused agent in either side of a cycle neighborhood', () => {
    const graph = buildAgentReachabilityGraph([
      selected('a', { allowedCallerAgentIds: ['b'], allowedTargetAgentIds: ['b'] }),
      selected('b', { allowedCallerAgentIds: ['a'], allowedTargetAgentIds: ['a'] })
    ])

    const neighborhood = reachabilityNeighborhood(graph, 'a')
    expect([...neighborhood.upstreamAgentIds]).toEqual(['b'])
    expect([...neighborhood.downstreamAgentIds]).toEqual(['b'])
  })
})
