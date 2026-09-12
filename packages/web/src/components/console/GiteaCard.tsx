// No 'use client' here: rendered only inside a client boundary (IntegrationsView).

// The organization's Gitea connection and the repositories it manages
// (gitea-integration.md §4, §6, §12). Unlike the GitLab card the CONNECTION is the only
// identity — one bot user serves every agent — so the rows under it are repositories, and
// they are added here: binding one needs the bot to hold Admin on it, which is a fact about
// the bot rather than about whoever is picking.
// Deployment-config opt-in: with no Gitea instance configured these routes 404 and the card says so.
// Connections and repositories are org-level infrastructure — visible to all, writable by non-viewers.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Icon } from '@/components/ui'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import { GiteaMark, LoadingState } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import {
  GITEA_DEFAULT_INSTANCE_URL,
  GITEA_REPOSITORY_STATE,
  giteaInstanceHost,
  giteaProfileUrl,
  giteaRepositoryUrl,
  giteaStateReasonText,
  giteaWebhookBadge,
  matchGiteaRepositories,
  mergeGiteaRepositoryChoices,
  type GiteaRepositoryChoice
} from '@/lib/gitea-repositories'
import {
  ApiError,
  connectGitea,
  deleteGiteaRepository,
  disconnectGiteaConnection,
  createGiteaRepository,
  fetchGiteaConnectionRepositories,
  fetchGiteaConnections,
  fetchGiteaRepositories,
  repairGiteaRepository,
  replaceGiteaToken,
  rotateGiteaWebhookSecret,
  type GiteaConnectionDto,
  type GiteaRepositoryBindingDto,
  type GiteaRepositoryDto
} from '@/lib/api'

/** Machine-readable CP refusals the card says better itself; everything else is surfaced verbatim. */
const REFUSAL: Record<string, string> = {
  missing_scope: 'That token is missing a required scope — regenerate it in Gitea with all four, then paste it again.',
  bot_already_bound: 'That Gitea user is already the bot of another organization on this deployment.',
  connection_exists: 'This organization already has a Gitea connection — replace its token instead.',
  bot_user_mismatch:
    'That token belongs to a different Gitea user. Replacing a token keeps the same bot — disconnect first to move to another one.',
  token_missing: 'The stored token is gone — replace it to reconnect.'
}

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code && REFUSAL[e.code]) return REFUSAL[e.code]!
  return e instanceof Error ? e.message : String(e)
}

/** The bot's requirements, stated where the token is pasted (§4.1, §4.4, §15). */
function ConnectFields({
  token,
  scopes,
  busy,
  replacing,
  onTokenChange,
  onSubmit,
  onCancel
}: {
  token: string
  scopes: readonly string[]
  busy: boolean
  replacing: boolean
  onTokenChange: (value: string) => void
  onSubmit: () => void
  onCancel?: () => void
}) {
  return (
    <div className="border-b border-(--border-subtle) px-4 py-[13px]">
      <div className="fld">
        <span className="fldlbl">{replacing ? 'New bot token' : 'Bot token'}</span>
        <input
          className="inp mn font-mono text-[12.5px]"
          type="password"
          autoComplete="new-password"
          aria-label={replacing ? 'New Gitea bot token' : 'Gitea bot token'}
          placeholder="personal access token of the bot user"
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
        />
      </div>
      <div className="mt-[10px] flex flex-col gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        <span className="flex items-start gap-[6px]">
          <Icon name="key-round" size={13} className="mt-[2px] flex-none" />
          <span>
            Bot user&rsquo;s Settings &rarr; Applications, scopes{' '}
            {scopes.map((scope, index) => (
              <span key={scope}>
                {index > 0 ? ', ' : ''}
                <span className="mono text-(--text-secondary)">{scope}</span>
              </span>
            ))}
            .
          </span>
        </span>
        <span className="flex items-start gap-[6px]">
          <Icon name="users" size={13} className="mt-[2px] flex-none" />
          <span>
            Use a dedicated bot user with <span className="text-(--text-secondary)">Admin</span>&#32;on each repository
            you add. Everything an agent writes is attributed to it, and an agent can do anything the bot can.
          </span>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-[10px]">
        <Button size="sm" disabled={busy || token.trim() === ''} onClick={onSubmit}>
          <Icon name="plug" size={13} />
          {busy ? 'Checking…' : replacing ? 'Replace token' : 'Connect Gitea'}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

/** One managed repository: its state, its webhook, and the three things a person can do to it. */
function RepositoryRow({
  binding,
  instanceUrl,
  canWrite,
  busy,
  onRepair,
  onRotate,
  onRemove
}: {
  binding: GiteaRepositoryBindingDto
  instanceUrl: string
  canWrite: boolean
  busy: boolean
  onRepair: () => void
  onRotate: () => void
  onRemove: () => void
}) {
  const reason = giteaStateReasonText(binding.stateReason)
  const webhook = giteaWebhookBadge(binding.webhookState)
  return (
    <div className="row grid-cols-[minmax(0,1fr)_auto] items-center gap-[11px]" data-gitea-repository={binding.id}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
          <a
            href={giteaRepositoryUrl(instanceUrl, binding.repoPath)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${binding.repoPath} on Gitea`}
            className="mono min-w-0 truncate text-[12.5px] text-(--text-primary) no-underline hover:underline"
          >
            {binding.repoPath}
          </a>
          <span className={`badge ${GITEA_REPOSITORY_STATE[binding.state].badge}`}>
            {GITEA_REPOSITORY_STATE[binding.state].label}
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
        {canWrite && (
          <button
            className="iconbtn h-7 w-7 flex-none"
            title={busy ? 'Working…' : 'Repair this repository'}
            disabled={busy}
            onClick={onRepair}
          >
            <Icon name="wrench" size={14} />
          </button>
        )}
        {canWrite && binding.webhookState === 'installed' && (
          <button
            className="iconbtn h-7 w-7 flex-none"
            title={busy ? 'Working…' : 'Rotate the webhook signing secret'}
            disabled={busy}
            onClick={onRotate}
          >
            <Icon name="refresh-cw" size={14} />
          </button>
        )}
        {canWrite && (
          <button className="iconbtn h-7 w-7 flex-none" title="Remove this repository" onClick={onRemove}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </span>
    </div>
  )
}

export default function GiteaCard({ canWrite }: { canWrite: boolean }) {
  // Gate on the active org like the other code-host cards: before it resolves `orgBase()` throws
  // and the card would read "not enabled".
  const { activeOrg } = useOrgs()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [connection, setConnection] = useState<GiteaConnectionDto | null>(null)
  const [deploymentInstanceUrl, setDeploymentInstanceUrl] = useState<string | null>(null)
  const [bindings, setBindings] = useState<GiteaRepositoryBindingDto[]>([])
  const [candidates, setCandidates] = useState<GiteaRepositoryDto[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The token panel: absent, open for a first connect, or open to replace the stored value.
  const [tokenPanel, setTokenPanel] = useState<'connect' | 'replace' | null>(null)
  const [token, setToken] = useState('')
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<GiteaRepositoryBindingDto | null>(null)
  const [disconnecting, setDisconnecting] = useState<GiteaConnectionDto | null>(null)
  // The repositories are read once and then owned by this card's own writes, so a write must be
  // able to say that the read it raced no longer speaks for them.
  const readSeq = useRef(0)
  const supersedeReads = (): number => ++readSeq.current

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    supersedeReads()
    setEnabled(null)
    setCandidates(null)
    fetchGiteaConnections()
      .then(async ({ enabled, connections, instanceUrl }) => {
        if (!alive) return
        setEnabled(enabled)
        setConnection(connections[0] ?? null)
        if (instanceUrl) setDeploymentInstanceUrl(instanceUrl)
        if (!enabled) return
        const seq = supersedeReads()
        const rows = await fetchGiteaRepositories()
        if (alive && seq === readSeq.current) setBindings(rows)
      })
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [activeOrg])

  const refresh = async (): Promise<void> => {
    const seq = supersedeReads()
    const [conns, rows] = await Promise.all([
      fetchGiteaConnections().catch(() => null),
      fetchGiteaRepositories().catch(() => null)
    ])
    if (seq !== readSeq.current) return
    if (conns) {
      setConnection(conns.connections[0] ?? null)
      if (conns.instanceUrl) setDeploymentInstanceUrl(conns.instanceUrl)
    }
    if (rows) setBindings(rows)
  }

  const connect = async () => {
    if (busyId) return
    setBusyId('connection')
    setErr(null)
    setNotice(null)
    try {
      const record =
        tokenPanel === 'replace' && connection
          ? await replaceGiteaToken(connection.id, token.trim())
          : await connectGitea(token.trim())
      setConnection(record)
      setToken('')
      setTokenPanel(null)
      setCandidates(null)
      if (tokenPanel === 'replace') {
        setNotice('Token replaced. Revoke the old one in Gitea — AgentConnect cannot do that for you.')
        // Replacement re-converges every binding the rejected token degraded, so re-read them.
        await refresh()
      }
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const disconnect = async (target: GiteaConnectionDto) => {
    if (busyId) return
    setBusyId('connection')
    setErr(null)
    setNotice(null)
    try {
      const outcome = await disconnectGiteaConnection(target.id)
      setConnection(outcome.removed ? null : outcome.connection)
      setDisconnecting(null)
      setCandidates(null)
      if (outcome.removed) setBindings([])
      else {
        setNotice(
          outcome.pendingRepositories === 1
            ? '1 repository still has a webhook AgentConnect could not remove — fix the reason below, then disconnect again.'
            : `${outcome.pendingRepositories} repositories still have a webhook AgentConnect could not remove — fix the reasons below, then disconnect again.`
        )
        await refresh()
      }
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const repair = async (binding: GiteaRepositoryBindingDto) => {
    if (busyId) return
    setBusyId(binding.id)
    setErr(null)
    setNotice(null)
    try {
      const updated = await repairGiteaRepository(binding.id)
      supersedeReads()
      setBindings((current) => current.map((row) => (row.id === updated.id ? updated : row)))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const rotate = async (binding: GiteaRepositoryBindingDto) => {
    if (busyId) return
    setBusyId(binding.id)
    setErr(null)
    setNotice(null)
    try {
      const outcome = await rotateGiteaWebhookSecret(binding.id)
      if (!outcome.rotated) setErr(giteaStateReasonText(outcome.reason) ?? 'The webhook secret could not be rotated.')
      else if (!outcome.promoted) {
        setNotice(
          'A replacement webhook is in place. The old one is retired once Gitea delivers one event under the new key.'
        )
      } else setNotice('The webhook signing secret was replaced.')
      await refresh()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (binding: GiteaRepositoryBindingDto) => {
    if (busyId) return
    setBusyId(binding.id)
    setErr(null)
    setNotice(null)
    try {
      const outcome = await deleteGiteaRepository(binding.id)
      supersedeReads()
      // Incomplete external cleanup keeps the row, in its reported state — Gitea still holds the webhook.
      if (outcome.removed) setBindings((current) => current.filter((row) => row.id !== binding.id))
      else {
        setBindings((current) =>
          current.map((row) =>
            row.id === binding.id
              ? { ...row, state: outcome.state ?? row.state, stateReason: outcome.stateReason ?? row.stateReason }
              : row
          )
        )
      }
      setPending(null)
      setCandidates(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  // The candidates are the bot's own `admin` set (§4.4), read when the picker opens.
  const openPicker = () => {
    if (!connection) return
    setQuery('')
    setPicking(true)
    setErr(null)
    if (candidates !== null) return
    void fetchGiteaConnectionRepositories(connection.id).then(
      (rows) => setCandidates(rows),
      (e) => {
        setCandidates([])
        setErr(errorText(e))
      }
    )
  }

  const add = async (choice: GiteaRepositoryChoice) => {
    if (busyId) return
    setBusyId(choice.repoId)
    setErr(null)
    setNotice(null)
    try {
      const binding = await createGiteaRepository({ repoId: choice.repoId })
      supersedeReads()
      setBindings((current) => [...current.filter((row) => row.id !== binding.id), binding])
      setPicking(false)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  // One deployment, one instance (§3): the instance is the CARD's fact, named by the list before any connection exists.
  const instanceUrl = connection?.instanceUrl ?? deploymentInstanceUrl ?? GITEA_DEFAULT_INSTANCE_URL
  const instanceHint =
    connection?.instanceVersion == null ? instanceUrl : `${instanceUrl} · Gitea ${connection.instanceVersion}`
  const scopes = connection?.requiredScopes ?? ['read:user', 'write:repository', 'write:issue', 'read:organization']
  // Only what is not bound yet is worth offering; a bound row is already on the card.
  const offers = matchGiteaRepositories(
    mergeGiteaRepositoryChoices([], candidates ?? []).filter(
      (choice) => !bindings.some((binding) => binding.repoId === choice.repoId)
    ),
    query
  )

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          {/* The box and fill the bot tabs' marks use, so a code host reads the same size as a chat platform. */}
          <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
            <GiteaMark fillPct={SQUARE_MARK_FILL_PCT} />
          </span>
          Gitea
          {/* Which instance, and what it runs — one line of hover on the card. */}
          {enabled === true && connection !== null && (
            <span className="flex items-center text-(--text-tertiary)" data-gitea-instance="" title={instanceHint}>
              <Icon name="info" size={13} />
            </span>
          )}
        </span>
        {enabled === true && canWrite && connection === null && tokenPanel === null && (
          <Button onClick={() => setTokenPanel('connect')}>
            <Icon name="plug" size={13} />
            Connect Gitea
          </Button>
        )}
        {enabled === true && canWrite && connection !== null && (
          <Button variant="ghost" size="xs" onClick={openPicker}>
            <Icon name="plus" size={13} />
            Add repository
          </Button>
        )}
      </div>

      {/* Below the floor nothing on the instance can be set up, so the card says it once. */}
      {enabled === true && connection?.instanceVersionSupported === false && (
        <div className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          <span>Gitea {connection.instanceVersion}</span>
          <span className="badge bg-(--status-paused-soft) text-(--amber-500)">
            below {connection.instanceVersionFloor}
          </span>
          <span>
            Adding repositories and replacing the token need {connection.instanceVersionFloor} or later. Repositories
            already set up keep working.
          </span>
        </div>
      )}

      {enabled === null && <LoadingState size={22} padding={20} />}
      {enabled === false && (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          Not enabled on this deployment — no Gitea instance is configured.
        </div>
      )}

      {enabled === true && connection === null && tokenPanel === null && (
        <div className="px-4 py-7 text-center">
          <div className="font-sans text-[13px] font-semibold leading-normal">Not connected</div>
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            Create a bot user on <span className="mono text-[11.5px]">{giteaInstanceHost(instanceUrl)}</span>, give it
            Admin on the repositories you want agents to work in, and paste its personal access token here. Every
            comment, review and commit status an agent writes comes from that user.
          </div>
        </div>
      )}

      {enabled === true && canWrite && tokenPanel !== null && (
        <div data-gitea-connect="">
          <ConnectFields
            token={token}
            scopes={scopes}
            busy={busyId === 'connection'}
            replacing={tokenPanel === 'replace'}
            onTokenChange={setToken}
            onSubmit={() => void connect()}
            onCancel={() => {
              setTokenPanel(null)
              setToken('')
              setErr(null)
            }}
          />
        </div>
      )}

      {enabled === true && connection !== null && (
        <div data-gitea-connection={connection.id}>
          <div className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]">
            <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                <span className="flex h-[14px] w-[14px] items-center justify-center">
                  <GiteaMark fillPct={SQUARE_MARK_FILL_PCT} />
                </span>
              </span>
              <a
                href={giteaProfileUrl(instanceUrl, connection.botUsername)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open @${connection.botUsername} on Gitea`}
                className="mono min-w-0 truncate text-[12.5px] text-(--text-primary) no-underline hover:underline"
              >
                {connection.botUsername}
              </a>
              {connection.botDisplayName && (
                <span className="min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {connection.botDisplayName}
                </span>
              )}
              {connection.state === 'token_rejected' && (
                <span className="badge bg-(--status-paused-soft) text-(--amber-500)">token rejected</span>
              )}
              {connection.state === 'disconnecting' && (
                <span className="badge bg-(--status-error-soft) text-(--status-error)">disconnecting</span>
              )}
            </div>
            {canWrite && (
              <span className="flex items-center justify-end gap-3">
                {tokenPanel === null && (
                  <Button variant="ghost" size="xs" onClick={() => setTokenPanel('replace')}>
                    <Icon name="key-round" size={13} />
                    Replace token
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-(--status-error) hover:text-(--status-error)"
                  disabled={busyId === 'connection'}
                  onClick={() => setDisconnecting(connection)}
                >
                  <Icon name="unplug" size={13} />
                  Disconnect
                </Button>
              </span>
            )}
          </div>
          {connection.state === 'token_rejected' && (
            <div
              role="status"
              className="flex flex-col items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500) desktop:flex-row desktop:items-center desktop:justify-between desktop:gap-3"
            >
              <span className="flex min-w-0 items-start gap-2">
                <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
                <span>
                  Gitea no longer accepts this token. Gitea tokens do not expire on their own, so it was most likely
                  revoked — generate a new one for @{connection.botUsername} and replace it here.
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {enabled === true && connection !== null && bindings.length === 0 && (
        <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No repositories yet. Add one here, then point a trigger or an agent workspace at it.
        </div>
      )}

      {/* Desktop only: below the breakpoint the row stacks, where a two-track header would label nothing. */}
      {enabled === true && bindings.length > 0 && (
        <div className="row h hidden grid-cols-[minmax(0,1fr)_auto] gap-[11px] desktop:grid">
          <span>Repository</span>
          <span />
        </div>
      )}
      {enabled === true &&
        bindings.map((binding) => (
          <RepositoryRow
            key={binding.id}
            binding={binding}
            instanceUrl={instanceUrl}
            canWrite={canWrite}
            busy={busyId === binding.id}
            onRepair={() => void repair(binding)}
            onRotate={() => void rotate(binding)}
            onRemove={() => setPending(binding)}
          />
        ))}

      {notice && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {notice}
        </div>
      )}
      {err && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
      )}

      {picking && connection !== null && (
        <div className="scrim" onClick={() => setPicking(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modalhead">
              <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--surface-active)">
                <span className="flex h-4 w-4 items-center justify-center">
                  <GiteaMark />
                </span>
              </span>
              <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Add repository</span>
              <button className="iconbtn" onClick={() => setPicking(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modalbody">
              <div className="fld">
                <span className="fldlbl">Repository</span>
                <input
                  className="fsearch h-10 rounded-md px-3 font-sans text-[13px] font-medium leading-normal"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search repositories the bot administers…"
                  aria-label="Search Gitea repositories"
                  autoFocus
                />
              </div>
              <div className="mt-2 max-h-[320px] overflow-y-auto">
                {candidates === null ? (
                  <LoadingState size={20} padding={16} />
                ) : offers.length === 0 ? (
                  <div className="fnohit">
                    {query.trim()
                      ? `No repositories match “${query}”`
                      : `@${connection.botUsername} administers no repository that is not already added. Give it Admin on one in Gitea, then try again.`}
                  </div>
                ) : (
                  offers.map((choice) => (
                    <button
                      key={choice.repoId}
                      type="button"
                      data-gitea-candidate={choice.repoId}
                      className="fopt min-h-[46px] items-center gap-3 px-2 py-2"
                      disabled={busyId === choice.repoId}
                      onClick={() => void add(choice)}
                    >
                      <Icon
                        name={choice.private ? 'lock' : 'book-marked'}
                        size={16}
                        color="var(--text-tertiary)"
                        className="flex-none"
                      />
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                        <span
                          className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)"
                          title={choice.repoPath}
                        >
                          {choice.repoPath}
                        </span>
                        <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                          {busyId === choice.repoId
                            ? 'Installing the webhook…'
                            : choice.defaultBranch
                              ? `default branch ${choice.defaultBranch}`
                              : 'no default branch reported'}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
              {err && (
                <div className="mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {disconnecting && (
        <div className="scrim" onClick={() => setDisconnecting(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <ConfirmGitea
              title="Disconnect Gitea"
              body={
                <>
                  Disconnect <span className="mono text-(--text-primary)">{disconnecting.botUsername}</span>? Every
                  managed webhook is removed from Gitea first, and agents stop answering there. Revoke the token in
                  Gitea afterwards — AgentConnect cannot.
                </>
              }
              verb="Disconnect"
              icon="unplug"
              busy={busyId === 'connection'}
              onClose={() => setDisconnecting(null)}
              onConfirm={() => void disconnect(disconnecting)}
            />
          </div>
        </div>
      )}

      {pending && (
        <div className="scrim" onClick={() => setPending(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <ConfirmGitea
              title="Remove repository"
              body={
                <>
                  Remove <span className="mono text-(--text-primary)">{pending.repoPath}</span> from this organization?
                  Its managed webhook is deleted on Gitea and agents stop answering there. Nothing in the
                  repository&rsquo;s code or history changes.
                </>
              }
              verb="Remove"
              icon="trash"
              busy={busyId === pending.id}
              onClose={() => setPending(null)}
              onConfirm={() => void remove(pending)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// One confirmation body for every dialog here: bare-verb primary, noun in the title.
function ConfirmGitea({
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
            <GiteaMark />
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
