// No 'use client' here: rendered only inside a client boundary (IntegrationsView).

// The org's GitLab.com connection and the projects it manages (gitlab-com-integration.md §18.1).
// Deployment-config opt-in: with no GitLab application configured these routes 404 and the card says so.
// Connections and projects are org-level infrastructure — visible to all, writable by non-viewers.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Icon } from '@/components/ui'
import { GitlabMark, LoadingState } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import { GITLAB_PROJECT_STATE } from '@/lib/gitlab-projects'
import {
  createGitlabProject,
  deleteGitlabProject,
  disconnectGitlabConnection,
  fetchGitlabConnections,
  fetchGitlabProjects,
  repairGitlabProject,
  searchGitlabProjects,
  startGitlabOauth,
  type GitlabConnectionDto,
  type GitlabProjectBindingDto,
  type GitlabProjectDto
} from '@/lib/api'

// The CP records a machine category in `stateReason`; these are the ones a user can act on, in GitLab
// vocabulary. Every rotation_* variant collapses to one line — the tail (rotation_gitlab_<status>) is open-ended.
const STATE_REASON: Record<string, string> = {
  project_not_accessible: 'GitLab project is no longer accessible',
  personal_namespace_unsupported: 'Projects in a personal namespace are not supported',
  project_namespace_unknown: 'GitLab did not report the group this project belongs to',
  service_account_create_forbidden: 'Not allowed to create a project bot on GitLab',
  no_admin_connection: 'No connected GitLab account can manage this project',
  claim_fence_lost: 'Setup was interrupted — run Repair again',
  relay_url_unconfigured: 'This deployment has no public webhook address configured',
  provisioning_in_progress: 'Setup is already running',
  provisioning_or_cleanup_in_progress: 'Setup or removal is already running'
}

/** User-facing copy for a binding's reason, or null to show nothing but the state badge — an
 *  unmapped category is an implementation identifier and never belongs on this surface. */
function stateReasonText(reason: string | null): string | null {
  if (!reason) return null
  if (reason.startsWith('rotation_')) return 'The project bot credential needs repair'
  return STATE_REASON[reason] ?? null
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function GitlabCard({ canWrite }: { canWrite: boolean }) {
  // Gate on the active org like the GitHub card: before it resolves `orgBase()` throws and reads "not enabled".
  const { activeOrg } = useOrgs()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [connections, setConnections] = useState<GitlabConnectionDto[]>([])
  const [projects, setProjects] = useState<GitlabProjectBindingDto[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<GitlabConnectionDto | null>(null)
  const [removing, setRemoving] = useState<GitlabProjectBindingDto | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    setEnabled(null)
    fetchGitlabConnections()
      .then(async ({ enabled, connections }) => {
        if (!alive) return
        setEnabled(enabled)
        setConnections(connections)
        if (!enabled) return
        const bindings = await fetchGitlabProjects()
        if (alive) setProjects(bindings)
      })
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [activeOrg])

  // Every row is listed, but the picker installs through one that can still talk to GitLab: disconnected
  // and reauth-required rows are retained, so the oldest connection is often not a usable one.
  const live = connections.find((c) => c.state === 'connected') ?? null

  // The authorization URL carries a one-shot state — mint a fresh one per click.
  const connect = async () => {
    setErr(null)
    try {
      const url = await startGitlabOauth(typeof window === 'undefined' ? undefined : window.location.pathname)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setErr(errorText(e))
    }
  }

  const disconnect = async (target: GitlabConnectionDto) => {
    if (busyId) return
    setBusyId(target.id)
    setErr(null)
    try {
      await disconnectGitlabConnection(target.id)
      setConnections((current) => current.filter((c) => c.id !== target.id))
      setDisconnecting(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const repair = async (binding: GitlabProjectBindingDto) => {
    if (busyId) return
    setBusyId(binding.id)
    setErr(null)
    try {
      const updated = await repairGitlabProject(binding.id)
      setProjects((current) => current.map((p) => (p.id === updated.id ? updated : p)))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (binding: GitlabProjectBindingDto) => {
    if (busyId) return
    setBusyId(binding.id)
    setErr(null)
    try {
      const outcome = await deleteGitlabProject(binding.id)
      // Incomplete external cleanup keeps the row, in its reported state — GitLab still holds something.
      if (outcome.removed) setProjects((current) => current.filter((p) => p.id !== binding.id))
      else
        setProjects((current) =>
          current.map((p) =>
            p.id === binding.id
              ? { ...p, state: outcome.state ?? p.state, stateReason: outcome.stateReason ?? p.stateReason }
              : p
          )
        )
      setRemoving(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const onBound = useCallback((binding: GitlabProjectBindingDto) => {
    setProjects((current) => [...current.filter((p) => p.id !== binding.id), binding])
    setAdding(false)
  }, [])

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          <span className="flex h-[15px] w-[15px] items-center justify-center">
            <GitlabMark color="var(--text-primary)" />
          </span>
          GitLab
        </span>
        {enabled === true && canWrite && (
          <span className="flex items-center gap-2">
            {live && (
              <Button variant="ghost" onClick={() => setAdding((open) => !open)}>
                <Icon name="plus" size={13} />
                Add project
              </Button>
            )}
            {connections.length === 0 && (
              <Button onClick={connect}>
                <Icon name="external-link" size={13} />
                Connect GitLab
              </Button>
            )}
          </span>
        )}
      </div>

      {enabled === null && <LoadingState size={22} padding={20} />}
      {enabled === false && (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          Not enabled on this deployment — no GitLab application is configured.
        </div>
      )}

      {enabled === true && connections.length === 0 && (
        <div className="px-4 py-7 text-center">
          <div className="font-sans text-[13px] font-semibold leading-normal">Not connected</div>
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            Connect a GitLab account with Maintainer or Owner access to your projects. AgentConnect then sets up a
            project bot and a webhook per project you add, and agents answer merge requests and issues there.
          </div>
        </div>
      )}

      {enabled === true &&
        connections.map((c) => (
          <div key={c.id}>
            <div className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]">
              <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                  <span className="flex h-[14px] w-[14px] items-center justify-center">
                    <GitlabMark color="var(--text-primary)" />
                  </span>
                </span>
                <span className="mono min-w-0 truncate text-[12.5px]">{c.gitlabUsername}</span>
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">gitlab.com</span>
                {c.state === 'reauth_required' && (
                  <span className="badge bg-(--status-paused-soft) text-(--amber-500)">reconnect needed</span>
                )}
                {c.state === 'disconnected' && (
                  <span className="badge bg-(--status-error-soft) text-(--status-error)">disconnected</span>
                )}
              </div>
              {canWrite && (
                <span className="flex items-center justify-end gap-3">
                  {c.state !== 'connected' && (
                    <Button variant="ghost" size="xs" onClick={connect}>
                      <Icon name="refresh-cw" size={13} />
                      Reconnect
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-(--status-error) hover:text-(--status-error)"
                    onClick={() => setDisconnecting(c)}
                  >
                    <Icon name="unplug" size={13} />
                    Disconnect
                  </Button>
                </span>
              )}
            </div>
            {c.state === 'reauth_required' && (
              <div
                role="status"
                className="flex flex-col items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500) desktop:flex-row desktop:items-center desktop:justify-between desktop:gap-3"
              >
                <span className="flex min-w-0 items-start gap-2">
                  <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
                  <span>
                    GitLab no longer accepts this connection. Reconnect to keep project setup and repairs working.
                  </span>
                </span>
              </div>
            )}
          </div>
        ))}

      {enabled === true && live && adding && canWrite && (
        <AddGitlabProject connectionId={live.id} bound={projects} onBound={onBound} onError={setErr} />
      )}

      {/* Desktop only: below the breakpoint the row stacks, where a two-track header would label nothing. */}
      {enabled === true && projects.length > 0 && (
        <div className="row h hidden grid-cols-[minmax(0,1fr)_auto] gap-[11px] desktop:grid">
          <span>Project</span>
          <span>State</span>
        </div>
      )}
      {enabled === true &&
        projects.map((p) => (
          <div
            key={p.id}
            className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]"
            data-gitlab-project={p.id}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
              <span className="mono min-w-0 truncate text-[12.5px]">{p.projectPath}</span>
              <span className={`badge ${GITLAB_PROJECT_STATE[p.state].badge}`}>
                {GITLAB_PROJECT_STATE[p.state].label}
              </span>
              {p.serviceAccountUsername && (
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  bot @{p.serviceAccountUsername}
                </span>
              )}
              {!p.webhookInstalled && (
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">no webhook</span>
              )}
            </div>
            <span className="flex items-center justify-end gap-3">
              {canWrite && (
                <Button variant="ghost" size="xs" disabled={busyId === p.id} onClick={() => repair(p)}>
                  <Icon name="wrench" size={13} />
                  {busyId === p.id ? 'Working…' : 'Repair'}
                </Button>
              )}
              {canWrite && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-(--status-error) hover:text-(--status-error)"
                  disabled={busyId === p.id}
                  onClick={() => setRemoving(p)}
                >
                  <Icon name="trash-2" size={13} />
                  Remove
                </Button>
              )}
            </span>
            {stateReasonText(p.stateReason) && (
              <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
                {stateReasonText(p.stateReason)}
              </span>
            )}
          </div>
        ))}

      {err && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
      )}

      {disconnecting && (
        <div className="scrim" onClick={() => setDisconnecting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ConfirmGitlab
              title="Disconnect GitLab"
              body={
                <>
                  Disconnect <span className="mono text-(--text-primary)">{disconnecting.gitlabUsername}</span>? GitLab
                  stops accepting this account for project setup and repairs. Projects you already added keep running
                  until you remove them.
                </>
              }
              verb="Disconnect"
              icon="unplug"
              busy={busyId === disconnecting.id}
              onClose={() => setDisconnecting(null)}
              onConfirm={() => disconnect(disconnecting)}
            />
          </div>
        </div>
      )}

      {removing && (
        <div className="scrim" onClick={() => setRemoving(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ConfirmGitlab
              title="Remove project"
              body={
                <>
                  Remove <span className="mono text-(--text-primary)">{removing.projectPath}</span>? The webhook and the
                  project bot are deleted on GitLab, and agents stop answering there. Nothing in the project&rsquo;s
                  code or history changes.
                </>
              }
              verb="Remove"
              icon="trash-2"
              busy={busyId === removing.id}
              onClose={() => setRemoving(null)}
              onConfirm={() => remove(removing)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// One confirmation body for both destructive actions: bare-verb primary, noun in the title.
function ConfirmGitlab({
  title,
  body,
  verb,
  icon,
  busy,
  onClose,
  onConfirm
}: {
  title: string
  body: ReactNode
  verb: string
  icon: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <span className="flex h-4 w-4 items-center justify-center">
            <GitlabMark color="var(--status-error)" />
          </span>
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{title}</span>
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">{body}</p>
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} className={busy ? 'pointer-events-none opacity-50' : undefined}>
          <Icon name={icon} size={15} />
          {busy ? 'Working…' : verb}
        </Button>
      </div>
    </>
  )
}

// The picker: GitLab searches server-side, so keystrokes settle through a debounce, not a local roster.
const SEARCH_DEBOUNCE_MS = 300

function AddGitlabProject({
  connectionId,
  bound,
  onBound,
  onError
}: {
  connectionId: string
  bound: GitlabProjectBindingDto[]
  onBound: (binding: GitlabProjectBindingDto) => void
  onError: (message: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GitlabProjectDto[]>([])
  const [loading, setLoading] = useState(false)
  const [bindingId, setBindingId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const timer = setTimeout(() => {
      searchGitlabProjects(connectionId, query.trim() ? { search: query.trim() } : {})
        .then((page) => alive && setResults(page.projects))
        .catch((e) => alive && onError(errorText(e)))
        .finally(() => alive && setLoading(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [connectionId, query, onError])

  const bind = async (project: GitlabProjectDto) => {
    if (bindingId) return
    setBindingId(project.projectId)
    onError(null)
    try {
      onBound(await createGitlabProject({ connectionId, projectId: project.projectId }))
    } catch (e) {
      onError(errorText(e))
    } finally {
      setBindingId(null)
    }
  }

  const boundIds = new Set(bound.map((b) => b.projectId))

  return (
    <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-3">
      <label className="relative flex items-center">
        <Icon
          name="search"
          size={15}
          color="var(--text-tertiary)"
          className="pointer-events-none absolute left-[11px]"
        />
        <input
          className="inp mn pl-[34px]"
          placeholder="Search your GitLab projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search GitLab projects"
        />
      </label>
      {loading && <LoadingState size={18} padding={12} />}
      {!loading && results.length === 0 && (
        <div className="py-3 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No projects matched.
        </div>
      )}
      {!loading &&
        results.map((p) => (
          <div key={p.projectId} className="flex items-center gap-3 py-[7px]">
            <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{p.path}</span>
            {boundIds.has(p.projectId) ? (
              <span className="badge bg-(--surface-active) text-(--text-tertiary)">added</span>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                disabled={bindingId !== null}
                onClick={() => bind(p)}
                ariaLabel={`Add ${p.path}`}
              >
                <Icon name="plus" size={13} />
                {bindingId === p.projectId ? 'Adding…' : 'Add'}
              </Button>
            )}
          </div>
        ))}
    </div>
  )
}
