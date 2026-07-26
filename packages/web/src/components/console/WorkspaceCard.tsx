'use client'

// Agent detail "Workspace" card. Design sync: the workspace options no longer
// live in the Configuration tab — they sit at the top of the Workspace tab, so
// the source, its live git state and the files below it read as one surface.
//
// One compact card, two rows:
//   1. Source — a segment that owns workspace conversion (scratch ⇄ GitHub),
//      then the workspace identity (mark, repo/title, branch, status) and, on
//      the right, the HEAD commit plus the pull / view-on-remote / edit actions.
//      Everything after the segment is supplied by the caller as
//      `WorkspaceHeaderInfo` — live git state from <WorkspaceFiles> for real
//      agents, the static mock fields for demo agents.
//   2. Authorized repos — the agent's explicit repository authorizations
//      (agent-multi-repo-authorization.md §web 1). App-backed workspaces already
//      cover their workspace repo implicitly (rendered as a non-removable chip);
//      scratch workspaces have no implicit repo and may authorize any covered
//      repo; manual GitHub workspaces may list only an explicit grant for their
//      own repo so CP-owned effects can run.
//
// Grant rows are visible to anyone who can view the agent; conversion,
// authorize and revoke only for canEdit (canManageSharing — the DTO mirror;
// viewers see a read-only card). "Authorize repository" opens AddAgentRepoModal
// (the design's inline add-expander is skipped — established precedent: the
// modal owns the picker/tier/preflight flow).

import { useState } from 'react'
import useSWR from 'swr'
import { GithubMark, LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'
import type { Agent, WorkspaceStatusInfo } from '@/lib/data'
import { creatorLabel, deleteAgentRepo, fetchAgentRepos, type AgentRepoAuthDto, type RepoAccess } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { consoleKeys } from '@/lib/swr-keys'
import { useConsoleData } from '@/lib/data-context'
import AddAgentRepoModal from '@/components/console/modals/AddAgentRepoModal'
import EditWorkspaceModal from '@/components/console/modals/EditWorkspaceModal'

// Tier badges — complete literal class strings (the Tailwind scanner needs the
// full text in source; never assemble from fragments).
export const REPO_ACCESS_BADGE: Record<RepoAccess, string> = {
  read: 'badge flex-none bg-(--surface-active) text-(--text-tertiary)',
  comment: 'badge flex-none bg-(--brand-soft) text-(--brand-soft-text)',
  write: 'badge flex-none bg-(--status-paused-soft) text-(--amber-500)'
}

/**
 * The live half of the Source row. The card itself only knows the agent's
 * configured workspace; branch/status/commit and the pull action come from
 * whoever holds the daemon read model (<WorkspaceFiles>) or, for demo agents,
 * straight from the mock workspace.
 */
export interface WorkspaceHeaderInfo {
  /** Branch chip. Omit to fall back to the agent's configured branch. */
  branch?: string | null
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

// Segment buttons — complete literal strings, one per state.
const SEG_ON =
  'flex h-5 flex-none cursor-pointer items-center gap-[5px] rounded-[5px] border-0 bg-(--surface-card) px-2 font-sans text-[11.5px] font-semibold leading-normal text-(--text-primary) shadow-(--shadow-xs)'
const SEG_OFF =
  'flex h-5 flex-none cursor-pointer items-center gap-[5px] rounded-[5px] border-0 bg-transparent px-2 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) hover:text-(--text-primary)'
const SEG_ON_LOCKED =
  'flex h-5 flex-none cursor-default items-center gap-[5px] rounded-[5px] border-0 bg-(--surface-card) px-2 font-sans text-[11.5px] font-semibold leading-normal text-(--text-primary) shadow-(--shadow-xs)'
const SEG_OFF_LOCKED =
  'flex h-5 flex-none cursor-default items-center gap-[5px] rounded-[5px] border-0 bg-transparent px-2 font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)'

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
  const { refresh } = useConsoleData()
  const [addOpen, setAddOpen] = useState(false)
  // Non-null ⇒ the workspace editor is open, preselected on that mode.
  const [editMode, setEditMode] = useState<'scratch' | 'github' | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const ws = agent.workspace
  const isGithub = ws.mode === 'github'
  const isGithubApp = ws.mode === 'github' && !!ws.installationId
  const reposKey = consoleKeys.agentRepos(activeOrg?.id, agent.id)
  const {
    data: reposData,
    error: reposError,
    isLoading,
    mutate
  } = useSWR(reposKey, ([, orgId, , agentId]) => fetchAgentRepos(agentId, orgId))
  const repos = reposData ?? []
  const loadError = reposData === undefined && reposError
  const canEdit = agent.canManageSharing
  const branch = header?.branch ?? (ws.mode === 'github' ? ws.branch : null)
  // A manual checkout has no App installation to mint a write token from, so its
  // effective workspace access is read regardless of the stored preference.
  const workspaceAccess =
    ws.mode === 'github' ? (ws.installationId ? (ws.gitAccess ?? 'write') : ('read' as const)) : null
  const remoteLabel = header?.remoteLabel ?? 'GitHub'

  const remove = async (row: AgentRepoAuthDto) => {
    if (removing) return
    setRemoving(row.id)
    setErr(null)
    try {
      await deleteAgentRepo(agent.id, row.id)
      void mutate((rows) => rows?.filter((r) => r.id !== row.id), { revalidate: false })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(null)
    }
  }

  // The segment is the conversion entry point; picking the mode the agent is
  // already on is a no-op (the pencil edits the current source's settings).
  const pickMode = (next: 'scratch' | 'github') => {
    if (!canEdit || next === ws.mode) return
    setEditMode(next)
  }
  const segClass = (mode: 'scratch' | 'github') =>
    mode === ws.mode ? (canEdit ? SEG_ON : SEG_ON_LOCKED) : canEdit ? SEG_OFF : SEG_OFF_LOCKED

  return (
    <div className={`card overflow-hidden max-desktop:rounded-lg ${className ?? ''}`}>
      {/* Source row — conversion segment, then the workspace identity and its
          live git actions. Wraps on narrow viewports; nothing is truncated away. */}
      <div className="flex flex-wrap items-center gap-[10px] px-4 py-[9px]">
        <span className="eyebrow flex-none text-[10.5px]">Source</span>
        <span className="inline-flex flex-none gap-px rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken) p-px">
          <button
            className={segClass('github')}
            onClick={() => pickMode('github')}
            title={isGithub ? 'The workspace is a GitHub clone' : 'Convert this workspace to a GitHub repository'}
          >
            <Icon name="git-branch" size={12} />
            GitHub repo
          </button>
          <button
            className={segClass('scratch')}
            onClick={() => pickMode('scratch')}
            title={
              isGithub ? 'Convert this workspace to an empty scratch directory' : 'The workspace is a scratch directory'
            }
          >
            <Icon name="folder" size={12} />
            Scratch
          </button>
        </span>

        <span className="mx-[2px] h-[18px] w-px flex-none bg-(--border-subtle)" />

        {isGithub ? (
          <span className="flex h-5 w-5 flex-none items-center justify-center">
            <GithubMark color="var(--text-secondary)" />
          </span>
        ) : (
          <Icon name="folder" size={16} color="var(--text-tertiary)" />
        )}
        <span className="mono min-w-0 truncate text-[13px] font-semibold text-(--text-primary)">
          {ws.mode === 'github' ? ws.repo : 'Scratch workspace'}
        </span>
        {isGithub && branch && (
          <span className="scope inline-flex flex-none items-center gap-1">
            <Icon name="git-branch" size={12} />
            {branch}
          </span>
        )}
        {/* Effective workspace access stays visible next to the repository
            (product-conventions.md §Workspace navigation and repository access) —
            it is the blast radius of everything the agent pushes. */}
        {workspaceAccess && <span className={REPO_ACCESS_BADGE[workspaceAccess]}>{workspaceAccess}</span>}
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
        {isGithub && header?.onPull && (
          <button
            className={`iconbtn h-6 w-6 flex-none ${header.pulling ? 'pointer-events-none opacity-50' : ''}`}
            title="Fast-forward pull from the remote"
            onClick={header.onPull}
          >
            <Icon name="refresh-cw" size={13} />
          </button>
        )}
        {isGithub && header?.repoUrl && (
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
          <button className="iconbtn h-6 w-6 flex-none" title="Edit workspace" onClick={() => setEditMode(ws.mode)}>
            <Icon name="pencil" size={13} />
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
                title={`${r.repoFullName} — ${r.access} access, added by ${creatorLabel(r.createdBy, me)}`}
              >
                <span className="imark h-[14px] w-[14px] border-0 bg-transparent">
                  <GithubMark />
                </span>
                <span className="mono text-[11.5px] text-(--text-primary)">{r.repoFullName}</span>
                {canEdit && (
                  <button
                    className={`iconbtn h-[18px] w-[18px] flex-none ${removing === r.id ? 'pointer-events-none opacity-50' : ''}`}
                    title="Revoke access"
                    onClick={() => void remove(r)}
                  >
                    <Icon name="x" size={11} />
                  </button>
                )}
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
            onClick={() => setAddOpen(true)}
          >
            <Icon name="plus" size={12} />
            Authorize repository
          </button>
        )}

        {err && <span className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</span>}
      </div>

      {addOpen && (
        <AddAgentRepoModal
          agent={agent}
          workspaceRepo={isGithubApp ? ws.repo : null}
          authorized={repos}
          {...(ws.mode === 'github' && !isGithubApp ? { fixedRepo: ws.repo } : {})}
          onClose={() => setAddOpen(false)}
          onCreated={(row) => {
            void mutate((rows) => (rows ? [...rows, row] : [row]), { revalidate: false })
            setAddOpen(false)
          }}
        />
      )}

      {editMode && (
        <EditWorkspaceModal
          agent={agent}
          authorized={repos}
          initialMode={editMode}
          onClose={() => setEditMode(null)}
          onChanged={() => {
            void mutate()
            setEditMode(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}
