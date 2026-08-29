'use client'

// Agent detail "Workspace" card. Design sync: the workspace options no longer
// live in the Configuration tab — they sit at the top of the Workspace tab, so
// the source, its live git state and the files below it read as one surface.
//
// One compact card, two rows:
//   1. Source — the workspace identity (a provider mark DERIVED from host +
//      credential, git-workspace-model.md §7; repo/title, status) and, on
//      the right, the HEAD commit plus the pull / view-on-remote / edit actions.
//      The pencil is the single conversion/edit entry point. Everything after
//      the identity is supplied by the caller as `WorkspaceHeaderInfo` — live
//      git state from <WorkspaceFiles> for real agents, the static mock fields
//      for demo agents.
//   2. Authorized repos — the agent's explicit repository authorizations
//      (agent-multi-repo-authorization.md §web 1). App-backed workspaces already
//      cover their workspace repo implicitly (rendered as a non-removable chip);
//      scratch workspaces have no implicit repo and may authorize any covered
//      repo; manual GitHub workspaces may list only an explicit grant for their
//      own repo so CP-owned effects can run.
//
// Grant rows are visible to anyone who can view the agent. Every editing entry
// point opens the same Edit workspace surface; the card stays a discoverable
// summary instead of owning a second add/revoke flow.

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { GithubMark, GitlabMark, LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'
import { isPoolPlacementKind, workspaceSourceOf, type Agent, type WorkspaceStatusInfo } from '@/lib/data'
import { creatorLabel, fetchAgentRepos, repoAuthProvider } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { consoleKeys } from '@/lib/swr-keys'
import { useConsoleData } from '@/lib/data-context'
import EditWorkspaceModal from '@/components/console/modals/EditWorkspaceModal'
import { REPOSITORY_ACCESS_BADGE, type WorkspaceMode } from '@/components/console/WorkspaceFormFields'

/**
 * The live half of the Source row. The card itself only knows the agent's
 * configured workspace; status/commit and the pull action come from
 * whoever holds the daemon read model (<WorkspaceFiles>) or, for demo agents,
 * straight from the mock workspace.
 */
export interface WorkspaceHeaderInfo {
  status?: WorkspaceStatusInfo | null
  /** HEAD summary, rendered `sha · time` with `title` as its tooltip. */
  commit?: { sha: string; time: string; title?: string } | null
  /** Browsable remote URL behind the view-on-remote action. */
  repoUrl?: string | null
  /** Remote label for the view action's tooltip ("GitHub", "gitlab.com", …). */
  remoteLabel?: string | null
  onPull?: () => void
  pulling?: boolean
  /** Transient pull outcome ("Already up to date."), shown after the actions. */
  pullMsg?: string | null
}

export function WorkspaceCard({
  agent,
  header,
  className
}: {
  agent: Agent
  header?: WorkspaceHeaderInfo
  className?: string
}) {
  const { activeOrg } = useOrgs()
  const { me } = useProfile()
  const { refresh, orgSetIds } = useConsoleData()
  // Pool placements do not materialize secondary roots yet, so their chips stay authorization-only.
  const poolPlaced = isPoolPlacementKind(agent.placementKind, agent.setId, orgSetIds)
  // Non-null ⇒ the unified workspace editor is open. The authorization
  // shortcut starts it directly in its additional-repository subview.
  const [editState, setEditState] = useState<{
    mode: WorkspaceMode
    authorizeRepository?: true
  } | null>(null)

  const ws = agent.workspace

  // `?editws=github|scratch` auto-opens the workspace editor on that mode (the
  // getting-started "Connect GitHub" CTA lands here with it). One-shot: the param is
  // stripped from the URL immediately so back/refresh doesn't reopen the modal.
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

  // The displayed provider is derived from host + credential (§7), never stored.
  const source = workspaceSourceOf(ws)
  const isGit = ws.mode === 'git'
  const isGithubApp = ws.mode === 'git' && ws.provider === 'github'
  const reposKey = consoleKeys.agentRepos(activeOrg?.id, agent.id)
  const {
    data: reposData,
    error: reposError,
    isLoading,
    mutate
  } = useSWR(reposKey, ([, orgId, , agentId]) => fetchAgentRepos(agentId, orgId))
  const repos = reposData ?? []
  const loadError = reposData === undefined && reposError
  const canEdit = agent.canEdit
  const manualWorkspaceAuthorized =
    ws.mode === 'git' &&
    ws.provider === undefined &&
    repos.some(
      (authorization) =>
        repoAuthProvider(authorization) === 'github' &&
        authorization.repoFullName.toLowerCase() === ws.repo.toLowerCase()
    )
  // An anonymous checkout has nothing to mint a write token from, so its
  // effective workspace access is read regardless of the stored preference.
  const workspaceAccess = ws.mode === 'git' ? (ws.provider !== undefined ? (ws.gitAccess ?? 'write') : 'read') : null
  const remoteLabel =
    header?.remoteLabel ?? (source === 'gitlab' ? 'GitLab' : source === 'github' ? 'GitHub' : 'remote')

  return (
    <div className={`card overflow-hidden max-desktop:rounded-lg ${className ?? ''}`}>
      {/* Source row — the workspace identity and its live git actions; the pencil
          owns conversion. Wraps on narrow viewports; nothing is truncated away. */}
      <div className="flex flex-wrap items-center gap-[10px] px-4 py-[9px]">
        <span className="eyebrow flex-none text-[10.5px]">Source</span>

        {isGit ? (
          <span
            className="flex h-5 w-5 flex-none items-center justify-center"
            title={
              source === 'giturl'
                ? 'Cloned from a Git URL with the host\u2019s own credentials'
                : ws.provider === undefined
                  ? 'Public repository, cloned anonymously'
                  : undefined
            }
          >
            {source === 'gitlab' ? (
              <GitlabMark />
            ) : source === 'github' ? (
              <GithubMark color="var(--text-secondary)" />
            ) : (
              <Icon name="link-2" size={16} color="var(--text-secondary)" />
            )}
          </span>
        ) : (
          <Icon name="folder" size={16} color="var(--text-tertiary)" />
        )}
        <span className="mono min-w-0 truncate text-[13px] font-semibold text-(--text-primary)">
          {ws.mode === 'scratch' ? 'Scratch workspace' : ws.repo}
        </span>
        {/* Effective workspace access stays visible next to the repository
            (product-conventions.md §Workspace navigation and repository access) —
            it is the blast radius of everything the agent pushes. */}
        {workspaceAccess && <span className={REPOSITORY_ACCESS_BADGE[workspaceAccess]}>{workspaceAccess}</span>}
        {isGit && ws.provider === undefined && source !== 'giturl' && (
          <span
            className="badge flex-none bg-(--surface-active) text-(--text-tertiary)"
            title="Public repository, cloned anonymously"
          >
            public
          </span>
        )}
        {header?.status && (
          <span className="badge flex-none" style={{ background: header.status.bg, color: header.status.text }}>
            <span className="dot h-[6px] w-[6px]" style={{ background: header.status.dot }} />
            {header.status.label}
          </span>
        )}

        <div className="min-w-[8px] flex-1" />

        {header?.commit && (
          <span
            className="mono flex-none whitespace-nowrap text-[11.5px] text-(--text-tertiary)"
            title={header.commit.title}
          >
            <span className="text-(--brand-soft-text)">{header.commit.sha}</span> · {header.commit.time}
          </span>
        )}
        {isGit && header?.onPull && (
          <button
            className={`iconbtn h-6 w-6 flex-none ${header.pulling ? 'pointer-events-none opacity-50' : ''}`}
            title="Fast-forward pull from the remote"
            onClick={header.onPull}
          >
            <Icon name="refresh-cw" size={13} />
          </button>
        )}
        {isGit && header?.repoUrl && (
          <a
            className="iconbtn flex h-6 w-6 flex-none items-center justify-center no-underline"
            title={`View on ${remoteLabel}`}
            href={header.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external-link" size={13} />
          </a>
        )}
        {canEdit && (
          <button
            className="inline-flex h-7 flex-none cursor-pointer items-center gap-[6px] rounded-[7px] border border-(--border-default) bg-(--surface-card) px-[10px] font-sans text-[12px] font-semibold leading-normal text-(--text-primary) hover:border-(--brand) hover:text-(--brand)"
            onClick={() => setEditState({ mode: source })}
          >
            <Icon name="pencil" size={12} />
            Edit workspace
          </button>
        )}
        {header?.pullMsg && (
          <span className="flex-none font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {header.pullMsg}
          </span>
        )}
      </div>

      {/* Authorized repos — chips, since a workspace rarely has more than a
          handful; the tier lives in each chip's tooltip. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) px-4 py-[9px]">
        <span className="eyebrow flex-none text-[10.5px]">Authorized repos</span>

        {/* Only an App-backed workspace carries implicit authority over its own
            repository. A manual checkout has none: its effective access comes
            from an explicit grant below (or is `none`), so rendering a chip here
            would both claim authorization it lacks and duplicate the real row. */}
        {isGithubApp && (
          <span
            className="inline-flex h-6 flex-none items-center gap-[6px] rounded-[5px] border border-(--border-default) bg-(--surface-card) px-2"
            title="The workspace repository — authorized implicitly by the GitHub App installation"
          >
            <span className="imark h-[14px] w-[14px] border-0 bg-transparent">
              <GithubMark />
            </span>
            <span className="mono text-[11.5px] text-(--text-primary)">{ws.repo}</span>
          </span>
        )}

        {loadError ? (
          <span className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
            Couldn&rsquo;t load repository grants.
          </span>
        ) : isLoading && reposData === undefined ? (
          <LoadingState padding={0} />
        ) : (
          <>
            {repos.map((r) => (
              <span
                key={r.id}
                className="inline-flex h-6 flex-none items-center gap-[6px] rounded-[5px] border border-(--border-subtle) bg-(--surface-card) py-0 pr-1 pl-2"
                title={`${r.repoFullName} — ${r.access} access${poolPlaced ? '' : ', checked out alongside the workspace'}; added by ${creatorLabel(r.createdBy, me)}`}
              >
                <span className="imark h-[14px] w-[14px] border-0 bg-transparent">
                  {repoAuthProvider(r) === 'gitlab' ? <GitlabMark /> : <GithubMark />}
                </span>
                <span className="mono text-[11.5px] text-(--text-primary)">{r.repoFullName}</span>
                <span className={REPOSITORY_ACCESS_BADGE[r.access]}>{r.access}</span>
              </span>
            ))}
            {repos.length === 0 && !isGithubApp && (
              <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                None explicitly authorized.
              </span>
            )}
          </>
        )}

        {canEdit && (
          <button
            className="inline-flex h-6 flex-none cursor-pointer items-center gap-[5px] rounded-[5px] border border-dashed border-(--border-default) bg-transparent px-[9px] font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) hover:border-(--brand) hover:text-(--brand)"
            onClick={() =>
              setEditState({
                mode: source,
                ...(!manualWorkspaceAuthorized ? { authorizeRepository: true as const } : {})
              })
            }
          >
            <Icon name={manualWorkspaceAuthorized ? 'settings-2' : 'plus'} size={12} />
            {manualWorkspaceAuthorized ? 'Manage repository' : 'Authorize repository'}
          </button>
        )}
      </div>

      {editState && (
        <EditWorkspaceModal
          agent={agent}
          authorized={repos}
          initialMode={editState.mode}
          {...(editState.authorizeRepository ? { initialRepositoryAuthorization: {} } : {})}
          onAuthorizedChange={(rows) => {
            void mutate(rows, { revalidate: false })
          }}
          onClose={() => setEditState(null)}
          onChanged={() => {
            void mutate()
            setEditState(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}
