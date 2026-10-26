'use client'

// How someone with authority makes a capability request's change: the console's own dialog for it, prefilled, then a settle (capability-requests.md §4.5, §4.6).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  fetchAgentDto,
  fetchAgentRepos,
  fetchGithubInstallUrl,
  saveAgentLiveSecret,
  settleCapabilityRequest,
  startGitlabOauth,
  startMcpProviderOauth,
  updateAgentRepo,
  type AgentRepoAuthDto,
  type CapabilityConnectionWant,
  type CapabilityRepositoryWant,
  type CapabilityRequestDto,
  type CapabilitySecretWant,
  type CapabilitySettingsWant,
  type SkillSourceDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { capabilityProviderId, grantNamesRepository, splitSkillRef } from '@/lib/capability-requests'
import { Button } from '@/components/ui'
import { Scrim } from '@/components/console/Scrim'
import { useModal } from '@/components/console/ModalProvider'
import { AgentToolsCard } from '@/components/console/AgentToolsCard'
import { AgentSkillsCard } from '@/components/console/AgentSkillsCard'
import { EditMcpProviderModal } from '@/components/console/McpServersCard'
import { InstallRegistrySkillModal } from '@/components/console/InstallRegistrySkillModal'
import AddAgentRepoModal from '@/components/console/modals/AddAgentRepoModal'
import EditAgentModal from '@/components/console/modals/EditAgentModal'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface CompletionProps {
  request: CapabilityRequestDto
  onSettled: (next: CapabilityRequestDto) => void
  /** Re-read the request: a connection is settled by the server once it holds, so the page only looks again. */
  onRefresh?: () => void
}

export function CapabilityRequestCompletion(props: CompletionProps) {
  if (props.request.kind === 'repository') return <RepositoryCompletion {...props} />
  if (props.request.kind === 'connection') return <ConnectionCompletion {...props} />
  if (props.request.kind === 'secret') return <SecretCompletion {...props} />
  return <SettingsAndTools {...props} />
}

/** Save, then settle; a refused save never settles, since the server judges only what was saved. */
function useSettling(request: CapabilityRequestDto, onSettled: (next: CapabilityRequestDto) => void) {
  const t = useTranslations('CapabilityRequests.complete')
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
  return { busy, setBusy, error, setError, settle, saveThenSettle, status }
}

function SettingsAndTools({ request, onSettled }: CompletionProps) {
  const t = useTranslations('CapabilityRequests.complete')
  const { orgPath } = useOrgs()
  const { agents, daemons, skillSources, updateAgent } = useConsoleData()
  const agent = agents.find((item) => item.id === request.agentId)
  const [dialog, setDialog] = useState<'settings' | 'registry' | null>(null)
  const [showRoster, setShowRoster] = useState(false)
  const [rosterBusy, setRosterBusy] = useState(false)
  const { busy, setError, settle, saveThenSettle, status } = useSettling(request, onSettled)
  const closeDialog = () => setDialog(null)

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

/** A repository grant: raise an existing one's tier in place, else the agent's own authorization dialog, prefilled. */
function RepositoryCompletion({ request, onSettled }: CompletionProps) {
  const t = useTranslations('CapabilityRequests.complete')
  const { agents } = useConsoleData()
  const agent = agents.find((item) => item.id === request.agentId)
  const want = request.want as CapabilityRepositoryWant
  const [grants, setGrants] = useState<AgentRepoAuthDto[] | null>(null)
  const [dialog, setDialog] = useState(false)
  const { busy, settle, saveThenSettle, status } = useSettling(request, onSettled)

  useEffect(() => {
    let alive = true
    fetchAgentRepos(request.agentId, request.orgId).then(
      (rows) => alive && setGrants(rows),
      () => alive && setGrants([])
    )
    return () => {
      alive = false
    }
  }, [request.agentId, request.orgId])

  const held = grants?.find((row) => grantNamesRepository(row, want))
  // A read grant asked up to write is the same row at a higher tier; the dialog would refuse it as a duplicate.
  const raise =
    held && held.access === 'read' && want.access === 'write'
      ? () => saveThenSettle(async () => void (await updateAgentRepo(request.agentId, held.id, { access: 'write' })))
      : undefined

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-(--text-secondary)">
        {want.access === 'write' ? t('repositoryWriteHint') : t('repositoryHint')}
      </p>
      <div>
        {raise ? (
          <Button disabled={busy} onClick={() => void raise()}>
            {t('raiseRepository', { repository: want.repository })}
          </Button>
        ) : (
          <Button disabled={busy || !agent || grants === null} onClick={() => setDialog(true)}>
            {t('authorizeRepository', { repository: want.repository })}
          </Button>
        )}
      </div>
      {status}
      {dialog && agent && grants && (
        <Scrim onEscape={() => setDialog(false)}>
          <div className="modal">
            <AddAgentRepoModal
              agent={agent}
              workspaceRepo={null}
              authorized={grants}
              initialProvider={want.provider}
              {...(want.provider === 'github' ? { initialRepo: want.repository } : { initialSearch: want.repository })}
              initialAccess={want.access}
              onClose={() => setDialog(false)}
              onCreated={(row) => {
                setDialog(false)
                setGrants([...grants, row])
                void settle()
              }}
            />
          </div>
        </Scrim>
      )}
    </div>
  )
}

/** How long the page keeps looking after it sent someone off to connect something in another window. */
const CONNECTION_WATCH_MS = 5 * 60_000
const CONNECTION_POLL_MS = 3_000

/** A connection: the console's own connect flow, after which the server settles the request once it holds. */
function ConnectionCompletion({ request, onRefresh }: CompletionProps) {
  const t = useTranslations('CapabilityRequests.complete')
  const { orgPath } = useOrgs()
  const { agents } = useConsoleData()
  const { openModal } = useModal()
  const agent = agents.find((item) => item.id === request.agentId)
  const want = request.want as CapabilityConnectionWant
  const [watching, setWatching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh

  // The flow finishes in another window; look again on a timer and whenever this one regains focus.
  useEffect(() => {
    if (!watching) return
    const look = () => refresh.current?.()
    const timer = window.setInterval(look, CONNECTION_POLL_MS)
    const stop = window.setTimeout(() => setWatching(false), CONNECTION_WATCH_MS)
    window.addEventListener('focus', look)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(stop)
      window.removeEventListener('focus', look)
    }
  }, [watching])

  const go = async (open: () => Promise<void>) => {
    setError(null)
    try {
      await open()
      setWatching(true)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const returnPath = orgPath(`/requests/${encodeURIComponent(request.id)}`)

  let action: ReactNode
  if (want.type === 'mcp-oauth') {
    const providerId = capabilityProviderId(request)
    action = providerId ? (
      <Button
        onClick={() =>
          void go(async () => {
            const { url } = await startMcpProviderOauth(providerId, { returnPath })
            window.open(url, 'mcp_provider_oauth', 'popup=yes,width=520,height=720')
          })
        }
      >
        {t('connectServer', { server: want.server })}
      </Button>
    ) : (
      <Link className="lnk text-[13px]" href={orgPath('/tools')}>
        {t('openTools')}
      </Link>
    )
  } else if (want.type === 'code-host') {
    action = (
      <Button
        onClick={() =>
          void go(async () => {
            const url = want.provider === 'github' ? await fetchGithubInstallUrl() : await startGitlabOauth(returnPath)
            if (!url) throw new Error(t('connectUnavailable'))
            window.open(url, '_blank', 'noopener')
          })
        }
      >
        {want.provider === 'github' ? t('connectGithub') : t('connectGitlab')}
      </Button>
    )
  } else {
    action = agent ? (
      <Button onClick={() => void go(async () => openModal('integration', agent, { platform: want.platform }))}>
        {t('addIntegration', { platform: want.platform })}
      </Button>
    ) : (
      <Link className="lnk text-[13px]" href={orgPath('/integrations')}>
        {t('openIntegrations')}
      </Link>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-(--text-secondary)">{t('connectionHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {action}
        {onRefresh && (
          <Button variant="secondary" onClick={() => onRefresh()}>
            {t('checkAgain')}
          </Button>
        )}
      </div>
      {watching && (
        <p role="status" className="text-[13px] text-(--text-secondary)">
          {t('connectionWatching')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-(--red-600)">
          {error}
        </p>
      )}
    </div>
  )
}

/** A secret: an MCP server's header, typed into the server's own edit dialog; the agent never sees the value. */
function SecretCompletion({ request, onSettled }: CompletionProps) {
  const t = useTranslations('CapabilityRequests.complete')
  const { orgPath } = useOrgs()
  const { mcpProviders } = useConsoleData()
  const want = request.want as CapabilitySecretWant
  const [dialog, setDialog] = useState(false)
  const { busy, settle, status } = useSettling(request, onSettled)

  if (want.use.route === 'live') return <LiveSecretCompletion request={request} onSettled={onSettled} />
  const { server } = want.use
  const providerId = capabilityProviderId(request)
  const provider = mcpProviders.find((item) => item.id === providerId || item.name === server)
  if (!provider) {
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
  // An OAuth server signs in through its grant; it has no headers to set.
  if (provider.auth === 'oauth2') {
    return <p className="text-[13px] text-(--text-secondary)">{t('headerOnOauthServer', { server: provider.name })}</p>
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-(--text-secondary)">{t('headerHint', { server: provider.name })}</p>
      <div>
        <Button disabled={busy || !provider.canEdit} onClick={() => setDialog(true)}>
          {t('setHeader', { header: want.name })}
        </Button>
      </div>
      {status}
      {dialog && (
        <Scrim onEscape={() => setDialog(false)}>
          <div className="modal">
            <EditMcpProviderModal
              provider={provider}
              requestedHeader={want.name}
              onSaved={() => void settle()}
              onClose={() => setDialog(false)}
            />
          </div>
        </Scrim>
      )}
    </div>
  )
}

/** A live secret: typed here only, write-only, and loaded by the agent's own shell when a command needs it (§4.9.2). */
function LiveSecretCompletion({ request, onSettled }: CompletionProps) {
  const t = useTranslations('CapabilityRequests.complete')
  const want = request.want as CapabilitySecretWant
  const [value, setValue] = useState('')
  const { busy, saveThenSettle, status } = useSettling(request, onSettled)
  const save = () =>
    saveThenSettle(async () => {
      await saveAgentLiveSecret(
        request.agentId,
        { name: want.name, value, ...(want.description ? { description: want.description } : {}) },
        request.orgId
      )
      // The value is never kept or shown again once it is stored.
      setValue('')
    })
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (value && !busy) void save()
      }}
    >
      <p className="text-[13px] text-(--text-secondary)">{t('liveSecretHint', { name: want.name })}</p>
      <p className="text-[13px] text-(--text-secondary)">{t('liveSecretPurpose', { description: want.description })}</p>
      {request.current.present === true && (
        <p className="text-[13px] text-(--text-secondary)">{t('liveSecretReplace', { name: want.name })}</p>
      )}
      <label className="fld">
        <span className="fldlbl">{t('liveSecretLabel', { name: want.name })}</span>
        <input
          className="inp font-mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <p className="text-[13px] font-medium text-(--text-primary)" data-live-secret-notice>
        {t('liveSecretNotice')}
      </p>
      <div>
        <Button type="submit" disabled={busy || !value}>
          {t('saveLiveSecret', { name: want.name })}
        </Button>
      </div>
      {status}
    </form>
  )
}
