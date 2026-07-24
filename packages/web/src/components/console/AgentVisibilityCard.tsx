'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, AgentCallPolicy, DaemonRow } from '@/lib/data'
import { agentLabel } from '@/lib/data'
import type { AgentCallPolicyInput } from '@/lib/api'
import { buildAgentReachabilityGraph } from '@/lib/agent-reachability'
import { AgentCallVisibility } from '@/components/console/AgentCallVisibility'
import { Icon } from '@/components/ui'

interface AgentVisibilityCardProps {
  agent: Agent
  agents: Agent[]
  daemons: DaemonRow[]
  onSave: (agentId: string, body: AgentCallPolicyInput) => Promise<void>
  className?: string
}

function normalizeSelected(subjectAgentId: string, ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => id !== subjectAgentId)
}

export function AgentVisibilityCard({ agent, agents, daemons, onSave, className }: AgentVisibilityCardProps) {
  const [inboundMode, setInboundMode] = useState<AgentCallPolicy>(agent.callPolicy)
  const [inboundSelected, setInboundSelected] = useState<string[]>(agent.allowedCallerAgentIds)
  const [outboundMode, setOutboundMode] = useState<AgentCallPolicy>(agent.outboundPolicy)
  const [outboundSelected, setOutboundSelected] = useState<string[]>(agent.allowedTargetAgentIds)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const syncedAgentIdRef = useRef(agent.id)
  const peers = useMemo(() => agents.filter((candidate) => candidate.id !== agent.id), [agents, agent.id])
  const reachability = useMemo(
    () =>
      buildAgentReachabilityGraph(
        agents.map((candidate) =>
          candidate.id === agent.id
            ? {
                ...candidate,
                callPolicy: inboundMode,
                allowedCallerAgentIds: inboundSelected,
                outboundPolicy: outboundMode,
                allowedTargetAgentIds: outboundSelected
              }
            : candidate
        )
      ),
    [agent.id, agents, inboundMode, inboundSelected, outboundMode, outboundSelected]
  )
  const inboundEffectivePeerIds = reachability.incomingByAgentId.get(agent.id) ?? []
  const outboundEffectivePeerIds = reachability.outgoingByAgentId.get(agent.id) ?? []
  const editable = agent.canManageSharing

  // Under `all`, retain the last local selection so toggling back to
  // `selected` restores it. A different agent always performs a hard reset.
  useEffect(() => {
    const agentChanged = syncedAgentIdRef.current !== agent.id
    syncedAgentIdRef.current = agent.id
    setInboundMode(agent.callPolicy)
    setOutboundMode(agent.outboundPolicy)
    setError(null)
    if (agent.callPolicy === 'selected' || agentChanged) setInboundSelected(agent.allowedCallerAgentIds)
    if (agent.outboundPolicy === 'selected' || agentChanged) setOutboundSelected(agent.allowedTargetAgentIds)
  }, [agent.id, agent.callPolicy, agent.allowedCallerAgentIds, agent.outboundPolicy, agent.allowedTargetAgentIds])

  const save = async (
    nextInboundMode: AgentCallPolicy,
    nextInboundSelected: string[],
    nextOutboundMode: AgentCallPolicy,
    nextOutboundSelected: string[]
  ) => {
    if (!editable || saving) return
    const previous = { inboundMode, inboundSelected, outboundMode, outboundSelected }
    const normalizedInbound = normalizeSelected(agent.id, nextInboundSelected)
    const normalizedOutbound = normalizeSelected(agent.id, nextOutboundSelected)

    setInboundMode(nextInboundMode)
    setInboundSelected(normalizedInbound)
    setOutboundMode(nextOutboundMode)
    setOutboundSelected(normalizedOutbound)
    setSaving(true)
    setError(null)

    try {
      await onSave(agent.id, {
        callPolicy: nextInboundMode,
        allowedCallerAgentIds: nextInboundMode === 'selected' ? normalizedInbound : [],
        outboundPolicy: nextOutboundMode,
        allowedTargetAgentIds: nextOutboundMode === 'selected' ? normalizedOutbound : []
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setInboundMode(previous.inboundMode)
      setInboundSelected(previous.inboundSelected)
      setOutboundMode(previous.outboundMode)
      setOutboundSelected(previous.outboundSelected)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div aria-busy={saving} className={`card relative max-desktop:rounded-lg${className ? ` ${className}` : ''}`}>
      <div className="flex items-start justify-between gap-3 border-b border-(--border-subtle) px-4 py-3 desktop:py-[13px]">
        <div className="min-w-0">
          <div className="font-sans text-[14px] font-semibold leading-normal">Agent visibility</div>
          <div className="mt-1 max-w-[520px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
            Set each direction separately. A direct path appears only when the peer allows the matching direction.
          </div>
        </div>
        {saving && (
          <span className="flex flex-none items-center gap-[6px] pt-[2px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
            <Icon name="loader-circle" size={13} className="animate-spin" />
            Saving
          </span>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-3 p-4">
        <AgentCallVisibility
          variant="section"
          direction="inbound"
          mode={inboundMode}
          selectedIds={inboundSelected}
          effectivePeerIds={inboundEffectivePeerIds}
          peers={peers}
          daemons={daemons}
          target={<span className="font-mono text-[12.5px]">{agentLabel(agent)}</span>}
          editable={editable}
          busy={saving}
          onChange={(mode, selectedIds) => void save(mode, selectedIds, outboundMode, outboundSelected)}
        />
        <AgentCallVisibility
          variant="section"
          direction="outbound"
          mode={outboundMode}
          selectedIds={outboundSelected}
          effectivePeerIds={outboundEffectivePeerIds}
          peers={peers}
          daemons={daemons}
          target={<span className="font-mono text-[12.5px]">{agentLabel(agent)}</span>}
          editable={editable}
          busy={saving}
          onChange={(mode, selectedIds) => void save(inboundMode, inboundSelected, mode, selectedIds)}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="border-t border-(--border-subtle) px-4 py-2 font-sans text-[12px] font-medium leading-normal text-(--status-error)"
        >
          {error}
        </div>
      )}
    </div>
  )
}
