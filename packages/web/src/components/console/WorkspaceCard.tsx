'use client'

// Agent detail "Workspace" card (issue #457): the config tab's compact
// workspace summary. The workspace row itself opens the workspace tab; one Edit
// action in the card header owns workspace conversion and GitHub repository
// identity, working-directory, and access changes. Below it, the agent's explicit
// repository authorizations (agent-multi-repo-authorization.md §web 1). App-backed workspaces already
// cover their workspace repo implicitly; scratch workspaces have no implicit
// repo and may authorize any covered repo; manual GitHub workspaces may list
// only an explicit grant for their own repo so CP-owned effects can run.
//
// Grant rows are visible to anyone who can view the agent; authorize/revoke
// only for canEdit (canManageSharing — the DTO mirror; viewers see a read-only
// list). "Authorize repository" opens AddAgentRepoModal (the design's inline
// add-expander is skipped — established precedent: the modal owns the
// picker/tier/preflight flow).

import { useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { GithubMark, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import type { Agent } from '@/lib/data'
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

export function WorkspaceCard({
  agent,
  workspaceHref,
  className
}: {
  agent: Agent
  /** The agent's workspace-tab href (the detail view's tabHref('workspace')). */
  workspaceHref: string
  className?: string
}) {
  const { activeOrg } = useOrgs()
  const { me } = useProfile()
  const { refresh } = useConsoleData()
  const [addOpen, setAddOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const ws = agent.workspace
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
  const workspaceAccess =
    ws.mode === 'github' ? (ws.installationId ? (ws.gitAccess ?? 'write') : ('read' as const)) : null

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

  return (
    <div className={`card overflow-hidden max-desktop:rounded-lg ${className ?? ''}`}>
      <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
        <span className="font-sans text-[14px] font-semibold leading-normal">Workspace</span>
        {canEdit && (
          <>
            <button
              onClick={() => setEditOpen(true)}
              className="flex h-7 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 py-0 font-sans text-[14px] font-semibold leading-normal text-(--brand-soft-text) desktop:hidden"
            >
              <Icon name="pencil" size={14} />
              Edit
            </button>
            <Button
              variant="secondary"
              size="xs"
              className="hidden desktop:inline-flex"
              onClick={() => setEditOpen(true)}
            >
              <Icon name="pencil" size={14} />
              Edit
            </Button>
          </>
        )}
      </div>

      {/* The whole summary row drills into the workspace; editing is kept in the
          single header action so the row has no competing click targets. */}
      <Link
        className="flex w-full min-w-0 items-center gap-2 px-4 py-[11px] no-underline hover:bg-(--surface-hover)"
        href={workspaceHref}
      >
        {ws.mode === 'github' ? (
          <>
            <span className="imark h-4 w-4 border-0 bg-transparent">
              <GithubMark color="var(--text-tertiary)" />
            </span>
            <span className="mono min-w-0 truncate text-[12.5px] text-(--text-secondary)">{ws.repo}</span>
            {workspaceAccess && <span className={REPO_ACCESS_BADGE[workspaceAccess]}>{workspaceAccess}</span>}
          </>
        ) : (
          <>
            <Icon name="sparkles" size={14} color="var(--text-tertiary)" />
            <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              From scratch
            </span>
          </>
        )}
      </Link>

      {/* Viewers get no Authorize button, so the section supplies its own
          bottom breathing room (complete literal strings — never fragments). */}
      <div className={canEdit ? 'border-t border-(--border-subtle)' : 'border-t border-(--border-subtle) pb-2'}>
        <div className="eyebrow px-4 pt-[10px] text-[10.5px]">Authorized repositories</div>

        {loadError ? (
          <div className="px-4 py-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
            Couldn&rsquo;t load repository grants.
          </div>
        ) : isLoading && reposData === undefined ? (
          <LoadingState padding={16} />
        ) : (
          <>
            {repos.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-4 py-2">
                <span className="imark h-4 w-4 border-0 bg-transparent">
                  <GithubMark />
                </span>
                <span
                  className="mono min-w-0 flex-1 truncate text-[12px] text-(--text-primary)"
                  title={`${r.repoFullName} — added by ${creatorLabel(r.createdBy, me)}`}
                >
                  {r.repoFullName}
                </span>
                <span className={REPO_ACCESS_BADGE[r.access]}>{r.access}</span>
                {canEdit && (
                  <button
                    className={`iconbtn h-6 w-6 flex-none ${removing === r.id ? 'pointer-events-none opacity-50' : ''}`}
                    title="Revoke access"
                    onClick={() => void remove(r)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
            ))}
            {repos.length === 0 && (
              <div className="px-4 py-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                None explicitly authorized.
              </div>
            )}
          </>
        )}

        {err && (
          <div className="px-4 py-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-[2px] pb-[10px]">
            <button className="lnk text-[12px]" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={13} />
              Authorize repository
            </button>
          </div>
        )}
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

      {editOpen && (
        <EditWorkspaceModal
          agent={agent}
          authorized={repos}
          onClose={() => setEditOpen(false)}
          onChanged={() => {
            void mutate()
            setEditOpen(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}
