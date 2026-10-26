'use client'

// How someone with authority makes a capability request's change: the console's own dialog for it, prefilled, then a settle (capability-requests.md §4.5, §4.6).
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  fetchAgentDto,
  settleCapabilityRequest,
  type CapabilityRequestDto,
  type CapabilitySettingsWant,
  type SkillSourceDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { splitSkillRef } from '@/lib/capability-requests'
import { Button } from '@/components/ui'
import { Scrim } from '@/components/console/Scrim'
import { AgentToolsCard } from '@/components/console/AgentToolsCard'
import { AgentSkillsCard } from '@/components/console/AgentSkillsCard'
import { InstallRegistrySkillModal } from '@/components/console/InstallRegistrySkillModal'
import EditAgentModal from '@/components/console/modals/EditAgentModal'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function CapabilityRequestCompletion({
  request,
  onSettled
}: {
  request: CapabilityRequestDto
  onSettled: (next: CapabilityRequestDto) => void
}) {
  const t = useTranslations('CapabilityRequests.complete')
  const { orgPath } = useOrgs()
  const { agents, daemons, skillSources, updateAgent } = useConsoleData()
  const agent = agents.find((item) => item.id === request.agentId)
  const [dialog, setDialog] = useState<'settings' | 'registry' | null>(null)
  const [showRoster, setShowRoster] = useState(false)
  const [rosterBusy, setRosterBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Runs only after a save went through; the server judges what was saved, so a refused save never settles.
  const settle = async () => {
    setBusy(true)
    setError(null)
    try {
      onSettled(await settleCapabilityRequest(request.id, request.orgId))
    } catch (e) {
      setError(t('settleFailed', { error: errorText(e) }))
    } finally {
      setBusy(false)
    }
  }
  const saveThenSettle = async (write: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await write()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
      return
    }
    await settle()
  }

  const closeDialog = () => setDialog(null)
  const status = (
    <>
      {busy && (
        <p role="status" className="text-[13px] text-(--text-secondary)">
          {t('saving')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-(--red-600)">
          {error}
        </p>
      )}
    </>
  )

  if (request.kind === 'agent-settings') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-(--text-secondary)">{t('settingsHint')}</p>
        <div>
          <Button disabled={busy || !agent} onClick={() => setDialog('settings')}>
            {t('reviewSettings')}
          </Button>
        </div>
        {status}
        {dialog === 'settings' && agent && (
          <Scrim onEscape={closeDialog}>
            <div className="modal desktop:max-w-[830px]">
              <EditAgentModal
                agent={agent}
                focusSection="runtime"
                prefill={request.want as CapabilitySettingsWant}
                onSaved={() => void settle()}
                onClose={closeDialog}
              />
            </div>
          </Scrim>
        )}
      </div>
    )
  }

  if (request.kind === 'mcp-server') {
    const server = (request.want as { server: string }).server
    // A server the organization never registered cannot be attached from here; registering it is its own console flow.
    if (request.current.exists === false) {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-(--text-secondary)">{t('serverMissingHint')}</p>
          <div>
            <Link className="lnk text-[13px]" href={orgPath('/tools')}>
              {t('openTools')}
            </Link>
          </div>
        </div>
      )
    }
    const attach = () =>
      saveThenSettle(async () => {
        const current = await fetchAgentDto(request.agentId, request.orgId)
        if (current.mcpServers.includes(server)) return
        await updateAgent(request.agentId, { mcpServers: [...current.mcpServers, server] })
      })
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || rosterBusy} onClick={() => void attach()}>
            {t('addServer', { server })}
          </Button>
          {agent && (
            <Button variant="secondary" disabled={busy} onClick={() => setShowRoster((open) => !open)}>
              {showRoster ? t('hideTools') : t('reviewTools')}
            </Button>
          )}
        </div>
        {status}
        {showRoster && agent && (
          <div className="flex flex-col gap-3">
            <AgentToolsCard
              agentId={agent.id}
              runtime={agent.runtime}
              daemon={daemons.find((item) => item.daemonId === agent.daemon)}
              canEdit={agent.canEdit && !busy}
              onBusyChange={setRosterBusy}
            />
            <div>
              <Button variant="secondary" disabled={busy || rosterBusy} onClick={() => void settle()}>
                {t('toolsDone')}
              </Button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const ref = (request.want as { skill: string }).skill
  const { source, skill } = splitSkillRef(ref)
  const inLibrary = skillSources.some((item) => item.name === source)
  // A whole-source selection already covers the skill; otherwise the one reference is added beside the rest.
  const enable = (sourceName: string) =>
    saveThenSettle(async () => {
      const current = await fetchAgentDto(request.agentId, request.orgId)
      const wanted = `${sourceName}/${skill}`
      if (current.skills.includes(`${sourceName}/*`) || current.skills.includes(wanted)) return
      await updateAgent(request.agentId, { skills: [...current.skills, wanted] })
    })
  const installed = (created: SkillSourceDto) => {
    closeDialog()
    void enable(created.name)
  }
  return (
    <div className="flex flex-col gap-3">
      {!inLibrary && <p className="text-[13px] text-(--text-secondary)">{t('skillMissingHint', { source })}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {inLibrary ? (
          <Button disabled={busy || rosterBusy} onClick={() => void enable(source)}>
            {t('installSkill', { skill: ref })}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => setDialog('registry')}>
            {t('findSkill')}
          </Button>
        )}
        {agent && (
          <Button variant="secondary" disabled={busy} onClick={() => setShowRoster((open) => !open)}>
            {showRoster ? t('hideTools') : t('reviewTools')}
          </Button>
        )}
      </div>
      {status}
      {showRoster && agent && (
        <div className="flex flex-col gap-3">
          <AgentSkillsCard agentId={agent.id} canEdit={agent.canEdit && !busy} onBusyChange={setRosterBusy} />
          <div>
            <Button variant="secondary" disabled={busy || rosterBusy} onClick={() => void settle()}>
              {t('toolsDone')}
            </Button>
          </div>
        </div>
      )}
      {dialog === 'registry' && (
        <Scrim onEscape={closeDialog}>
          <div className="modal desktop:max-w-[700px]">
            <InstallRegistrySkillModal
              existing={skillSources}
              initialQuery={skill || source}
              onClose={closeDialog}
              onCreated={installed}
              onFailed={(reason) => setError(reason)}
            />
          </div>
        </Scrim>
      )}
    </div>
  )
}
