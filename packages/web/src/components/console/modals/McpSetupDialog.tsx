'use client'

// "Add MCP server", opened as a native MCP App from webchat. The server's url and its credential —
// a header value or an OAuth client secret — are typed in the browser, never carried in a tool
// argument that the audit log and the transcript would both keep.

import { MCP_SETUP_URI, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import { fetchAgentDto, type McpProviderCreatedDto } from '@/lib/api'
import { CreateMcpProviderModal } from '@/components/console/McpServersCard'
import { NativeDialogNotice } from './NativeDialogNotice'

type McpSetupUi = Extract<NativeMcpUi, { resourceUri: typeof MCP_SETUP_URI }>

export default function McpSetupDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: McpSetupUi
  onClose: () => void
  onCompleted: (summary: string) => void
}) {
  const { activeOrg, myRole } = useOrgs()
  const { agents, updateAgent } = useConsoleData()
  const heading = 'Add MCP server'
  const notice = (text: string) => <NativeDialogNotice heading={heading} text={text} onClose={onClose} />
  if (activeOrg?.id !== ui.orgId) return notice('This MCP registry belongs to another organization.')
  // Same gate as the Tools & Skills page: the CP denies viewer writes, so offer no form.
  if (myRole === 'viewer') return notice('You cannot add MCP servers in this organization.')
  const agent = ui.intent.agentId ? agents.find((item) => item.id === ui.intent.agentId) : undefined
  if (ui.intent.agentId && !agent?.canEdit)
    return notice('You cannot change the MCP servers of the agent this server was requested for.')

  // Attaching is a second write that may fail on its own; the summary reports what actually landed,
  // and never the url, header or grant key the dialog just handled.
  const created = async (provider: McpProviderCreatedDto) => {
    if (!agent) return onCompleted(`Added the MCP server ${provider.name}.`)
    try {
      const current = await fetchAgentDto(agent.id)
      const names = current.mcpServers.filter((name) => name !== provider.name)
      await updateAgent(agent.id, { mcpServers: [...names, provider.name] })
      onCompleted(`Added the MCP server ${provider.name} and attached it to ${agentLabel(agent)}.`)
    } catch (e) {
      onCompleted(
        `Added the MCP server ${provider.name}, but attaching it to ${agentLabel(agent)} failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }

  return <CreateMcpProviderModal onClose={onClose} onCreated={(provider) => void created(provider)} />
}
