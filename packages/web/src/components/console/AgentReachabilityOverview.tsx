'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { Agent, DaemonRow } from '@/lib/data'
import { agentLabel, effectiveAgentStatus, status } from '@/lib/data'
import {
  buildAgentReachabilityGraph,
  reachabilityNeighborhood,
  type AgentReachabilityGraph
} from '@/lib/agent-reachability'
import { useOrgs } from '@/lib/org-context'
import { AgentIconView, LoadingState } from '@/components/marks'

const NODE_WIDTH = 196
const NODE_HEIGHT = 66
const NODE_GAP = 18
const COMPONENT_GAP = 42
const LAYER_GAP = 124
const COLUMN_GAP = 72
const GRAPH_PADDING = 36

interface PositionedNode {
  agentId: string
  x: number
  y: number
}

interface ReachabilityLayout {
  width: number
  height: number
  nodes: Map<string, PositionedNode>
}

interface LayerPlan {
  components: AgentReachabilityGraph['components']
  columns: string[][]
  width: number
  height: number
}

/**
 * A single-column layer keeps the original stacked look (with component gaps);
 * a crowded layer wraps into balanced sub-columns so shallow-but-wide
 * topologies (many roots, one large mutual group) grow sideways rather than
 * into one tall column.
 */
function planLayer(components: AgentReachabilityGraph['components']): LayerPlan {
  const agentIds = components.flatMap((component) => component.agentIds)
  const rowCap = Math.max(3, Math.ceil(Math.sqrt(agentIds.length * 1.2)))
  const columnCount = Math.ceil(agentIds.length / rowCap)

  if (columnCount <= 1) {
    const height = components.reduce(
      (total, component, index) =>
        total +
        component.agentIds.length * NODE_HEIGHT +
        Math.max(0, component.agentIds.length - 1) * NODE_GAP +
        (index === 0 ? 0 : COMPONENT_GAP),
      0
    )
    return { components, columns: [agentIds], width: NODE_WIDTH, height }
  }

  const rows = Math.ceil(agentIds.length / columnCount)
  const columns: string[][] = []
  for (let index = 0; index < agentIds.length; index += rows) {
    columns.push(agentIds.slice(index, index + rows))
  }
  return {
    components,
    columns,
    width: columnCount * NODE_WIDTH + (columnCount - 1) * COLUMN_GAP,
    height: rows * NODE_HEIGHT + (rows - 1) * NODE_GAP
  }
}

export function layoutGraph(graph: AgentReachabilityGraph): ReachabilityLayout {
  const layers = new Map<number, typeof graph.components>()
  for (const component of graph.components) {
    const layer = layers.get(component.layer) ?? []
    layer.push(component)
    layers.set(component.layer, layer)
  }

  const orderedLayers = [...layers.keys()].sort((a, b) => a - b)
  const plans = orderedLayers.map((layer) => planLayer(layers.get(layer)!))
  const contentHeight = Math.max(248, ...plans.map((plan) => plan.height))
  const nodes = new Map<string, PositionedNode>()

  let x = GRAPH_PADDING
  for (const plan of plans) {
    const yTop = GRAPH_PADDING + (contentHeight - plan.height) / 2
    if (plan.columns.length === 1) {
      let y = yTop
      for (const component of plan.components) {
        for (const agentId of component.agentIds) {
          nodes.set(agentId, { agentId, x, y })
          y += NODE_HEIGHT + NODE_GAP
        }
        y += COMPONENT_GAP - NODE_GAP
      }
    } else {
      plan.columns.forEach((column, columnIndex) => {
        column.forEach((agentId, rowIndex) => {
          nodes.set(agentId, {
            agentId,
            x: x + columnIndex * (NODE_WIDTH + COLUMN_GAP),
            y: yTop + rowIndex * (NODE_HEIGHT + NODE_GAP)
          })
        })
      })
    }
    x += plan.width + LAYER_GAP
  }

  return {
    width: Math.max(680, x - LAYER_GAP + GRAPH_PADDING),
    height: contentHeight + GRAPH_PADDING * 2,
    nodes
  }
}

function edgePath(source: PositionedNode, target: PositionedNode): string {
  const startY = source.y + NODE_HEIGHT / 2
  const endY = target.y + NODE_HEIGHT / 2

  if (source.x === target.x) {
    const sourceAbove = source.y < target.y
    const startX = sourceAbove ? source.x + NODE_WIDTH : source.x
    const endX = startX
    const bendX = sourceAbove ? startX + 48 : startX - 48
    return `M ${startX} ${startY} C ${bendX} ${startY}, ${bendX} ${endY}, ${endX} ${endY}`
  }

  if (source.x < target.x) {
    const startX = source.x + NODE_WIDTH
    const endX = target.x
    const curve = Math.max(48, (endX - startX) / 2)
    // A gap wider than a node means the edge skips over a column — bow it
    // upward so it skims between rows instead of crossing the nodes.
    const bow = endX - startX > NODE_WIDTH ? -56 : 0
    return `M ${startX} ${startY} C ${startX + curve} ${startY + bow}, ${endX - curve} ${endY + bow}, ${endX} ${endY}`
  }

  // Backward edge (a cycle member placed in an earlier column): leave the
  // source's left edge and enter the target's right edge so the curve stays in
  // the gutters, bowing downward when it skips over a column.
  const startX = source.x
  const endX = target.x + NODE_WIDTH
  const curve = Math.max(48, (startX - endX) / 2)
  const bow = startX - endX > NODE_WIDTH ? 56 : 0
  return `M ${startX} ${startY} C ${startX - curve} ${startY + bow}, ${endX + curve} ${endY + bow}, ${endX} ${endY}`
}

export function AgentReachabilityOverview({
  agents,
  daemons,
  loading,
  compact = false
}: {
  agents: Agent[]
  daemons: DaemonRow[]
  loading: boolean
  compact?: boolean
}) {
  const { orgPath } = useOrgs()
  const [focusAgentId, setFocusAgentId] = useState('')
  const [focusCycleComponentId, setFocusCycleComponentId] = useState<number | null>(null)
  const graph = useMemo(() => buildAgentReachabilityGraph(agents), [agents])
  const layout = useMemo(() => layoutGraph(graph), [graph])
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const orderedAgents = useMemo(() => [...agents].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b))), [agents])
  const cycleComponents = useMemo(() => graph.components.filter((component) => component.cyclic), [graph.components])

  useEffect(() => {
    if (focusAgentId && !agentById.has(focusAgentId)) setFocusAgentId('')
  }, [agentById, focusAgentId])

  useEffect(() => {
    if (
      focusCycleComponentId !== null &&
      !cycleComponents.some((component) => component.id === focusCycleComponentId)
    ) {
      setFocusCycleComponentId(null)
    }
  }, [cycleComponents, focusCycleComponentId])

  const neighborhood = useMemo(
    () => (focusAgentId ? reachabilityNeighborhood(graph, focusAgentId) : null),
    [focusAgentId, graph]
  )
  const relatedAgentIds = useMemo(() => {
    if (!focusAgentId || !neighborhood) return null
    return new Set([focusAgentId, ...neighborhood.upstreamAgentIds, ...neighborhood.downstreamAgentIds])
  }, [focusAgentId, neighborhood])
  const focusedCycleAgentIds = useMemo(() => {
    if (focusCycleComponentId === null) return null
    const component = cycleComponents.find((candidate) => candidate.id === focusCycleComponentId)
    return component ? new Set(component.agentIds) : null
  }, [cycleComponents, focusCycleComponentId])
  const highlightedAgentIds = relatedAgentIds ?? focusedCycleAgentIds
  const cycleCount = cycleComponents.length
  const rootCount = graph.agentIds.filter((agentId) => graph.incomingByAgentId.get(agentId)?.length === 0).length

  if (loading && agents.length === 0) {
    return (
      <div className={compact ? 'mx-4' : ''}>
        <div className="card">
          <LoadingState />
        </div>
      </div>
    )
  }

  if (agents.length === 0) {
    return (
      <div className={compact ? 'mx-4' : ''}>
        <div className="card px-4 py-10 text-center">
          <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            No agents to map yet
          </div>
          <div className="mt-1 font-sans text-[13px] font-normal leading-[1.5] text-(--text-tertiary)">
            Add an agent to start building the topology.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={compact ? 'mx-4 pb-6' : ''}>
      <div className="mb-[14px] grid grid-cols-2 gap-3 desktop:grid-cols-4 desktop:gap-[14px]">
        {[
          { label: 'Visible agents', value: agents.length },
          { label: 'Direct paths', value: graph.edges.length },
          { label: 'Root agents', value: rootCount },
          { label: 'Cycle groups', value: cycleCount }
        ].map((metric) => (
          <div key={metric.label} className="card stat">
            <div className="statlbl">{metric.label}</div>
            <div className="statval">{metric.value}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-(--border-subtle) px-4 py-3 desktop:flex-row desktop:items-center desktop:justify-between">
          <div className="min-w-0">
            <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
              Configured topology
            </div>
            <div className="mt-1 font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
              Each arrow is a direct path allowed by both agents. Follow arrows for transitive reachability.
            </div>
          </div>
          <label className="flex flex-none items-center gap-2">
            <span className="font-sans text-[12px] font-medium leading-normal text-(--text-secondary)">Focus</span>
            <select
              value={focusAgentId}
              onChange={(event) => {
                setFocusAgentId(event.target.value)
                setFocusCycleComponentId(null)
              }}
              className="h-8 min-w-[180px] rounded-md border border-(--border-subtle) bg-(--surface-card) px-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) outline-none focus:border-(--brand)"
            >
              <option value="">All agents</option>
              {orderedAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agentLabel(agent)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-2 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          <span className="flex items-center gap-[6px]">
            <span className="h-px w-7 bg-(--text-tertiary)" />
            direct call path
          </span>
          <span>Availability and channel membership may further limit delivery.</span>
        </div>

        <div className="overflow-auto bg-(--surface-app)">
          <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
            <svg
              aria-hidden="true"
              className="absolute inset-0"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              <defs>
                <marker
                  id="reachability-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)" />
                </marker>
                <marker
                  id="reachability-arrow-active"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--brand)" />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const source = layout.nodes.get(edge.fromAgentId)!
                const target = layout.nodes.get(edge.toAgentId)!
                const active = highlightedAgentIds?.has(edge.fromAgentId) && highlightedAgentIds.has(edge.toAgentId)
                const dimmed = highlightedAgentIds !== null && !active
                return (
                  <path
                    key={`${edge.fromAgentId}:${edge.toAgentId}`}
                    d={edgePath(source, target)}
                    fill="none"
                    stroke={active ? 'var(--brand)' : 'var(--text-tertiary)'}
                    strokeWidth={active ? 1.8 : 1.25}
                    strokeOpacity={dimmed ? 0.14 : active ? 0.9 : 0.48}
                    markerEnd={active ? 'url(#reachability-arrow-active)' : 'url(#reachability-arrow)'}
                  />
                )
              })}
            </svg>

            {graph.agentIds.map((agentId) => {
              const agent = agentById.get(agentId)!
              const node = layout.nodes.get(agentId)!
              const owningDaemon = daemons.find((daemon) => daemon.daemonId === agent.daemon)
              const agentStatus = status(effectiveAgentStatus(agent.status, owningDaemon))
              const isFocus = focusAgentId === agentId
              const isFocusedCycleMember = focusedCycleAgentIds?.has(agentId) ?? false
              const dimmed = highlightedAgentIds !== null && !highlightedAgentIds.has(agentId)
              const incoming = graph.incomingByAgentId.get(agentId)?.length ?? 0
              const outgoing = graph.outgoingByAgentId.get(agentId)?.length ?? 0
              return (
                <Link
                  key={agentId}
                  href={orgPath(`/agents/${agentId}`)}
                  aria-label={`Open ${agentLabel(agent)}. ${incoming} incoming and ${outgoing} outgoing direct paths.`}
                  title="Open agent details"
                  className={`${
                    isFocus || isFocusedCycleMember
                      ? 'absolute flex items-center gap-[10px] rounded-md border-2 border-(--brand) bg-(--brand-soft) px-[11px] py-2 no-underline shadow-(--shadow-md)'
                      : 'absolute flex items-center gap-[10px] rounded-md border border-(--border-subtle) bg-(--surface-card) px-3 py-[9px] no-underline shadow-(--shadow-xs)'
                  } ${dimmed ? 'opacity-30' : 'opacity-100'}`}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT
                  }}
                >
                  <span className="relative flex h-9 w-9 flex-none items-center justify-center rounded-sm border border-(--border-subtle) bg-(--surface-sunken) [&>svg]:h-full [&>svg]:w-full">
                    <AgentIconView icon={agent.icon} runtime={agent.runtime} size={36} />
                    <span
                      className="absolute -right-[3px] -bottom-[3px] h-[10px] w-[10px] rounded-full border-2 border-(--surface-card)"
                      style={{ background: agentStatus.dot }}
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      {agentLabel(agent)}
                    </span>
                    <span className="font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                      {incoming} in · {outgoing} out
                    </span>
                  </span>
                </Link>
              )
            })}
          </div>
        </div>

        <div className="flex flex-col gap-[10px] border-t border-(--border-subtle) px-4 py-3 desktop:flex-row desktop:items-center desktop:justify-between">
          {cycleCount > 0 ? (
            <>
              <div className="min-w-0">
                <div className="font-sans text-[12px] font-semibold leading-normal text-(--text-secondary)">
                  Mutual-reachability {cycleCount === 1 ? 'group' : 'groups'}
                </div>
                <div className="mt-1 font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
                  Select a group to highlight its members and internal paths.
                </div>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Mutual-reachability groups">
                {cycleComponents.map((component, index) => {
                  const selected = focusCycleComponentId === component.id
                  const names = component.agentIds.map((agentId) => agentLabel(agentById.get(agentId)!)).join(' · ')
                  return (
                    <button
                      key={component.id}
                      type="button"
                      aria-pressed={selected}
                      title={names}
                      onClick={() => {
                        setFocusAgentId('')
                        setFocusCycleComponentId((current) => (current === component.id ? null : component.id))
                      }}
                      className={
                        selected
                          ? 'flex max-w-[280px] items-center gap-[6px] rounded-full border border-(--brand) bg-(--brand-soft) px-[10px] py-[6px] text-left text-(--brand-soft-text)'
                          : 'flex max-w-[280px] items-center gap-[6px] rounded-full border border-(--border-subtle) bg-(--surface-card) px-[10px] py-[6px] text-left text-(--text-secondary) hover:border-(--border-strong) hover:bg-(--surface-hover)'
                      }
                    >
                      <span className="flex-none font-mono text-[10px] font-semibold leading-normal">
                        Group {index + 1}
                      </span>
                      <span className="truncate font-sans text-[11px] font-normal leading-normal">{names}</span>
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
              No mutual-reachability groups detected in the current graph.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
