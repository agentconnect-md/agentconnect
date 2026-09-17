'use client'

// The agent's Tools & Skills tab, opened as a native MCP App from webchat. `installSkill` and
// `installMcpServer` only ADD; taking something away is a per-row decision over live state, so the
// roster itself is the surface — the same two cards the tab mounts, each row keeping its own remove
// control, all under the reader's own Console JWT.

import { useState } from 'react'
import { AGENT_TOOLS_URI, nativeUiTitle, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { Button } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import { fetchAgentDto } from '@/lib/api'
import { AgentToolsCard } from '@/components/console/AgentToolsCard'
import { AgentSkillsCard } from '@/components/console/AgentSkillsCard'
import { NativeDialogNotice } from './NativeDialogNotice'

type AgentToolsUi = Extract<NativeMcpUi, { resourceUri: typeof AGENT_TOOLS_URI }>

export default function AgentToolsDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: AgentToolsUi
  onClose: () => void
  onCompleted: (summary: string) => void
}) {
  const { activeOrg } = useOrgs()
  const { agents, daemons, loading } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heading = nativeUiTitle(ui)
  const notice = (text: string) => <NativeDialogNotice heading={heading} text={text} onClose={onClose} />
  const agent = agents.find((item) => item.id === ui.intent.agentId)
  if (activeOrg?.id !== ui.orgId) return notice('This agent belongs to another organization.')
  if (loading) return notice('Loading configuration…')
  if (!agent) return notice('This agent is unavailable.')
  const focus = ui.intent.focus
  const canEdit = agent.canEdit

  // Every row saved itself the moment it was toggled, so Done reports the resulting roster — counts
  // only, never a server url or a repository address.
  const done = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const current = await fetchAgentDto(agent.id)
      const parts: string[] = []
      if (focus !== 'skills') parts.push(`${current.mcpServers.length} MCP server(s) attached`)
      if (focus !== 'mcp')
        parts.push(`${current.skills.length + (current.managedSkills?.length ?? 0)} skill(s) enabled`)
      onCompleted(`Reviewed ${agentLabel(agent)}’s tools and skills — ${parts.join(' · ')}.`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">{heading}</div>
      <div className="modalbody flex flex-col gap-4">
        <p className="text-[13px] text-(--text-secondary)">
          Add or remove what <span className="mono text-[12.5px]">{agent.name}</span> can use. Each change saves as you
          make it.
        </p>
        {focus !== 'skills' && (
          <AgentToolsCard
            agentId={agent.id}
            runtime={agent.runtime}
            daemon={daemons.find((item) => item.daemonId === agent.daemon)}
            canEdit={canEdit}
          />
        )}
        {focus !== 'mcp' && <AgentSkillsCard agentId={agent.id} canEdit={canEdit} />}
        {!canEdit && (
          <p role="status" className="text-[13px] text-(--text-secondary)">
            You can review this agent’s tools and skills, but not change them.
          </p>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-(--text-secondary)">
            {error}
          </p>
        )}
      </div>
      <div className="modalfoot">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Close
        </Button>
        <Button disabled={busy} onClick={done}>
          Done
        </Button>
      </div>
    </>
  )
}
