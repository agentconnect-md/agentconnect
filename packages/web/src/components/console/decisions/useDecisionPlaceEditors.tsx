'use client'

// Opens each Decision place's own editor where it is listed: gate and routing rules modals, and Edit agent for a model.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import type { AgentApiProtocol } from '@agentconnect.md/protocol'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import { agentLabel, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { consoleKeys } from '@/lib/swr-keys'
import { fetchAgentApiEntries, setAgentApiGate } from '@/lib/api'
import { apiProtocolLabel } from '@/lib/agent-api'
import type { SavedGate } from '@/lib/decisions/binding'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { apiGateEvaluations } from '@/lib/decisions/evaluation-source'
import { apiGateTry } from '@/lib/decisions/try-source'
import { codeHostScopeId, routingTargets, useCodeHostRoutings } from '@/lib/decisions/code-host-routing'
import { useOptionalModal } from '@/components/console/ModalProvider'
import { apiGateKey } from '@/components/console/AgentApiCard'
import { useChannelGates } from './channel-gates'
import { DecisionBindingStrip, editDraftFor } from './DecisionBindingStrip'
import { usageKey } from './DecisionUsedIn'
import { CodeHostDecisionModal } from './routing/CodeHostDecisionModal'
import { DecisionRoutingModal, clearRoutingResume, readRoutingResume } from './routing/DecisionRoutingModal'

// An agent's chat API gate: its entries are read on demand, then the saved gate opens as a draft.
function ApiGateEditor({
  agent,
  protocol,
  requested,
  onDone
}: {
  agent: Agent
  protocol: AgentApiProtocol
  requested: boolean
  onDone: () => void
}) {
  const { api, orgId, decisions, bindingDrafts, setBindingDraft } = useDecisionsPrototype()
  const key = apiGateKey(orgId, agent.id, protocol)
  const { data, error, mutate } = useSWR(consoleKeys.agentApi(orgId, agent.id), ([, org, , agentId]) =>
    fetchAgentApiEntries(agentId, org)
  )
  const gate = data?.find((entry) => entry.protocol === protocol)?.gate
  const saved: SavedGate | null = gate ? (({ type: _type, ...rest }) => rest)(gate) : null
  const draft = bindingDrafts[key]
  // Closing the modal drops the draft; once it has been open, that is the editor's end.
  const opened = useRef(!!draft)
  useEffect(() => {
    if (draft) {
      opened.current = true
      return
    }
    if (opened.current || error || (data && !saved)) return onDone()
    if (requested && saved) {
      const decision = decisions.find((entry) => entry.id === saved.decisionId) ?? null
      setBindingDraft(key, (current) => current ?? editDraftFor(saved, decision))
    }
  }, [draft, data, error, saved, requested, key, decisions, setBindingDraft, onDone])
  return (
    <DecisionBindingStrip
      bindingKey={key}
      conversation={null}
      canWrite={agent.canEdit}
      agentName={agentLabel(agent)}
      channelName={apiProtocolLabel(protocol)}
      padX={0}
      saved={saved}
      status={null}
      surface="api"
      {...(agent.canEdit
        ? {
            evaluations: apiGateEvaluations(api, orgId, agent.id, protocol),
            trySource: apiGateTry(api, orgId, agent.id, protocol)
          }
        : {})}
      onSave={async (next) => {
        await setAgentApiGate(agent.id, protocol, next)
        await mutate()
      }}
    />
  )
}

// A repository routing's rules modal, once its scope's routing and members are read.
function CodeHostEditor({ usage, onClose }: { usage: DecisionUsage; onClose: () => void }) {
  const t = useTranslations('Decisions.routing')
  const { agents } = useConsoleData()
  // Only a mock read names the repository from the scope; the CP returns its own.
  const scope = { provider: usage.provider!, repoId: usage.repoId!, family: usage.family!, repoFullName: usage.label }
  const { routings, loading } = useCodeHostRoutings([scope])
  const routing = routings[codeHostScopeId(scope)]
  useEffect(() => {
    if (!loading && !routing) onClose()
  }, [loading, routing, onClose])
  if (!routing) return null
  return (
    <CodeHostDecisionModal
      routing={routing}
      agents={routingTargets(
        routing.members,
        (id) => agents.find((agent) => agent.id === id),
        undefined,
        t('codeHost.hiddenAgent')
      )}
      onClose={onClose}
    />
  )
}

/** Which places open an editor here, how to open one, and the editors to render; `onChanged` re-reads the usages. */
export function useDecisionPlaceEditors({ usages, onChanged }: { usages: DecisionUsage[]; onChanged: () => void }): {
  editable: (usage: DecisionUsage) => boolean
  edit: (usage: DecisionUsage) => void
  editors: ReactNode
} {
  const { integrations, agents } = useConsoleData()
  const modal = useOptionalModal()
  const gates = useChannelGates()
  const { orgId, bindingDrafts } = useDecisionsPrototype()
  const [editing, setEditing] = useState<{ key: string; resume?: boolean } | null>(null)
  const agentOf = (id: string) => agents.find((agent) => agent.id === id)
  const gateOf = (usage: DecisionUsage) => {
    if (usage.kind !== 'gate') return null
    const integration = integrations.find((row) => row.id === usage.integrationId)
    const row = integration?.channels.find((channel) => channel.channelId === usage.channelId)
    return integration && row ? { integration, row } : null
  }
  const apiKeyOf = (usage: DecisionUsage) =>
    usage.kind === 'api_gate' && usage.protocol ? apiGateKey(orgId, usage.id, usage.protocol) : null

  // An inline Create decision from a bot's rules returns naming no row; its modal reopens on the kept draft.
  useEffect(() => {
    const resumed = readRoutingResume()
    if (!resumed || resumed.channelId) return
    const usage = usages.find((entry) => entry.kind === 'shared_bot_routing' && entry.id === resumed.botId)
    if (!usage) return
    clearRoutingResume()
    setEditing({ key: usageKey(usage), resume: true })
  }, [usages])

  // A gate's modal closes by dropping its draft; re-read the usages then, so its rule chip shows what was saved.
  const openGates = usages
    .flatMap((usage) => {
      const gate = gateOf(usage)
      const key = gate ? gates.bindingKey(gate.integration.botId, gate.row) : apiKeyOf(usage)
      return key && bindingDrafts[key] ? [key] : []
    })
    .join('\n')
  const lastOpen = useRef(openGates)
  useEffect(() => {
    if (lastOpen.current && lastOpen.current !== openGates) onChanged()
    lastOpen.current = openGates
  }, [openGates, onChanged])

  const editable = (usage: DecisionUsage): boolean => {
    switch (usage.kind) {
      case 'gate': {
        const gate = gateOf(usage)
        return !!gate && !!gates.saved(gate.integration.botId, gate.row)
      }
      case 'api_gate':
        return !!usage.protocol && !!agentOf(usage.id)
      case 'shared_bot_routing':
        return true
      case 'code_host_routing':
        return !!usage.provider && !!usage.repoId && !!usage.family
      case 'model_selection':
        return !!modal && !!agentOf(usage.id)
      case 'agent_tool':
        return false
    }
  }
  const edit = (usage: DecisionUsage) => {
    const gate = gateOf(usage)
    if (gate) {
      gates.edit(gate.integration.botId, gate.row)
      return
    }
    const agent = agentOf(usage.id)
    if (usage.kind === 'model_selection') {
      if (agent) modal?.openModal('editAgent', agent, { focusSection: 'runtime', onSaved: onChanged })
      return
    }
    setEditing({ key: usageKey(usage) })
  }
  const done = () => {
    setEditing(null)
    onChanged()
  }

  const editingUsage = editing ? usages.find((usage) => usageKey(usage) === editing.key) : undefined
  const editors = (
    <>
      {usages.map((usage) => {
        const gate = gateOf(usage)
        if (!gate) return null
        const agent = agentOf(gate.integration.agentId ?? '')
        return (
          <Fragment key={usageKey(usage)}>
            {gates.strip({
              botId: gate.integration.botId,
              integrationId: gate.integration.id,
              row: gate.row,
              agentName: agent ? agentLabel(agent) : '',
              padX: 0,
              modalOnly: true
            })}
          </Fragment>
        )
      })}
      {usages.map((usage) => {
        const key = apiKeyOf(usage)
        const agent = agentOf(usage.id)
        const requested = editing?.key === usageKey(usage)
        if (!key || !agent || !(requested || bindingDrafts[key])) return null
        return (
          <ApiGateEditor
            key={usageKey(usage)}
            agent={agent}
            protocol={usage.protocol!}
            requested={requested}
            onDone={() => setEditing(null)}
          />
        )
      })}
      {editingUsage?.kind === 'shared_bot_routing' && (
        <DecisionRoutingModal
          botId={editingUsage.id}
          channelName={editingUsage.label}
          resume={!!editing?.resume}
          onClose={done}
        />
      )}
      {editingUsage?.kind === 'code_host_routing' && <CodeHostEditor usage={editingUsage} onClose={done} />}
    </>
  )
  return { editable, edit, editors }
}
