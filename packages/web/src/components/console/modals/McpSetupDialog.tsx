'use client'

// "Add MCP server", opened as a native MCP App from webchat. The server's url and its credential —
// a header value or an OAuth client secret — are typed in the browser, never carried in a tool
// argument that the audit log and the transcript would both keep.

import { useTranslations } from 'next-intl'
import { MCP_SETUP_URI, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import { fetchAgentDto, type McpProviderCreatedDto } from '@/lib/api'
import { CreateMcpProviderModal } from '@/components/console/McpServersCard'
import { NativeDialogNotice } from './NativeDialogNotice'
import { nativeFailureReport, type NativeDialogReport } from './native-dialog-report'

type McpSetupUi = Extract<NativeMcpUi, { resourceUri: typeof MCP_SETUP_URI }>

export default function McpSetupDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: McpSetupUi
  onClose: () => void
  onCompleted: NativeDialogReport
}) {
  const t = useTranslations('Tools.mcp.setupDialog')
  const { activeOrg, myRole } = useOrgs()
  const { agents, updateAgent } = useConsoleData()
  const heading = t('heading')
  const notice = (text: string) => <NativeDialogNotice heading={heading} text={text} onClose={onClose} />
  if (activeOrg?.id !== ui.orgId) return notice(t('wrongOrganization'))
  // Same gate as the Tools & Skills page: the CP denies viewer writes, so offer no form.
  if (myRole === 'viewer') return notice(t('viewerDenied'))
  const agent = ui.intent.agentId ? agents.find((item) => item.id === ui.intent.agentId) : undefined
  if (ui.intent.agentId && !agent?.canEdit) return notice(t('cannotEditAgent'))

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

  // A refused registration is reported too: the caller asked for a server and has to hear it has none.
  return (
    <CreateMcpProviderModal
      onClose={onClose}
      onCreated={(provider) => void created(provider)}
      onFailed={nativeFailureReport('Adding the MCP server', onCompleted, onClose)}
    />
  )
}
