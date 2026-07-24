import type { AgentCallPolicy } from '@/lib/data'

export interface ReachabilityAgentPolicy {
  id: string
  callPolicy: AgentCallPolicy
  allowedCallerAgentIds: string[]
  outboundPolicy: AgentCallPolicy
  allowedTargetAgentIds: string[]
}

export interface ReachabilityEdge {
  fromAgentId: string
  toAgentId: string
}

export interface ReachabilityComponent {
  id: number
  agentIds: string[]
  cyclic: boolean
  layer: number
}

export interface AgentReachabilityGraph {
  agentIds: string[]
  edges: ReachabilityEdge[]
  components: ReachabilityComponent[]
  componentByAgentId: Map<string, number>
  incomingByAgentId: Map<string, string[]>
  outgoingByAgentId: Map<string, string[]>
}

function policyAllows(policy: AgentCallPolicy, selectedIds: ReadonlySet<string>, peerAgentId: string): boolean {
  return policy === 'all' || selectedIds.has(peerAgentId)
}

/**
 * Build the configured direct-call graph over the supplied, already-visible
 * agents. A→B exists only when A's outbound policy admits B and B's inbound
 * policy admits A. Runtime placement/channel availability is intentionally not
 * part of this control-plane projection.
 */
export function buildAgentReachabilityGraph(agents: ReachabilityAgentPolicy[]): AgentReachabilityGraph {
  const uniqueAgents = [...new Map(agents.map((agent) => [agent.id, agent])).values()]
  const agentIds = uniqueAgents.map((agent) => agent.id)
  const indexByAgentId = new Map(agentIds.map((id, index) => [id, index]))
  const outgoingByAgentId = new Map(agentIds.map((id) => [id, [] as string[]]))
  const incomingByAgentId = new Map(agentIds.map((id) => [id, [] as string[]]))
  const inboundSelectionsByAgentId = new Map(
    uniqueAgents.map((agent) => [agent.id, new Set(agent.allowedCallerAgentIds)])
  )
  const outboundSelectionsByAgentId = new Map(
    uniqueAgents.map((agent) => [agent.id, new Set(agent.allowedTargetAgentIds)])
  )
  const edges: ReachabilityEdge[] = []

  for (const source of uniqueAgents) {
    for (const target of uniqueAgents) {
      if (source.id === target.id) continue
      if (!policyAllows(source.outboundPolicy, outboundSelectionsByAgentId.get(source.id)!, target.id)) continue
      if (!policyAllows(target.callPolicy, inboundSelectionsByAgentId.get(target.id)!, source.id)) continue
      edges.push({ fromAgentId: source.id, toAgentId: target.id })
      outgoingByAgentId.get(source.id)!.push(target.id)
      incomingByAgentId.get(target.id)!.push(source.id)
    }
  }

  // Tarjan's algorithm finds mutually reachable groups. These are the cycles
  // that prevent the configured graph itself from always being a DAG.
  let nextIndex = 0
  const indexes = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const rawComponents: string[][] = []

  const visit = (agentId: string) => {
    indexes.set(agentId, nextIndex)
    lowLinks.set(agentId, nextIndex)
    nextIndex += 1
    stack.push(agentId)
    onStack.add(agentId)

    for (const targetId of outgoingByAgentId.get(agentId) ?? []) {
      if (!indexes.has(targetId)) {
        visit(targetId)
        lowLinks.set(agentId, Math.min(lowLinks.get(agentId)!, lowLinks.get(targetId)!))
      } else if (onStack.has(targetId)) {
        lowLinks.set(agentId, Math.min(lowLinks.get(agentId)!, indexes.get(targetId)!))
      }
    }

    if (lowLinks.get(agentId) !== indexes.get(agentId)) return
    const component: string[] = []
    while (stack.length > 0) {
      const memberId = stack.pop()!
      onStack.delete(memberId)
      component.push(memberId)
      if (memberId === agentId) break
    }
    component.sort((a, b) => indexByAgentId.get(a)! - indexByAgentId.get(b)!)
    rawComponents.push(component)
  }

  for (const agentId of agentIds) {
    if (!indexes.has(agentId)) visit(agentId)
  }

  rawComponents.sort(
    (a, b) => Math.min(...a.map((id) => indexByAgentId.get(id)!)) - Math.min(...b.map((id) => indexByAgentId.get(id)!))
  )
  const componentByAgentId = new Map<string, number>()
  rawComponents.forEach((component, componentId) => {
    for (const agentId of component) componentByAgentId.set(agentId, componentId)
  })

  // Condense SCCs into a real DAG and assign each group a left-to-right layer
  // using the longest predecessor path.
  const componentOutgoing = rawComponents.map(() => new Set<number>())
  const componentIndegree = rawComponents.map(() => 0)
  for (const edge of edges) {
    const sourceComponent = componentByAgentId.get(edge.fromAgentId)!
    const targetComponent = componentByAgentId.get(edge.toAgentId)!
    if (sourceComponent === targetComponent || componentOutgoing[sourceComponent]!.has(targetComponent)) continue
    componentOutgoing[sourceComponent]!.add(targetComponent)
    componentIndegree[targetComponent] = componentIndegree[targetComponent]! + 1
  }

  const layerByComponent = rawComponents.map(() => 0)
  const componentOrder = rawComponents.map((_, id) => id)
  const queue = componentOrder.filter((id) => componentIndegree[id] === 0)
  while (queue.length > 0) {
    queue.sort((a, b) => a - b)
    const componentId = queue.shift()!
    for (const targetId of componentOutgoing[componentId]!) {
      layerByComponent[targetId] = Math.max(layerByComponent[targetId]!, layerByComponent[componentId]! + 1)
      componentIndegree[targetId] = componentIndegree[targetId]! - 1
      if (componentIndegree[targetId] === 0) queue.push(targetId)
    }
  }

  const components = rawComponents.map((agentIdsInComponent, id) => ({
    id,
    agentIds: agentIdsInComponent,
    cyclic: agentIdsInComponent.length > 1,
    layer: layerByComponent[id]!
  }))

  return { agentIds, edges, components, componentByAgentId, incomingByAgentId, outgoingByAgentId }
}

function traverse(startAgentId: string, adjacency: Map<string, string[]>): Set<string> {
  const visited = new Set<string>([startAgentId])
  const pending = [...(adjacency.get(startAgentId) ?? [])]
  while (pending.length > 0) {
    const agentId = pending.pop()!
    if (visited.has(agentId)) continue
    visited.add(agentId)
    pending.push(...(adjacency.get(agentId) ?? []))
  }
  visited.delete(startAgentId)
  return visited
}

export function reachabilityNeighborhood(
  graph: AgentReachabilityGraph,
  focusAgentId: string
): { upstreamAgentIds: Set<string>; downstreamAgentIds: Set<string> } {
  return {
    upstreamAgentIds: traverse(focusAgentId, graph.incomingByAgentId),
    downstreamAgentIds: traverse(focusAgentId, graph.outgoingByAgentId)
  }
}
