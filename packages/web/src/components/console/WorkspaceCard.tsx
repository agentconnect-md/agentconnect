'use client'

// The Workspace tab's top card: one row with the source (a provider mark derived per git-workspace-model.md §7), its additional-repository menu, and the caller's live git state.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { isCodeHostProvider } from '@agentconnect.md/protocol/code-host'
import { GithubMark, LoadingState } from '@/components/marks'
import { CodeHostMark } from '@/components/console/CodeHostMark'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { CODE_HOST_PROJECTION } from '@/lib/code-hosts'
import { workspaceSourceOf, type Agent, type WorkspaceStatusInfo } from '@/lib/data'
import {
  fetchAgentInstallations,
  fetchAgentRepos,
  repoAuthMaterialize,
  repoAuthProvider,
  type AgentInstallationAuthDto,
  type AgentRepoAuthDto,
  type InstallationMaterialize
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useRepositoryDecision } from '@/lib/repository-selector'
import { useRepositoryGrantEdits, type RepositoryGrantEdits } from '@/lib/use-repository-grant-edits'
import { consoleKeys } from '@/lib/swr-keys'
import { useConsoleData } from '@/lib/data-context'
import EditWorkspaceModal from '@/components/console/modals/EditWorkspaceModal'
import {
  INSTALLATION_MATERIALIZE_OPTIONS,
  RepositoryAccessToggle,
  RepositoryMaterializeSelect,
  type WorkspaceMode
} from '@/components/console/WorkspaceFormFields'

/** The live half of the card — git status, HEAD, and pull — from <WorkspaceFiles>, or a demo agent's mock workspace. */
export interface WorkspaceHeaderInfo {
  status?: WorkspaceStatusInfo | null
  /** HEAD summary, rendered `sha · time` with `title` as its tooltip. */
  commit?: { sha: string; time: string; title?: string } | null
  /** Browsable remote URL of the root being read; the name links here when the workspace carries no URL of its own. */
  repoUrl?: string | null
  /** Remote label for the name link's tooltip ("GitHub", "gitlab.com", …). */
  remoteLabel?: string | null
  onPull?: () => void
  pulling?: boolean
  /** Transient pull outcome ("Already up to date."), shown after the pull action. */
  pullMsg?: string | null
}

// Only a GitHub row has a web address the console can derive without the instance URL a GitLab or Gitea one needs.
const repositoryWebUrl = (row: AgentRepoAuthDto) =>
  repoAuthProvider(row) === 'github' ? `https://${CODE_HOST_PROJECTION.github.publicHost}/${row.repoFullName}` : null

export function WorkspaceCard({
  agent,
  header,
  className
}: {
  agent: Agent
  header?: WorkspaceHeaderInfo
  className?: string
}) {
  const t = useTranslations('Agents.detail.workspace')
  const { activeOrg } = useOrgs()
  const { refresh } = useConsoleData()
  // Non-null ⇒ the workspace editor is open, optionally at its additional-repository step.
  const [editState, setEditState] = useState<{
    mode: WorkspaceMode
    authorizeRepository?: true
  } | null>(null)

  const ws = agent.workspace

  // One-shot `?editws=github|scratch` (the getting-started CTA) opens the editor, then leaves the URL.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const autoEdited = useRef(false)
  useEffect(() => {
    const mode = searchParams.get('editws')
    if (autoEdited.current || !mode) return
    autoEdited.current = true
    if (agent.canEdit) setEditState({ mode: mode === 'scratch' ? 'scratch' : 'github' })
    const sp = new URLSearchParams(searchParams)
    sp.delete('editws')
    router.replace(`${pathname}${sp.size ? `?${sp}` : ''}`, { scroll: false })
  }, [searchParams, agent.canEdit, pathname, router])

  const source = workspaceSourceOf(ws)
  const isGit = ws.mode === 'git'
  const reposKey = consoleKeys.agentRepos(activeOrg?.id, agent.id)
  const {
    data: reposData,
    error: reposError,
    isLoading,
    mutate
  } = useSWR(reposKey, ([, orgId, , agentId]) => fetchAgentRepos(agentId, orgId))
  const repos = reposData ?? []
  const grantsKey = consoleKeys.agentInstallations(activeOrg?.id, agent.id)
  const {
    data: grantsData,
    error: grantsError,
    mutate: mutateGrants
  } = useSWR(grantsKey, ([, orgId, , agentId]) => fetchAgentInstallations(agentId, orgId))
  const grants = grantsData ?? []
  // Repositories and whole accounts (installation grants) counted apart: `+3 repos · 1 org`, or `Repos` for neither.
  const countParts = [
    ...(repos.length > 0 ? [t('repoCount', { count: repos.length })] : []),
    ...(grants.length > 0 ? [t('orgCount', { count: grants.length })] : [])
  ]
  const repositoryCount = countParts.length === 0 ? t('repos') : `+${countParts.join(' · ')}`
  const loadError = !!((reposData === undefined && reposError) || (grantsData === undefined && grantsError))
  const loading = isLoading && reposData === undefined
  const canEdit = agent.canEdit
  const edits = useRepositoryGrantEdits({
    agentId: agent.id,
    repositories: repos,
    grants,
    onRepositoriesChange: (rows) => void mutate(rows, { revalidate: false }),
    onGrantsChange: (rows) => void mutateGrants(rows, { revalidate: false })
  })
  const manualWorkspaceAuthorized =
    ws.mode === 'git' &&
    ws.provider === undefined &&
    repos.some(
      (authorization) =>
        repoAuthProvider(authorization) === 'github' &&
        authorization.repoFullName.toLowerCase() === ws.repo.toLowerCase()
    )
  // A code host is named by its projection; everything else is just "remote".
  const remoteLabel =
    header?.remoteLabel ?? (isCodeHostProvider(source) ? CODE_HOST_PROJECTION[source].label : 'remote')
  // The name links to the source's own address; the file browser's remote only covers an address the console cannot parse.
  const sourceUrl = ws.mode === 'git' ? (ws.repoUrl ?? header?.repoUrl ?? null) : null
  const nameClass = 'mono min-w-0 truncate text-[13px] font-semibold text-(--text-primary)'

  return (
    <div className={`card overflow-hidden max-desktop:rounded-lg ${className ?? ''}`}>
      {/* One row that wraps on narrow viewports. */}
      <div className="flex flex-wrap items-center gap-[10px] px-4 py-[9px]">
        <span className="eyebrow flex-none text-[10.5px]">{t('source')}</span>

        {isGit ? (
          <span
            className="flex h-5 w-5 flex-none items-center justify-center"
            title={
              source === 'giturl'
                ? 'Cloned from a Git URL with the host’s own credentials'
                : ws.provider === undefined
                  ? t('publicRepository')
                  : undefined
            }
          >
            {isCodeHostProvider(source) ? (
              <CodeHostMark provider={source} color="var(--text-secondary)" />
            ) : (
              <Icon name="link-2" size={16} color="var(--text-secondary)" />
            )}
          </span>
        ) : (
          <Icon name="folder" size={16} color="var(--text-tertiary)" />
        )}
        {ws.mode === 'scratch' ? (
          <span className={nameClass}>{t('scratchWorkspace')}</span>
        ) : sourceUrl ? (
          <a
            className={`${nameClass} no-underline hover:underline`}
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t('viewRemote', { provider: remoteLabel })}
          >
            {ws.repo}
          </a>
        ) : (
          <span className={nameClass}>{ws.repo}</span>
        )}
        {isGit && ws.provider === undefined && source !== 'giturl' && (
          <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)" title={t('publicRepository')}>
            {t('public')}
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            className="iconbtn h-6 w-6 flex-none"
            aria-label={t('editWorkspace')}
            title={t('editWorkspace')}
            onClick={() => setEditState({ mode: source })}
          >
            <Icon name="pencil" size={13} />
          </button>
        )}
        <AnchoredFlyout
          role="dialog"
          ariaLabel={t('additionalRepos')}
          align="start"
          width={440}
          estimatedHeight={96 + Math.max(1, repos.length + grants.length) * 40}
          triggerClassName="flex flex-none"
          trigger={({ open, menuId, toggle }) => (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              title={loadError ? t('repositoryGrantsError') : undefined}
              className={
                open
                  ? 'selbtn on h-6 gap-[6px] bg-(--surface-sunken) pr-6 pl-2 font-mono text-[12px]'
                  : loadError
                    ? 'selbtn h-6 gap-[6px] bg-(--surface-sunken) pr-6 pl-2 font-mono text-[12px] text-(--status-error) hover:bg-(--surface-hover)'
                    : 'selbtn h-6 gap-[6px] bg-(--surface-sunken) pr-6 pl-2 font-mono text-[12px] hover:bg-(--surface-hover)'
              }
              onClick={() => {
                edits.setError(null)
                toggle()
              }}
            >
              <Icon name="key-round" size={13} color="var(--text-tertiary)" className="flex-none" />
              {repositoryCount}
            </button>
          )}
        >
          {({ close }) => (
            <RepositoryAccessMenu
              agent={agent}
              repos={repos}
              grants={grants}
              loading={loading}
              loadError={loadError}
              edits={edits}
              authorizeLabel={manualWorkspaceAuthorized ? 'manage' : 'authorize'}
              onAuthorize={() => {
                close()
                setEditState({
                  mode: source,
                  ...(!manualWorkspaceAuthorized ? { authorizeRepository: true as const } : {})
                })
              }}
            />
          )}
        </AnchoredFlyout>

        <div className="min-w-[8px] flex-1" />

        {header?.commit && (
          <span
            className="mono flex-none whitespace-nowrap text-[11.5px] text-(--text-tertiary)"
            title={header.commit.title}
          >
            <span className="text-(--brand-soft-text)">{header.commit.sha}</span> · {header.commit.time}
          </span>
        )}
        {ws.mode === 'git' && ws.branch && (
          <span
            className="inline-flex h-6 max-w-[200px] min-w-0 flex-none items-center gap-[5px] rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken) px-2 font-mono text-[12px] text-(--text-secondary)"
            title={ws.branch}
          >
            <Icon name="git-branch" size={13} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate">{ws.branch}</span>
          </span>
        )}
        {header?.status && (
          <span className="badge flex-none" style={{ background: header.status.bg, color: header.status.text }}>
            <span className="dot h-[6px] w-[6px]" style={{ background: header.status.dot }} />
            {header.status.label}
          </span>
        )}
        {isGit && header?.onPull && (
          <button
            type="button"
            className={`iconbtn h-6 w-6 flex-none ${header.pulling ? 'pointer-events-none opacity-50' : ''}`}
            title={t('pull')}
            onClick={header.onPull}
          >
            <Icon name="refresh-cw" size={13} />
          </button>
        )}
        {header?.pullMsg && (
          <span className="flex-none font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {header.pullMsg}
          </span>
        )}
      </div>

      {editState && (
        <EditWorkspaceModal
          agent={agent}
          authorized={repos}
          installationGrants={grants}
          initialMode={editState.mode}
          {...(editState.authorizeRepository ? { initialRepositoryAuthorization: {} } : {})}
          onAuthorizedChange={(rows) => {
            void mutate(rows, { revalidate: false })
          }}
          onInstallationGrantsChange={(rows) => {
            void mutateGrants(rows, { revalidate: false })
          }}
          onAgentChange={() => refresh()}
          onClose={() => setEditState(null)}
          onChanged={() => {
            void mutate()
            void mutateGrants()
            setEditState(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

/** The card's dropdown: each installation grant and additional repository, in Edit workspace's order and with its controls. */
function RepositoryAccessMenu({
  agent,
  repos,
  grants,
  loading,
  loadError,
  edits,
  authorizeLabel,
  onAuthorize
}: {
  agent: Agent
  repos: AgentRepoAuthDto[]
  grants: AgentInstallationAuthDto[]
  loading: boolean
  loadError: boolean
  edits: RepositoryGrantEdits
  authorizeLabel: 'authorize' | 'manage'
  onAuthorize: () => void
}) {
  const t = useTranslations('Agents.detail.workspace')
  const tEdit = useTranslations('Agents.workspaceEdit')
  const { myRole } = useOrgs()
  // Installation grants are organization-owner writes (decision 10); everyone else sees them disabled.
  const isOwner = myRole === 'owner'
  const canEdit = agent.canEdit
  const grantEditable = canEdit && isOwner
  const ownerOnly = isOwner ? undefined : tEdit('installationOwnerOnly')
  // Mounted only while open, so the Decision catalog is not polled behind a closed menu.
  const { block: decisionBlock } = useRepositoryDecision(agent, agent.repositorySelector)
  const rowClass = 'flex min-h-[38px] min-w-0 items-center gap-2 rounded-md px-2 py-[5px] max-desktop:flex-wrap'
  const nameClass =
    'mono min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary) no-underline max-desktop:min-w-[45%]'

  return (
    <>
      <div className="fhdr">{t('additionalRepos')}</div>
      {loadError ? (
        <div className="px-2 py-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {t('repositoryGrantsError')}
        </div>
      ) : loading ? (
        <LoadingState size={18} padding={10} />
      ) : repos.length === 0 && grants.length === 0 ? (
        <div className="px-2 py-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {tEdit('noAdditionalRepositories')}
        </div>
      ) : (
        <>
          {grants.map((grant) => (
            <div key={grant.id} data-installation-grant={grant.installationId} className={rowClass}>
              <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                <GithubMark />
              </span>
              <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-primary) max-desktop:min-w-[45%]">
                {t.rich('allRepositoriesIn', {
                  account: grant.accountLogin,
                  mono: (chunks) => <span className="mono">{chunks}</span>
                })}
              </span>
              <span className="flex flex-none" title={ownerOnly}>
                <RepositoryAccessToggle
                  value={grant.access}
                  name={grant.accountLogin}
                  disabled={!grantEditable || edits.busy}
                  onChange={(access) => void edits.updateGrant(grant, { access })}
                />
              </span>
              <span className="flex flex-none" title={ownerOnly}>
                <RepositoryMaterializeSelect
                  name={grant.accountLogin}
                  options={INSTALLATION_MATERIALIZE_OPTIONS}
                  value={grant.materialize}
                  disabled={!grantEditable || edits.busy}
                  decisionBlock={decisionBlock}
                  onChange={(value) => void edits.updateGrant(grant, { materialize: value as InstallationMaterialize })}
                />
              </span>
              {canEdit && (
                <span className="flex flex-none" title={ownerOnly ?? tEdit('revokeInstallationAccess')}>
                  <button
                    type="button"
                    className={
                      !isOwner || edits.removing === grant.id
                        ? 'iconbtn pointer-events-none h-6 w-6 flex-none opacity-50'
                        : 'iconbtn h-6 w-6 flex-none'
                    }
                    aria-label={tEdit('revokeInstallationAccess')}
                    disabled={!isOwner || edits.busy}
                    onClick={() => void edits.removeGrant(grant)}
                  >
                    <Icon name={edits.removing === grant.id ? 'loader' : 'x'} size={13} />
                  </button>
                </span>
              )}
            </div>
          ))}
          {repos.map((row) => {
            const url = repositoryWebUrl(row)
            return (
              <div key={row.id} data-repository-authorization={row.id} className={rowClass}>
                <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                  <CodeHostMark provider={repoAuthProvider(row)} />
                </span>
                {url ? (
                  <a
                    className={`${nameClass} hover:underline`}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('viewRemote', { provider: CODE_HOST_PROJECTION.github.label })}
                  >
                    {row.repoFullName}
                  </a>
                ) : (
                  <span className={nameClass} title={row.repoFullName}>
                    {row.repoFullName}
                  </span>
                )}
                <RepositoryAccessToggle
                  value={row.access}
                  name={row.repoFullName}
                  disabled={!canEdit || edits.busy}
                  onChange={(access) => void edits.updateRepository(row, { access })}
                />
                <RepositoryMaterializeSelect
                  name={row.repoFullName}
                  value={repoAuthMaterialize(row)}
                  disabled={!canEdit || edits.busy}
                  decisionBlock={decisionBlock}
                  onChange={(materialize) => void edits.updateRepository(row, { materialize })}
                />
                {canEdit && (
                  <button
                    type="button"
                    className={
                      edits.removing === row.id
                        ? 'iconbtn pointer-events-none h-6 w-6 flex-none opacity-50'
                        : 'iconbtn h-6 w-6 flex-none'
                    }
                    aria-label={tEdit('revokeRepositoryAccess')}
                    title={tEdit('revokeRepositoryAccess')}
                    disabled={edits.busy}
                    onClick={() => void edits.removeRepository(row)}
                  >
                    <Icon name={edits.removing === row.id ? 'loader' : 'x'} size={13} />
                  </button>
                )}
              </div>
            )
          })}
        </>
      )}
      {edits.error && (
        <div className="px-2 py-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {edits.error}
        </div>
      )}
      {canEdit && (
        <>
          <div className="-mx-[5px] my-[5px] border-t border-(--border-subtle)" />
          <button type="button" className="fopt" onClick={onAuthorize}>
            <Icon
              name={authorizeLabel === 'manage' ? 'settings-2' : 'plus'}
              size={14}
              color="var(--text-tertiary)"
              className="flex-none"
            />
            {authorizeLabel === 'manage' ? t('manageRepository') : t('authorizeRepository')}
          </button>
        </>
      )}
    </>
  )
}
