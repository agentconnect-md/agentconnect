// No 'use client' here: rendered only inside a client boundary (IntegrationsView).

// The org's GitLab.com connection and the bots that act on it
// (gitlab-com-integration.md §18.1). Like the chat-platform cards the BOT is the row:
// one per agent service account, with the projects it is a member of underneath and
// the project-level actions on the project line. Like the GitHub card this is the
// management surface only: a project joins the organization where it is used — the hook
// and workspace flows — not from a picker here.
// Deployment-config opt-in: with no GitLab application configured these routes 404 and the card says so.
// Connections and projects are org-level infrastructure — visible to all, writable by non-viewers.

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { AgentIconView, GitlabMark, LoadingState } from '@/components/marks'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import {
  GITLAB_CONVERGENCE_POLL_MS,
  GITLAB_PROJECT_STATE,
  gitlabMembershipReason,
  gitlabProfileUrl,
  gitlabRoleLabel,
  gitlabStateReasonText,
  gitlabWebhookBadge
} from '@/lib/gitlab-projects'
import {
  ApiError,
  deleteGitlabProject,
  disconnectGitlabConnection,
  fetchGitlabAccounts,
  fetchGitlabConnections,
  fetchGitlabProjects,
  repairGitlabProject,
  startGitlabOauth,
  transferGitlabProject,
  type GitlabConnectionDto,
  type GitlabMembershipDto,
  type GitlabOrgAccountDto,
  type GitlabProjectBindingDto
} from '@/lib/api'

/** Machine-readable CP refusals the card says better itself (all takeover, today). */
const REFUSAL: Record<string, string> = {
  GITLAB_NO_OWN_CONNECTION:
    'Connect your own GitLab account first, with Connect my account above — a project is taken over with your own access.',
  GITLAB_CONNECTION_NOT_CONNECTED: 'Reconnect your own GitLab account first, then take the project over.',
  GITLAB_NOT_MAINTAINER: 'Your GitLab account needs Maintainer or Owner access to this project to take it over.',
  GITLAB_INSTALLER_CONNECTED: 'A connected GitLab account already manages this project.',
  GITLAB_BINDING_BUSY: 'Setup or removal is already running for this project — try again shortly.'
}

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code && REFUSAL[e.code]) return REFUSAL[e.code]!
  return e instanceof Error ? e.message : String(e)
}

/** One bot row: the account, and the bindings it is a member of, in path order. */
interface BotRow {
  account: GitlabOrgAccountDto
  projects: Array<{ binding: GitlabProjectBindingDto; membership: GitlabMembershipDto }>
}

/** Bots in the order the server returns them, each with its member projects. A binding
 *  two bots share appears under both — the membership is what the row is keyed by. */
function botRows(accounts: readonly GitlabOrgAccountDto[], bindings: readonly GitlabProjectBindingDto[]): BotRow[] {
  const byId = new Map(bindings.map((binding) => [binding.id, binding]))
  return accounts.map((account) => ({
    account,
    projects: account.memberships
      .flatMap((membership) => {
        const binding = byId.get(membership.bindingId)
        return binding ? [{ binding, membership }] : []
      })
      .sort((a, b) => a.binding.projectPath.localeCompare(b.binding.projectPath))
  }))
}

/** Managed projects no listed bot is a member of. A binding outlives its last consumer —
 *  it still owns the webhook and the deployment-global claim — so it keeps its own row. */
function orphanBindings(
  accounts: readonly GitlabOrgAccountDto[],
  bindings: readonly GitlabProjectBindingDto[]
): GitlabProjectBindingDto[] {
  const claimed = new Set(accounts.flatMap((account) => account.memberships.map((m) => m.bindingId)))
  return bindings.filter((binding) => !claimed.has(binding.id))
}

/** One managed project: its state, its webhook, and the actions that act on the binding. */
function ProjectRow({
  binding,
  membership,
  indented,
  canWrite,
  busy,
  stuck,
  onRepair,
  onRemove,
  onTransfer
}: {
  binding: GitlabProjectBindingDto
  /** The bot's hold on it; absent on a project no bot is a member of. */
  membership?: GitlabMembershipDto
  indented: boolean
  canWrite: boolean
  busy: boolean
  stuck: boolean
  onRepair: () => void
  onRemove: () => void
  onTransfer: () => void
}) {
  const reason = gitlabStateReasonText(binding.stateReason)
  const webhook = gitlabWebhookBadge(binding.webhookState)
  const why = membership ? gitlabMembershipReason(membership) : null
  // Taking a project over is only meaningful where administration has actually lost its
  // authority: a connection that is gone, or a removal waiting for one. Never on a healthy row.
  const takeable = stuck || binding.state === 'cleanup_pending'
  return (
    <div
      className={`row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px] ${
        indented ? 'pl-[34px] desktop:pl-[50px]' : ''
      }`}
      data-gitlab-project={binding.id}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
        <span className="mono min-w-0 truncate text-[12.5px]">{binding.projectPath}</span>
        {membership && (
          <span className="badge bg-(--surface-active) text-(--text-tertiary)">
            {gitlabRoleLabel(membership.accessLevel)}
          </span>
        )}
        <span className={`badge ${GITLAB_PROJECT_STATE[binding.state].badge}`}>
          {GITLAB_PROJECT_STATE[binding.state].label}
        </span>
        {/* Silent unless the webhook needs attention: not needing one is a normal state. */}
        {webhook && <span className={`badge ${webhook.badge}`}>{webhook.label}</span>}
      </div>
      <span className="flex items-center justify-end gap-3">
        {/* Only a project whose administration is stuck can be taken over — and one
            awaiting cleanup always can, since that is what unblocks its removal. */}
        {canWrite && takeable && (
          <Button variant="ghost" size="xs" disabled={busy} onClick={onTransfer}>
            <Icon name="key-round" size={13} />
            Take over
          </Button>
        )}
        {canWrite && (
          <Button variant="ghost" size="xs" disabled={busy} onClick={onRepair}>
            <Icon name="wrench" size={13} />
            {busy ? 'Working…' : 'Repair'}
          </Button>
        )}
        {canWrite && (
          <Button
            variant="ghost"
            size="xs"
            className="text-(--status-error) hover:text-(--status-error)"
            disabled={busy}
            onClick={onRemove}
          >
            <Icon name="trash-2" size={13} />
            Remove
          </Button>
        )}
      </span>
      {/* Why this bot is here at all: dropping one authorization while another stands is a change to read, not a ghost. */}
      {why && (
        <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
          {why}
        </span>
      )}
      {reason && (
        <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
          {reason}
        </span>
      )}
    </div>
  )
}

export default function GitlabCard({ canWrite }: { canWrite: boolean }) {
  // Gate on the active org like the GitHub card: before it resolves `orgBase()` throws and reads "not enabled".
  const { activeOrg, orgPath } = useOrgs()
  const { getAgent } = useConsoleData()
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

  // The bound-project set is part of the key, so adding or removing a project makes the
  // entry recorded under the old set unreachable and no action site has to invalidate it.
  const signature = [...projects.map((project) => project.id)].sort().join(',')
  const botsKey = enabled === true ? consoleKeys.gitlabAccounts(activeOrg?.id, signature) : null
  const { data: bots, mutate: rereadBots } = useSWR(botsKey, ([, orgId]) => fetchGitlabAccounts(orgId as string), {
    // Convergence runs behind hook and workspace CRUD elsewhere, and a membership can change
    // while this project set does not — so only the server can say whether to ask again.
    refreshInterval: (latest) => (latest && !latest.converging ? 0 : GITLAB_CONVERGENCE_POLL_MS),
    shouldRetryOnError: false
  })

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

  // The caller's own connected account — the only one a takeover can run on (§7.1).
  const ownConnection = connections.some((c) => c.mine && c.state === 'connected')

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
      // The takeover re-runs convergence under the new account, so the roster moves with it.
      await rereadBots()
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
      // Repair can create or heal an account and its membership while the project set stays put,
      // so the roster under this unchanged key is stale until it is re-read.
      await rereadBots()
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
      } else {
        setProjects((current) =>
          current.map((p) =>
            p.id === binding.id
              ? { ...p, state: outcome.state ?? p.state, stateReason: outcome.stateReason ?? p.stateReason }
              : p
          )
        )
        // An incomplete removal keeps the project set, so the roster it detached from does not re-key.
        await rereadBots()
      }
      setRemoving(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const accounts = bots?.accounts ?? []
  const rows = botRows(accounts, projects)
  const orphans = orphanBindings(accounts, projects)
  // How many bots a removal would take off the project — the confirmation says so plainly.
  const membersOf = (binding: GitlabProjectBindingDto): number =>
    accounts.filter((account) => account.memberships.some((m) => m.bindingId === binding.id)).length

  const projectActions = (binding: GitlabProjectBindingDto) => ({
    canWrite,
    busy: busyId === binding.id,
    stuck: stuck(binding),
    onRepair: () => repair(binding),
    onRemove: () => (stuck(binding) ? setBlocked(binding) : setRemoving(binding)),
    onTransfer: () => setTaking(binding)
  })

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          <span className="flex h-[15px] w-[15px] items-center justify-center">
            <GitlabMark />
          </span>
          GitLab
        </span>
        {/* A takeover runs on the caller's OWN account, so connecting one stays reachable
            even when the organization already lists other people's connections. */}
        {enabled === true && canWrite && !ownConnection && (
          <Button onClick={connect}>
            <Icon name="external-link" size={13} />
            {connections.length === 0 ? 'Connect GitLab' : 'Connect my account'}
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

      {enabled === true && connections.length > 0 && rows.length === 0 && projects.length === 0 && (
        <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No projects are set up yet. Pick one when you add a GitLab trigger or an agent workspace — it is set up there,
          and shows up here for repairs.
        </div>
      )}

      {/* Desktop only: below the breakpoint the row stacks, where a two-track header would label nothing. */}
      {enabled === true && rows.length > 0 && (
        <div className="row h hidden grid-cols-[minmax(0,1fr)_auto] gap-[11px] desktop:grid">
          <span>Bot</span>
          <span>State</span>
        </div>
      )}
      {enabled === true &&
        rows.map(({ account, projects: members }) => {
          const agent = getAgent(account.agentId)
          const name = agent ? agentLabel(agent) : (account.displayName ?? account.username)
          const reason = gitlabStateReasonText(account.stateReason)
          return (
            <div key={account.id} data-gitlab-bot={account.id}>
              <div className="row grid-cols-1 gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                  {/* The bot IS an agent: its face and its name lead back to that agent's page. */}
                  <Link
                    href={orgPath(`/agents/${encodeURIComponent(account.agentId)}?tab=config`)}
                    title={`Open ${name}`}
                    className="flex min-w-0 items-center gap-[10px] no-underline"
                  >
                    <span className="av h-7 w-7 flex-none rounded-[7px]">
                      <AgentIconView icon={agent?.icon} runtime={agent?.runtime || agent?.model || ''} size={28} />
                    </span>
                    <span className="min-w-0 truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary) hover:underline">
                      {name}
                    </span>
                  </Link>
                  {/* The username is deterministic, so the profile links only once the account exists. */}
                  {account.userId ? (
                    <a
                      href={gitlabProfileUrl(account.username)}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-gitlab-account={account.username}
                      className="mono min-w-0 truncate text-[12px] text-(--text-tertiary) hover:underline"
                    >
                      @{account.username}
                    </a>
                  ) : (
                    <span
                      data-gitlab-account={account.username}
                      className="mono min-w-0 truncate text-[12px] text-(--text-tertiary)"
                    >
                      @{account.username}
                    </span>
                  )}
                  <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                    {account.rootGroupPath ?? `group ${account.rootGroupId}`}
                  </span>
                  <span className={`badge ${GITLAB_PROJECT_STATE[account.state].badge}`}>
                    {GITLAB_PROJECT_STATE[account.state].label}
                  </span>
                  {account.lifecycle === 'retiring' && (
                    <span className="badge bg-(--surface-active) text-(--text-tertiary)">removing</span>
                  )}
                </div>
                {reason && (
                  <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                    {reason}
                  </span>
                )}
              </div>
              {/* An account with no project still shows, so its health can be acted on. Only a
                  retiring one is leaving: an active one was refused and is waiting for Repair. */}
              {members.length === 0 && (
                <div className="row grid-cols-1 pl-[34px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:pl-[50px]">
                  {account.lifecycle === 'retiring' || account.state === 'cleanup_pending'
                    ? 'Removing…'
                    : 'Not a member of any project yet.'}
                </div>
              )}
              {members.map(({ binding, membership }) => (
                <ProjectRow
                  key={binding.id}
                  binding={binding}
                  membership={membership}
                  indented
                  {...projectActions(binding)}
                />
              ))}
            </div>
          )
        })}

      {/* A binding outlives its last consumer — it still owns the webhook and the claim —
          so it keeps its state and its actions here rather than dropping off the card. */}
      {enabled === true && orphans.length > 0 && (
        <div data-gitlab-orphans="true">
          <div className="border-b border-(--border-subtle) bg-(--surface-app) px-4 py-[6px]">
            <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              Projects without a bot — no agent is a member yet, and the webhook stays until the project is removed.
            </span>
          </div>
          {orphans.map((binding) => (
            <ProjectRow key={binding.id} binding={binding} indented={false} {...projectActions(binding)} />
          ))}
        </div>
      )}

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
              title="Take over project"
              body={
                <>
                  Take over <span className="mono text-(--text-primary)">{taking.projectPath}</span>? GitLab is asked
                  whether your own account has Maintainer or Owner access to the project right now, and if it does, your
                  account becomes the one AgentConnect uses to set up and repair it.
                </>
              }
              verb="Take over"
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
                  Remove <span className="mono text-(--text-primary)">{removing.projectPath}</span> from this
                  organization? The webhook and every project bot on it are deleted on GitLab, and
                  {membersOf(removing) > 1
                    ? ` all ${membersOf(removing)} bots listed on it stop answering there.`
                    : ' agents stop answering there.'}{' '}
                  Nothing in the project&rsquo;s code or history changes.
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
