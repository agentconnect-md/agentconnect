'use client'

// The Skills library's own install dialogs, opened as a native MCP App from webchat. Registering a
// source is a Console write under the reader's JWT — the dialog resolves the repository, names the
// library entry and settles sharing, none of which a tool argument could stand in for.

import { SKILL_SETUP_URI, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import { fetchAgentDto, type SkillSourceDto } from '@/lib/api'
import { InstallRegistrySkillModal } from '@/components/console/InstallRegistrySkillModal'
import { CreateSkillSourceModal } from '@/components/console/SkillSourcesCard'
import { NativeDialogNotice } from './NativeDialogNotice'
import { nativeFailureReport, type NativeDialogReport } from './native-dialog-report'

type SkillSetupUi = Extract<NativeMcpUi, { resourceUri: typeof SKILL_SETUP_URI }>

const sourceOf = (ref: string) => (ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : ref)

export default function SkillSetupDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: SkillSetupUi
  onClose: () => void
  onCompleted: NativeDialogReport
}) {
  const { activeOrg, myRole } = useOrgs()
  const { agents, skillSources, updateAgent } = useConsoleData()
  const heading = 'Install skill'
  const notice = (text: string) => <NativeDialogNotice heading={heading} text={text} onClose={onClose} />
  if (activeOrg?.id !== ui.orgId) return notice('This skill library belongs to another organization.')
  // Same gate as the Skills library page: the CP denies viewer writes, so offer no form.
  if (myRole === 'viewer') return notice('You cannot install skills in this organization.')
  const agent = ui.intent.agentId ? agents.find((item) => item.id === ui.intent.agentId) : undefined
  if (ui.intent.agentId && !agent?.canEdit)
    return notice('You cannot change the skills of the agent this install was requested for.')

  // The library accepted the source; enabling it on the requested agent is a second write that may
  // fail on its own, and a summary that claimed both would be a lie.
  const installed = async (created: SkillSourceDto) => {
    if (!agent) return onCompleted(`Installed the skill library ${created.name}.`)
    try {
      const current = await fetchAgentDto(agent.id)
      const refs = current.skills.filter((ref) => sourceOf(ref) !== created.name)
      await updateAgent(agent.id, { skills: [...refs, `${created.name}/*`] })
      onCompleted(`Installed the skill library ${created.name} and enabled it on ${agentLabel(agent)}.`)
    } catch (e) {
      onCompleted(
        `Installed the skill library ${created.name}, but enabling it on ${agentLabel(agent)} failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }
  const onCreated = (created: SkillSourceDto) => void installed(created)

  // A refused install is reported too: the caller asked for a skill and has to hear that it has none.
  const onFailed = nativeFailureReport('Installing the skill', onCompleted, onClose)

  return ui.intent.source === 'git' ? (
    <CreateSkillSourceModal onClose={onClose} onCreated={onCreated} onFailed={onFailed} />
  ) : (
    <InstallRegistrySkillModal
      existing={skillSources}
      initialQuery={ui.intent.query}
      onClose={onClose}
      onCreated={onCreated}
      onFailed={onFailed}
    />
  )
}
