'use client'

// The Console agent surface, opened as a native MCP App from webchat: `configureAgent` reopens the
// editor for an existing agent, and a delegated `createAgent` opens the create dialog prefilled with
// what it collected — the agent is born when the reader submits it. Env vars, secrets, placement and
// sharing are all typed here, under the reader's own Console JWT — the tool only asks for the form.

import { useEffect, useRef, useState } from 'react'
import { AGENT_SETUP_URI, nativeUiTitle, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import AddAgentModal from './AddAgentModal'
import EditAgentModal from './EditAgentModal'
import { NativeDialogNotice } from './NativeDialogNotice'
import { nativeFailureReport, type NativeDialogReport } from './native-dialog-report'

type AgentSetupUi = Extract<NativeMcpUi, { resourceUri: typeof AGENT_SETUP_URI }>

export default function AgentSetupDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: AgentSetupUi
  onClose: () => void
  onCompleted: NativeDialogReport
}) {
  const { activeOrg } = useOrgs()
  const { agents, loading, refresh } = useConsoleData()
  const heading = nativeUiTitle(ui)
  const sameOrg = activeOrg?.id === ui.orgId
  const agent = agents.find((item) => item.id === ui.intent.agentId)
  // An agent created through MCP is not in the browser's cached roster, which only revalidates on
  // its own poll — ask once before calling a row that simply has not arrived yet unavailable.
  const [revalidated, setRevalidated] = useState(false)
  const asked = useRef(false)
  useEffect(() => {
    if (!sameOrg || loading || agent || asked.current || ui.intent.draft) return
    asked.current = true
    void Promise.resolve(refresh()).finally(() => setRevalidated(true))
  }, [sameOrg, loading, agent, refresh, ui.intent.draft])
  const notice = (text: string) => <NativeDialogNotice heading={heading} text={text} onClose={onClose} />
  if (!sameOrg) return notice('This agent belongs to another organization.')
  if (loading) return notice('Loading configuration…')
  // Nothing exists yet: the create dialog opens on the proposal, and its own Create button is what
  // writes the agent — under the reader's Console session, never on the tool call's authority.
  // Both outcomes reach the conversation: the id is what the agent's next step needs, and a create
  // that did not land is news too — silence would leave the agent waiting on an agent that is absent.
  if (ui.intent.draft)
    return (
      <AddAgentModal
        draft={ui.intent.draft}
        onCreated={(created) => onCompleted(`Created agent ${created.name} (agentId ${created.id}).`)}
        onFailed={nativeFailureReport('Creating the agent', onCompleted, onClose)}
        onClose={onClose}
      />
    )
  if (!agent) return notice(revalidated ? 'This agent is unavailable.' : 'Loading configuration…')
  if (!agent.canEdit) return notice('You cannot edit this agent.')
  return (
    <EditAgentModal
      agent={agent}
      focusSection={ui.intent.section}
      onSaved={() => onCompleted(`Saved the configuration of agent ${agentLabel(agent)}.`)}
      onFailed={nativeFailureReport(`Saving the configuration of agent ${agentLabel(agent)}`, onCompleted, onClose)}
      onClose={onClose}
    />
  )
}
