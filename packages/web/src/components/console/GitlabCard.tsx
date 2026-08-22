// No 'use client' here: rendered only inside a client boundary (IntegrationsView).

// The org's GitLab.com connection and the health of the projects it manages
// (gitlab-com-integration.md §18.1). Like the GitHub card this is the management
// surface only: a project joins the organization where it is used — the hook and
// workspace flows — not from a picker here.
// Deployment-config opt-in: with no GitLab application configured these routes 404 and the card says so.
// Connections and projects are org-level infrastructure — visible to all, writable by non-viewers.

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Icon } from '@/components/ui'
import { GitlabMark, LoadingState } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import { GITLAB_PROJECT_STATE } from '@/lib/gitlab-projects'
import {
  ApiError,
  deleteGitlabProject,
  disconnectGitlabConnection,
  fetchGitlabConnections,
  fetchGitlabProjects,
  repairGitlabProject,
  startGitlabOauth,
  transferGitlabProject,
  type GitlabConnectionDto,
  type GitlabProjectBindingDto
} from '@/lib/api'

// The CP records a machine category in `stateReason`; these are the ones a user can act on, in GitLab
// vocabulary. Every rotation_* variant collapses to one line — the tail (rotation_gitlab_<status>) is open-ended.
const STATE_REASON: Record<string, string> = {
  project_not_accessible: 'GitLab project is no longer accessible',
  personal_namespace_unsupported: 'Projects in a personal namespace are not supported',
  project_namespace_unknown: 'GitLab did not report the group this project belongs to',
  service_account_create_forbidden: 'Not allowed to create a project bot on GitLab',
  no_admin_connection: 'No connected GitLab account can manage this project — transfer it to your own account',
  admin_unavailable:
    'The GitLab account that set this project up can no longer manage it — reconnect that account, or transfer the project to your own',
  cleanup_failed:
    'Removal did not finish because no connected GitLab account could reach the project — reconnect it or transfer the project, then remove again',
  claim_fence_lost: 'Setup was interrupted — run Repair again',
  relay_url_unconfigured: 'This deployment has no public webhook address configured',
  provisioning_in_progress: 'Setup is already running',
  provisioning_or_cleanup_in_progress: 'Setup or removal is already running'
}

/** Machine-readable CP refusals the card says better itself (all takeover, today). */
const REFUSAL: Record<string, string> = {
  GITLAB_NO_OWN_CONNECTION: 'Connect your own GitLab account first — a project is taken over with your own access.',
  GITLAB_CONNECTION_NOT_CONNECTED: 'Reconnect your own GitLab account first, then take the project over.',
  GITLAB_NOT_MAINTAINER: 'Your GitLab account needs Maintainer or Owner access to this project to take it over.',
  GITLAB_INSTALLER_CONNECTED: 'A connected GitLab account already manages this project.',
  GITLAB_BINDING_BUSY: 'Setup or removal is already running for this project — try again shortly.'
}

/** User-facing copy for a binding's reason, or null to show nothing but the state badge — an
 *  unmapped category is an implementation identifier and never belongs on this surface. */
function stateReasonText(reason: string | null): string | null {
  if (!reason) return null
  if (reason.startsWith('rotation_')) return 'The project bot credential needs repair'
  // The gitlab_<status> family is open-ended; the actionable part is the same for all of it.
  if (reason.startsWith('gitlab_')) {
    return 'GitLab refused the last administration request — reconnect the account that manages this project, or transfer it to your own'
  }
  return STATE_REASON[reason] ?? null
}

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code && REFUSAL[e.code]) return REFUSAL[e.code]!
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
  // One pending connection action: releasing a live row, or removing a released one.
  const [pending, setPending] = useState<{ target: GitlabConnectionDto; remove: boolean } | null>(null)
  const [removing, setRemoving] = useState<GitlabProjectBindingDto | null>(null)
  const [taking, setTaking] = useState<GitlabProjectBindingDto | null>(null)
  // Removal needs an administering account: without one the saga cannot finish, so it is explained, not run.
  const [blocked, setBlocked] = useState<GitlabProjectBindingDto | null>(null)

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

  // Disconnect releases the row and keeps it; a second delete on a released row
  // with nothing left assigned to it removes the row for good.
  const release = async (target: GitlabConnectionDto) => {
    if (busyId) return
    setBusyId(target.id)
    setErr(null)
    try {
      const outcome = await disconnectGitlabConnection(target.id)
      setConnections((current) =>
        outcome.removed || !outcome.connection
          ? current.filter((c) => c.id !== target.id)
          : current.map((c) => (c.id === target.id ? outcome.connection! : c))
      )
      setPending(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  // One connection administers a project; a released or removed one can neither
  // repair nor remove it, and §9.4 lets another Maintainer take it over instead.
  const stuck = (binding: GitlabProjectBindingDto): boolean =>
    connections.find((c) => c.id === binding.installerConnectionId)?.state !== 'connected'

  const takeOver = async (binding: GitlabProjectBindingDto) => {
    if (busyId) return
    setBusyId(binding.id)
    setErr(null)
    try {
      const updated = await transferGitlabProject(binding.id)
      setProjects((current) => current.map((p) => (p.id === updated.id ? updated : p)))
      // The takeover moves a project between connections, and both counts gate their Remove.
      const fresh = await fetchGitlabConnections().catch(() => null)
      if (fresh) setConnections(fresh.connections)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      // The refusal is a sentence under the card, so the dialog closes either way.
      setTaking(null)
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
      if (outcome.removed) {
        setProjects((current) => current.filter((p) => p.id !== binding.id))
        // The count that gates connection removal lives on the connection row, so
        // freeing the last project has to be read back before Remove can appear.
        const fresh = await fetchGitlabConnections().catch(() => null)
        if (fresh) setConnections(fresh.connections)
      } else
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

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          <span className="flex h-[15px] w-[15px] items-center justify-center">
            <GitlabMark />
          </span>
          GitLab
        </span>
        {enabled === true && canWrite && connections.length === 0 && (
          <Button onClick={connect}>
            <Icon name="external-link" size={13} />
            Connect GitLab
          </Button>
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
            Connect a GitLab account with Maintainer or Owner access to your projects. You then pick a project when you
            add a trigger or an agent workspace, and AgentConnect sets up its project bot and webhook there.
          </div>
        </div>
      )}

      {enabled === true &&
        connections.map((c) => (
          <div key={c.id} data-gitlab-connection={c.id}>
            <div className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]">
              <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                  <span className="flex h-[14px] w-[14px] items-center justify-center">
                    <GitlabMark />
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
                  {/* A released row has nothing left to disconnect: it offers the finish instead. */}
                  {c.state !== 'disconnected' && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-(--status-error) hover:text-(--status-error)"
                      disabled={busyId === c.id}
                      onClick={() => setPending({ target: c, remove: false })}
                    >
                      <Icon name="unplug" size={13} />
                      Disconnect
                    </Button>
                  )}
                  {c.state === 'disconnected' && c.assignedProjects === 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-(--status-error) hover:text-(--status-error)"
                      disabled={busyId === c.id}
                      onClick={() => setPending({ target: c, remove: true })}
                    >
                      <Icon name="trash-2" size={13} />
                      Remove
                    </Button>
                  )}
                </span>
              )}
            </div>
            {c.state === 'disconnected' && c.assignedProjects > 0 && (
              <div className="border-b border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                {/* Removing those projects needs an administering account too, so it is not a way out from here. */}
                {c.assignedProjects === 1
                  ? 'This account still administers 1 project below. Transfer that project to your own GitLab account, or reconnect this one to keep managing it, before this row can go.'
                  : `This account still administers ${c.assignedProjects} projects below. Transfer those projects to your own GitLab account, or reconnect this one to keep managing them, before this row can go.`}
              </div>
            )}
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

      {enabled === true && connections.length > 0 && projects.length === 0 && (
        <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No projects are set up yet. Pick one when you add a GitLab trigger or an agent workspace — it is set up there,
          and shows up here for repairs.
        </div>
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
              {/* Only a project whose administration is stuck can be taken over (§9.4). */}
              {canWrite && (stuck(p) || p.state === 'admin_degraded') && (
                <Button variant="ghost" size="xs" disabled={busyId === p.id} onClick={() => setTaking(p)}>
                  <Icon name="key-round" size={13} />
                  Transfer
                </Button>
              )}
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
                  onClick={() => (stuck(p) ? setBlocked(p) : setRemoving(p))}
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

      {pending && (
        <div className="scrim" onClick={() => setPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ConfirmGitlab
              title={pending.remove ? 'Remove connection' : 'Disconnect GitLab'}
              body={
                pending.remove ? (
                  <>
                    Remove <span className="mono text-(--text-primary)">{pending.target.gitlabUsername}</span> from the
                    list? It has already been disconnected and administers no projects, so this only clears the row.
                    Connect GitLab again whenever you need it.
                  </>
                ) : (
                  <>
                    Disconnect <span className="mono text-(--text-primary)">{pending.target.gitlabUsername}</span>?
                    GitLab stops accepting this account for project setup and repairs. Projects you already added keep
                    running until you remove them.
                  </>
                )
              }
              verb={pending.remove ? 'Remove' : 'Disconnect'}
              icon={pending.remove ? 'trash-2' : 'unplug'}
              busy={busyId === pending.target.id}
              onClose={() => setPending(null)}
              onConfirm={() => release(pending.target)}
            />
          </div>
        </div>
      )}

      {taking && (
        <div className="scrim" onClick={() => setTaking(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ConfirmGitlab
              title="Transfer administration"
              body={
                <>
                  Take over <span className="mono text-(--text-primary)">{taking.projectPath}</span>? GitLab is asked
                  whether your own account has Maintainer or Owner access to the project right now, and if it does, your
                  account becomes the one AgentConnect uses to set up and repair it.
                </>
              }
              verb="Transfer"
              icon="key-round"
              busy={busyId === taking.id}
              danger={false}
              onClose={() => setTaking(null)}
              onConfirm={() => takeOver(taking)}
            />
          </div>
        </div>
      )}

      {blocked && (
        <div className="scrim" onClick={() => setBlocked(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ConfirmGitlab
              title="Remove project"
              body={
                <>
                  <span className="mono text-(--text-primary)">{blocked.projectPath}</span> cannot be removed yet: the
                  GitLab account that manages it is no longer connected, and removing the webhook and the project bot
                  needs one. Reconnect that account, or transfer the project to your own, then remove it.
                </>
              }
              busy={false}
              onClose={() => setBlocked(null)}
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

// One confirmation body for every dialog here: bare-verb primary, noun in the title.
// Without `onConfirm` it is guidance for an action that cannot run yet, and only closes.
function ConfirmGitlab({
  title,
  body,
  verb,
  icon,
  busy,
  danger = true,
  onClose,
  onConfirm
}: {
  title: string
  body: ReactNode
  verb?: string
  icon?: string
  busy: boolean
  danger?: boolean
  onClose: () => void
  onConfirm?: () => void
}) {
  return (
    <>
      <div className="modalhead">
        <span
          className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] ${danger ? 'bg-(--status-error-soft)' : 'bg-(--surface-active)'}`}
        >
          <span className="flex h-4 w-4 items-center justify-center">
            <GitlabMark />
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
          {onConfirm ? 'Cancel' : 'Close'}
        </Button>
        {onConfirm && verb && (
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            className={busy ? 'pointer-events-none opacity-50' : undefined}
          >
            {icon && <Icon name={icon} size={15} />}
            {busy ? 'Working…' : verb}
          </Button>
        )}
      </div>
    </>
  )
}
