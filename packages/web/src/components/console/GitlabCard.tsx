// No 'use client' here: rendered only inside a client boundary (IntegrationsView).

// The org's GitLab.com connection and the bots that act on it
// (gitlab-com-integration.md §18.1). Like the chat-platform cards the BOT is the row:
// one per agent service account, with the projects it is a member of underneath and
// the project-level actions on the project line. Like the GitHub card this is the
// management surface only: a project joins the organization where it is used — the hook
// and workspace flows — not from a picker here.
// Deployment-config opt-in: with no GitLab application configured these routes 404 and the card says so.
// Connections and projects are org-level infrastructure — visible to all, writable by non-viewers.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { AgentIconView, GitlabMark, LoadingState } from '@/components/marks'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import {
  GITLAB_ACCOUNT_STATE,
  GITLAB_CONVERGENCE_POLL_MS,
  GITLAB_DEFAULT_INSTANCE_URL,
  GITLAB_PROJECT_STATE,
  gitlabInstanceHost,
  gitlabProfileUrl,
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

/** One bot row: an AGENT, and the account it holds in each top-level group it reaches. GitLab bot
 *  accounts cannot cross a top-level group, so one agent legitimately owns several — that is a
 *  detail of the same bot, not several bots, and the row shows them as pairs. */
interface BotRow {
  agentId: string
  accounts: GitlabOrgAccountDto[]
}

/** Bots in the order the server first names each agent, each carrying its accounts by group. */
function botRows(accounts: readonly GitlabOrgAccountDto[]): BotRow[] {
  const rows: BotRow[] = []
  for (const account of accounts) {
    const held = rows.find((row) => row.agentId === account.agentId)
    if (held) held.accounts.push(account)
    else rows.push({ agentId: account.agentId, accounts: [account] })
  }
  return rows
}

/** A project whose own state, or whose webhook, is waiting for a person. Transient states are not
 *  attention: they clear themselves, and badging them turns convergence into an alarm. */
function needsAttention(binding: GitlabProjectBindingDto): boolean {
  const settling = binding.state === 'ready' || binding.state === 'provisioning'
  return !settling || binding.webhookState === 'failed'
}

/** Managed projects no listed bot is a member of. A binding outlives its last consumer —
 *  it still owns the webhook and the deployment-global claim — so it keeps its own row. */
function orphanBindings(
  accounts: readonly GitlabOrgAccountDto[],
  bindings: readonly GitlabProjectBindingDto[]
): GitlabProjectBindingDto[] {
  const claimed = new Set(accounts.flatMap((account) => account.bindingIds))
  return bindings.filter((binding) => !claimed.has(binding.id))
}

/** One managed project: the orphan group's rows, and the ones a bot row reveals when it says a
 *  project needs attention. Removal belongs to the orphan group alone — a project a bot still
 *  holds is removed where it is used, not from under the bot. */
function ProjectRow({
  binding,
  canWrite,
  busy,
  stuck,
  indented = false,
  onRepair,
  onRemove,
  onTransfer
}: {
  binding: GitlabProjectBindingDto
  canWrite: boolean
  busy: boolean
  stuck: boolean
  indented?: boolean
  onRepair: () => void
  onRemove?: () => void
  onTransfer: () => void
}) {
  const reason = gitlabStateReasonText(binding.stateReason)
  const webhook = gitlabWebhookBadge(binding.webhookState)
  // Taking a project over is only meaningful where administration has actually lost its
  // authority: a connection that is gone, or a removal waiting for one. Never on a healthy row.
  const takeable = stuck || binding.state === 'cleanup_pending'
  return (
    <div className="row grid-cols-[minmax(0,1fr)_auto] items-center gap-[11px]" data-gitlab-project={binding.id}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
          <span className="mono min-w-0 truncate text-[12.5px]">{binding.projectPath}</span>
          <span className={`badge ${GITLAB_PROJECT_STATE[binding.state].badge}`}>
            {GITLAB_PROJECT_STATE[binding.state].label}
          </span>
          {/* Silent unless the webhook needs attention: not needing one is a normal state. */}
          {webhook && <span className={`badge ${webhook.badge}`}>{webhook.label}</span>}
        </div>
        {reason && (
          <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
            {reason}
          </div>
        )}
      </div>
      <span className="flex items-center justify-end gap-2">
        {canWrite && takeable && (
          <button className="iconbtn h-7 w-7 flex-none" title="Take over administration" onClick={onTransfer}>
            <Icon name="key-round" size={14} />
          </button>
        )}
        {canWrite && (
          <button
            className="iconbtn h-7 w-7 flex-none"
            title={busy ? 'Working…' : 'Repair this project'}
            disabled={busy}
            onClick={onRepair}
          >
            <Icon name="wrench" size={14} />
          </button>
        )}
        {canWrite && onRemove && (
          <button className="iconbtn h-7 w-7 flex-none" title="Remove this project" onClick={onRemove}>
            <Icon name="trash-2" size={14} />
          </button>
        )}
      </span>
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
  // A take-over launched from a bot row covers every project of that bot whose administration is stuck.
  const [takingBot, setTakingBot] = useState<{ name: string; bindingIds: string[] } | null>(null)
  // Which bot row is showing the held projects it says need attention.
  const [expanded, setExpanded] = useState<string | null>(null)
  // Removal needs an administering account: without one the saga cannot finish, so it is explained, not run.
  const [blocked, setBlocked] = useState<GitlabProjectBindingDto | null>(null)

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    // A different organization: nothing already in flight may speak for this one.
    supersedeReads()
    setEnabled(null)
    fetchGitlabConnections()
      .then(async ({ enabled, connections }) => {
        if (!alive) return
        setEnabled(enabled)
        setConnections(connections)
        if (!enabled) return
        // This read races the roster's own the moment the surface is enabled, so it takes a
        // generation like every other one: `alive` answers unmount, not which answer is newest.
        const seq = supersedeReads()
        const bindings = await fetchGitlabProjects()
        if (alive && seq === readSeq.current) setProjects(bindings)
      })
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [activeOrg])

  // The projects are read once and then owned by this card's own writes, so a write must be able
  // to say that the read it raced no longer speaks for them.
  const readSeq = useRef(0)
  const supersedeReads = (): number => ++readSeq.current
  // Whether the last roster answer still owed convergence, so the settling one can be recognized.
  const wasConverging = useRef(false)
  const refreshProjects = (): void => {
    const seq = supersedeReads()
    void fetchGitlabProjects()
      .then((rows) => {
        if (seq === readSeq.current) setProjects(rows)
      })
      .catch(() => undefined)
  }
  // The bound-project set is part of the key, so adding or removing a project makes the
  // entry recorded under the old set unreachable and no action site has to invalidate it.
  const signature = [...projects.map((project) => project.id)].sort().join(',')
  const botsKey = enabled === true ? consoleKeys.gitlabAccounts(activeOrg?.id, signature) : null
  const { data: bots, mutate: rereadBots } = useSWR(botsKey, ([, orgId]) => fetchGitlabAccounts(orgId as string), {
    // Convergence runs behind hook and workspace CRUD elsewhere, and a membership can change
    // while this project set does not — so only the server can say whether to ask again.
    refreshInterval: (latest) => (latest && !latest.converging ? 0 : GITLAB_CONVERGENCE_POLL_MS),
    // A held project degrades or heals on its own schedule, and the attention count on a bot row
    // reads it — so the projects ride this poll rather than resting on the read taken at mount.
    // A write in flight owns them, and leaves the edge below unconsumed for afterwards.
    onSuccess: (latest) => {
      if (busyId !== null) return
      // The answer that reports settled is the one carrying the finished state, and polling stops
      // right after it — so the pending-to-settled edge earns one last read of its own.
      const settling = wasConverging.current && !latest.converging
      wasConverging.current = latest.converging
      if (!latest.converging && !settling) return
      refreshProjects()
    },
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
      supersedeReads()
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
      supersedeReads()
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

  // A batch over several projects is not one operation: each request stands or falls alone, so the
  // card re-reads what actually happened rather than trusting either outcome of the batch.
  const refreshAfterBatch = async (): Promise<boolean> => {
    const seq = supersedeReads()
    const [fresh, conns] = await Promise.all([
      fetchGitlabProjects().catch(() => null),
      fetchGitlabConnections().catch(() => null)
    ])
    if (seq === readSeq.current) {
      if (fresh) setProjects(fresh)
      if (conns) setConnections(conns.connections)
    }
    // The bound revalidation rejects by default, and a failed re-read is a stale card, not a
    // stuck one — so it is reported, never thrown past the cleanup that re-enables the controls.
    const roster = await rereadBots().then(
      () => true,
      () => false
    )
    return fresh !== null && conns !== null && roster
  }

  const STALE_AFTER_BATCH = 'The change went through, but the card could not read the result — reload to see it.'

  /** What to say when some of a batch landed and some did not — the count first, then the reason. */
  const partialText = (verb: string, done: number, failures: readonly PromiseRejectedResult[]): string =>
    `${verb} ${done} of ${done + failures.length} projects. ${errorText(failures[0]!.reason)}`

  // Convergence for an account runs per project, so repairing a bot re-runs it on each project the
  // bot holds — including the one whose group its refused account belongs to. SEQUENTIAL: those
  // projects share one bot account, so firing them together only makes them queue on its lease.
  // The server coalesces regardless; this just keeps the common case from contending at all.
  const repairBot = async (agentId: string, bindingIds: readonly string[]) => {
    if (busyId) return
    setBusyId(agentId)
    setErr(null)
    try {
      const results: PromiseSettledResult<GitlabProjectBindingDto>[] = []
      for (const id of bindingIds) {
        results.push(
          await repairGitlabProject(id).then(
            (value): PromiseSettledResult<GitlabProjectBindingDto> => ({ status: 'fulfilled', value }),
            (reason: unknown): PromiseSettledResult<GitlabProjectBindingDto> => ({ status: 'rejected', reason })
          )
        )
      }
      const failures = results.filter((r) => r.status === 'rejected')
      // Whatever each request did, the authoritative state is the answer — never the batch's.
      const reconciled = await refreshAfterBatch()
      if (failures.length > 0) {
        setErr(
          failures.length === results.length
            ? errorText(failures[0]!.reason)
            : partialText('Repaired', results.length - failures.length, failures)
        )
      } else if (!reconciled) setErr(STALE_AFTER_BATCH)
    } finally {
      setBusyId(null)
    }
  }

  const takeOverBot = async (bindingIds: readonly string[]) => {
    if (busyId) return
    setBusyId(bindingIds.join(','))
    setErr(null)
    try {
      const results = await Promise.allSettled(bindingIds.map(async (id) => transferGitlabProject(id)))
      const failures = results.filter((r) => r.status === 'rejected')
      // A mixed outcome is expected here: the caller may hold Maintainer on some projects and not others.
      const reconciled = await refreshAfterBatch()
      if (failures.length > 0) {
        setErr(
          failures.length === results.length
            ? errorText(failures[0]!.reason)
            : partialText('Took over', results.length - failures.length, failures)
        )
      } else if (!reconciled) setErr(STALE_AFTER_BATCH)
    } finally {
      setTakingBot(null)
      setBusyId(null)
    }
  }

  const remove = async (binding: GitlabProjectBindingDto) => {
    if (busyId) return
    setBusyId(binding.id)
    setErr(null)
    try {
      const outcome = await deleteGitlabProject(binding.id)
      supersedeReads()
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

  // One deployment, one instance (§24.1), so any connection answers for all of
  // them; before the first one there is nothing to link to anyway.
  const instanceUrl = connections[0]?.instanceUrl ?? GITLAB_DEFAULT_INSTANCE_URL
  const accounts = bots?.accounts ?? []
  const rows = botRows(accounts)
  const orphans = orphanBindings(accounts, projects)
  const projectActions = (binding: GitlabProjectBindingDto, removable = true) => ({
    canWrite,
    busy: busyId === binding.id,
    stuck: stuck(binding),
    onRepair: () => repair(binding),
    ...(removable ? { onRemove: () => (stuck(binding) ? setBlocked(binding) : setRemoving(binding)) } : {}),
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
                {/* The instance, not a literal: one deployment talks to exactly one. */}
                <span className="badge bg-(--surface-active) text-(--text-tertiary)" title={c.instanceUrl}>
                  {gitlabInstanceHost(c.instanceUrl)}
                </span>
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
            {/* What the instance reports, and whether it clears the floor project
                setup needs. Silent until the first credentialed contact answers. */}
            {c.instanceVersion !== null && (
              <div className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                <span>GitLab {c.instanceVersion}</span>
                {c.instanceVersionSupported === false && (
                  <>
                    <span className="badge bg-(--status-paused-soft) text-(--amber-500)">
                      below {c.instanceVersionFloor}
                    </span>
                    <span>
                      Setting up new projects and bots needs {c.instanceVersionFloor} or later. Projects already set up
                      keep working until their credentials expire.
                    </span>
                  </>
                )}
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
          <span />
        </div>
      )}
      {enabled === true &&
        rows.map((row) => {
          const agent = getAgent(row.agentId)
          const first = row.accounts[0]!
          const name = agent ? agentLabel(agent) : (first.displayName ?? first.username)
          const repairable = [...new Set(row.accounts.flatMap((account) => account.bindingIds))]
          const held = repairable.flatMap((id) => projects.filter((project) => project.id === id))
          const takeable = held
            .filter((binding) => stuck(binding) || binding.state === 'cleanup_pending')
            .map((b) => b.id)
          // A held project's own health is invisible on this card otherwise: no project rows carry it.
          const wanting = held.filter(needsAttention)
          const open = expanded === row.agentId
          return (
            <div key={row.agentId} data-gitlab-bot={row.agentId}>
              <div className="row grid-cols-[minmax(0,1fr)_auto] items-center gap-[11px]">
                <div className="flex min-w-0 items-center gap-[10px]">
                  {/* The bot IS an agent: its face and its name lead back to that agent's page. */}
                  <Link
                    href={orgPath(`/agents/${encodeURIComponent(row.agentId)}`)}
                    title={`Open ${name}`}
                    className="flex min-w-0 flex-none items-center gap-[10px] no-underline"
                  >
                    <span className="av h-7 w-7 flex-none rounded-[7px]">
                      <AgentIconView icon={agent?.icon} runtime={agent?.runtime || agent?.model || ''} size={28} />
                    </span>
                    <span className="min-w-0 truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary) hover:underline">
                      {name}
                    </span>
                  </Link>
                  {/* One pair per top-level group the agent reaches: where, who it is there, how it is. */}
                  <div className="flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-[4px]">
                    {row.accounts.map((account) => {
                      const group = account.rootGroupPath ?? `group ${account.rootGroupId}`
                      return (
                        <span
                          key={account.id}
                          data-gitlab-account={account.username}
                          className="inline-flex min-w-0 items-center gap-[6px]"
                        >
                          {/* The group IS the link: a generated handle is long, and unreadable next to
                              a name people do read. It stays reachable by tooltip and to a screen reader.
                              The handle is deterministic, so it links only once the account exists. */}
                          {account.userId ? (
                            <a
                              href={gitlabProfileUrl(instanceUrl, account.username)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`@${account.username}`}
                              aria-label={`${group} — @${account.username} on GitLab`}
                              className="badge flex-none bg-(--surface-active) text-(--text-tertiary) no-underline hover:underline"
                            >
                              {group}
                            </a>
                          ) : (
                            <span
                              title={`@${account.username}`}
                              className="badge flex-none bg-(--surface-active) text-(--text-tertiary)"
                            >
                              {group}
                            </span>
                          )}
                          {/* A healthy bot says nothing; only trouble and departure are worth a badge. */}
                          {account.state !== 'ready' && (
                            <span className={`badge flex-none ${GITLAB_ACCOUNT_STATE[account.state].badge}`}>
                              {GITLAB_ACCOUNT_STATE[account.state].label}
                            </span>
                          )}
                          {account.lifecycle === 'retiring' && (
                            <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">
                              removing
                            </span>
                          )}
                        </span>
                      )
                    })}
                    {/* Held projects have health of their own, and no row of their own to carry it. */}
                    {wanting.length > 0 && (
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : row.agentId)}
                        className="badge flex-none cursor-pointer border-0 bg-(--status-paused-soft) text-(--amber-500)"
                      >
                        <Icon name="triangle-alert" size={11} className="mr-[3px] inline-block align-[-1px]" />
                        {wanting.length === 1
                          ? '1 project needs attention'
                          : `${wanting.length} projects need attention`}
                      </button>
                    )}
                  </div>
                </div>
                <span className="flex items-center justify-end gap-2 self-start">
                  {canWrite && takeable.length > 0 && (
                    <button
                      className="iconbtn h-7 w-7 flex-none"
                      title="Take over administration of this bot's projects"
                      onClick={() => setTakingBot({ name, bindingIds: takeable })}
                    >
                      <Icon name="key-round" size={14} />
                    </button>
                  )}
                  {canWrite && repairable.length > 0 && (
                    <button
                      className="iconbtn h-7 w-7 flex-none"
                      title={busyId === row.agentId ? 'Working…' : 'Repair this bot'}
                      disabled={busyId === row.agentId}
                      onClick={() => void repairBot(row.agentId, repairable)}
                    >
                      <Icon name="wrench" size={14} />
                    </button>
                  )}
                </span>
              </div>
              {/* Rendered, not a tooltip: an account's repair instruction has to survive a touch screen. */}
              {row.accounts.map((account) => {
                const reason = gitlabStateReasonText(account.stateReason)
                return reason ? (
                  <div
                    key={`${account.id}-reason`}
                    className="border-b border-(--border-subtle) px-4 pb-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:px-[14px]"
                  >
                    {reason}
                  </div>
                ) : null
              })}
              {open &&
                wanting.map((binding) => (
                  <ProjectRow key={binding.id} binding={binding} indented {...projectActions(binding, false)} />
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
            <ProjectRow key={binding.id} binding={binding} {...projectActions(binding)} />
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

      {takingBot && (
        <div className="scrim" onClick={() => setTakingBot(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ConfirmGitlab
              title="Take over project administration"
              body={
                <>
                  Take over the{' '}
                  {takingBot.bindingIds.length === 1 ? 'project' : `${takingBot.bindingIds.length} projects`}{' '}
                  <span className="mono text-(--text-primary)">{takingBot.name}</span> works on? GitLab is asked whether
                  your own account has Maintainer or Owner access to each one right now, and where it does, your account
                  becomes the one AgentConnect uses to set it up and repair it.
                </>
              }
              verb="Take over"
              icon="key-round"
              busy={busyId === takingBot.bindingIds.join(',')}
              danger={false}
              onClose={() => setTakingBot(null)}
              onConfirm={() => takeOverBot(takingBot.bindingIds)}
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
                  organization? The webhook and every project bot on it are deleted on GitLab, and agents stop answering
                  there. Nothing in the project&rsquo;s code or history changes.
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
