'use client'

// The Console agent editor, opened as a native MCP App from webchat: `createAgent` hands back the
// new agent's card and `configureAgent` reopens the same editor for an existing one. Env vars,
// secrets, placement and sharing are all typed here, under the reader's own Console JWT — the tool
// only asks for the form to be shown.

import { AGENT_SETUP_URI, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import EditAgentModal from './EditAgentModal'
import { NativeDialogNotice } from './NativeDialogNotice'

type AgentSetupUi = Extract<NativeMcpUi, { resourceUri: typeof AGENT_SETUP_URI }>

export default function AgentSetupDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: AgentSetupUi
  onClose: () => void
  onCompleted: (summary: string) => void
}) {
  const { activeOrg } = useOrgs()
  const { agents, loading } = useConsoleData()
  const heading = ui.intent.created ? 'Agent created' : 'Edit agent'
  const notice = (text: string) => <NativeDialogNotice heading={heading} text={text} onClose={onClose} />
  if (activeOrg?.id !== ui.orgId) return notice('This agent belongs to another organization.')
  if (loading) return notice('Loading configuration…')
  const agent = agents.find((item) => item.id === ui.intent.agentId)
  if (!agent) return notice('This agent is unavailable.')
  if (!agent.canEdit) return notice('You cannot edit this agent.')
  return (
    <EditAgentModal
      agent={agent}
      focusSection={ui.intent.section}
      onSaved={() => onCompleted(`Saved the configuration of agent ${agentLabel(agent)}.`)}
      onClose={onClose}
    />
  )
}
