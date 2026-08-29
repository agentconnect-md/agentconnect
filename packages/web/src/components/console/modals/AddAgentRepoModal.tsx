'use client'

// Authorize a repository for one agent (issue #457,
// agent-multi-repo-authorization.md §web 1; gitlab-com-integration.md §18.1):
// one picker per code host — GitHub repositories across the org's App
// installations, GitLab projects the connection administers — plus an access
// choice, preflighted against the per-user identity-assertion gate when the
// deployment has one. Picking a GitLab project that is not set up yet runs the
// §10.2 provisioning saga inline before the selection lands, exactly as the
// workspace and trigger pickers do.
//
// This renders its own scrim/modal overlay because Edit workspace can expose it
// as a preserved-state subview while another editor (such as GitHub hook setup)
// remains underneath. Escape closes only this layer (capture-phase listener),
// so a nested open never tears down the caller.

import { useEffect, useMemo, useRef, useState } from 'react'
import { GithubMark, GitlabMark, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { agentLabel, type Agent } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import {
  GithubPrivateReposNotice,
  GitlabNoProjectsNotice,
  GitlabProjectField,
  GitlabProjectOption
} from '@/components/console/WorkspaceFormFields'
import { matchGitlabProjects, type GitlabProjectChoice } from '@/lib/gitlab-projects'
import { useGitlabProjects } from '@/lib/use-gitlab-projects'
import {
  ApiError,
  createAgentRepo,
  fetchGithubInstallations,
  fetchGithubInstallUrl,
  fetchGithubRepoRoster,
  fetchGithubRepoAccess,
  invalidateGithubRepoRosterCache,
  repoAuthProvider,
  syncGithubInstallations,
  type AgentRepoAuthDto,
  type GithubInstallationDto,
  type GithubRepoAccess,
  type GithubRepoDto,
  type RepoAccess
} from '@/lib/api'

/** Which host the picker is offering. Grants are provider-qualified (§8.1). */
type GrantProvider = 'github' | 'gitlab'

// The two grant tiers. Read is a clone/read scope; write additionally grants
// push access, pull_requests:write for formal reviews, and actions:write for
// GitHub Actions. (The former
// `comment` middle tier was retired — it already carried PR-write, so it was
// never a genuine read-only middle ground.)
const TIERS: { v: RepoAccess; label: string; icon: string; desc: string }[] = [
  { v: 'read', label: 'Read only', icon: 'eye', desc: 'Clone & read files only' },
  {
    v: 'write',
    label: 'Read & write',
    icon: 'git-branch',
    desc: 'Push, open PRs & run GitHub Actions'
  }
]

// The same two tiers in GitLab's vocabulary — merge requests and pipelines, and a
// project rather than a repository.
const GITLAB_TIERS: { v: RepoAccess; label: string; icon: string; desc: string }[] = [
  { v: 'read', label: 'Read only', icon: 'eye', desc: 'Clone & read files only' },
  {
    v: 'write',
    label: 'Read & write',
    icon: 'git-branch',
    desc: 'Push, open merge requests & run pipelines'
  }
]

export default function AddAgentRepoModal({
  agent,
  workspaceRepo,
  authorized,
  initialRepo,
  fixedRepo,
  initialAccess,
  workspaceContext = false,
  showBack = false,
  onClose,
  onExit,
  onCreated
}: {
  agent: Agent
  /** Implicitly covered App-backed workspace repo (pinned — not grantable here). */
  workspaceRepo: string | null
  /** Existing grants — offered rows are disabled, duplicates rejected inline. */
  authorized: AgentRepoAuthDto[]
  /** Pre-selected owner/repo (the hook editor's "Authorize…" shortcut). */
  initialRepo?: string
  /** Repo locked by a manual GitHub workspace; it cannot authorize any other repo. */
  fixedRepo?: string
  /** Default access tier — the review/hook flow opens this dialog at `write`. */
  initialAccess?: RepoAccess
  /** Present this authorization step as part of the Edit workspace surface. */
  workspaceContext?: boolean
  /** The parent workspace form is preserved behind this step. */
  showBack?: boolean
  /** Close the whole parent editor while `onClose` returns to its prior view. */
  onExit?: () => void
  onClose: () => void
  onCreated: (row: AgentRepoAuthDto) => void
}) {
  const { orgPath } = useOrgs()
  // A repository locked by a manual GitHub workspace pins the host too — that arm
  // may authorize only its own repository, so the choice would be a dead end.
  const [provider, setProvider] = useState<GrantProvider>('github')
  const [gh, setGh] = useState<{ enabled: boolean; installations: GithubInstallationDto[] } | null>(null)
  const [ghSyncing, setGhSyncing] = useState(false)
  // Repos merged across every installation; partial pages render immediately
  // and each row remembers which installation owns its preflight.
  const [repos, setRepos] = useState<Array<GithubRepoDto & { installationId: string }> | null>(null)
  // At least one installation's roster failed to load — the list may be
  // incomplete, which must not read as "no repositories".
  const [reposError, setReposError] = useState<'failed' | null>(null)
  const [privateReposHidden, setPrivateReposHidden] = useState(false)
  const [reposNonce, setReposNonce] = useState(0)
  const [pick, setPick] = useState(fixedRepo ?? initialRepo ?? '')
  const [pickOpen, setPickOpen] = useState(false)
  const [q, setQ] = useState('')
  const [access, setAccess] = useState<RepoAccess>(initialAccess ?? 'read')
  // Per-user authz preflight for the picked repo. null = unknown/loading —
  // never blocks; the CP re-checks at create either way.
  const [probe, setProbe] = useState<GithubRepoAccess | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const busyRef = useRef(false)
  // GitLab arm: the connection's Maintainer-or-Owner projects merged with the ones
  // already added. Inert until the GitLab tile is picked, so a GitHub-only
  // deployment issues no GitLab request at all.
  const [glQ, setGlQ] = useState('')
  const [glPick, setGlPick] = useState('')
  const [glPickOpen, setGlPickOpen] = useState(false)
  const gl = useGitlabProjects(provider === 'gitlab', glQ)

  // Escape closes THIS layer only: capture-phase + stopPropagation beats the
  // ModalProvider's bubble-phase window listener when we're nested in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Probe installations on open; re-probe on focus ("Install GitHub app"
  // finishes in another tab, coming back should light the picker up).
  useEffect(() => {
    let alive = true
    const probeInstalls = () =>
      fetchGithubInstallations().then(
        (r) => alive && setGh(r),
        () => alive && setGh({ enabled: false, installations: [] })
      )
    void probeInstalls()
    const onFocus = () => void probeInstalls()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!gh?.enabled || gh.installations.length === 0) return
    let alive = true
    const ctrl = new AbortController()
    setPrivateReposHidden(false)
    void fetchGithubRepoRoster(gh.installations, ctrl.signal, (partial) => {
      if (alive) setRepos(partial)
    }).then(({ repos, privateReposHidden, failed }) => {
      if (!alive) return
      // A failed roster read (GitHub outage) must not render as an empty
      // list — keep the pages that loaded and surface the gap with a retry.
      setReposError(failed ? 'failed' : null)
      setPrivateReposHidden(privateReposHidden)
      setRepos(repos)
    })
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [gh, reposNonce])

  const openGhInstall = async () => {
    const url = await fetchGithubInstallUrl().catch(() => null)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  const syncGh = async () => {
    if (ghSyncing) return
    setGhSyncing(true)
    setErr(null)
    try {
      const installations = await syncGithubInstallations()
      setGh({ enabled: true, installations })
      setReposError(null)
      setPrivateReposHidden(false)
      setRepos(null) // fresh install set ⇒ re-pull the repo list
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGhSyncing(false)
    }
  }

  const authorizedByName = useMemo(
    () => new Set(authorized.filter((r) => repoAuthProvider(r) === 'github').map((r) => r.repoFullName.toLowerCase())),
    [authorized]
  )
  const isWorkspace = (fullName: string) => !!workspaceRepo && workspaceRepo.toLowerCase() === fullName.toLowerCase()
  const isAuthorized = (fullName: string) => authorizedByName.has(fullName.toLowerCase())

  // GitLab identity is the numeric project id, never the namespaced path.
  const authorizedProjects = useMemo(
    () =>
      new Set(authorized.filter((r) => repoAuthProvider(r) === 'gitlab' && r.repoId).map((r) => r.repoId as string)),
    [authorized]
  )
  const workspaceProject =
    agent.workspace.mode === 'git' && agent.workspace.provider === 'gitlab' ? agent.workspace.repoId : undefined
  const glMatches = matchGitlabProjects(gl.choices, glQ)
  const glPicked = gl.choices.find((c) => c.projectId === glPick)
  const glTakenBy = (projectId: string): 'workspace' | 'authorized' | null =>
    workspaceProject === projectId ? 'workspace' : authorizedProjects.has(projectId) ? 'authorized' : null
  const glNoProjects = gl.empty || !gl.enabled || !gl.connected

  // Picking a project that is not set up yet runs the provisioning saga first; a
  // failed setup selects nothing, so the footer stays inert (§18.1).
  const selectProject = async (choice: GitlabProjectChoice) => {
    if (!choice.binding && !(await gl.provision(choice.projectId))) return
    setGlPick(choice.projectId)
    setGlPickOpen(false)
    setErr(null)
  }

  const picked = repos?.find((r) => r.fullName.toLowerCase() === pick.toLowerCase())
  const pickOwner = pick.split('/')[0] ?? ''
  // Installation covering the pick: the picked row's own, else match the owner
  // to an installation account — mirrors the CP's liveByOrgAndAccount lookup.
  const pickInstallationId =
    picked?.installationId ??
    (gh?.installations ?? []).find((i) => i.accountLogin.toLowerCase() === pickOwner.toLowerCase())?.id ??
    null
  const uncovered = !!pick && gh !== null && gh.enabled && pickInstallationId === null

  // Preflight the caller's OWN GitHub access to the picked repo (identity-
  // assertion deployments): the read tier needs ≥read, write needs ≥write.
  useEffect(() => {
    setProbe(null)
    if (!pick || !pickInstallationId) return
    const [owner, repo] = pick.split('/')
    if (!owner || !repo) return
    let alive = true
    fetchGithubRepoAccess(pickInstallationId, owner, repo)
      .then((a) => alive && setProbe(a))
      .catch(() => alive && setProbe(null)) // unknown — don't block; the CP enforces at create
    return () => {
      alive = false
    }
  }, [pick, pickInstallationId])

  const needWrite = access === 'write'
  const probeDenies = !!probe?.gated && (needWrite ? !probe.canWrite : !probe.canRead)
  const probeNote = probeDenies
    ? probe?.identityRequired || probe?.denied === 'GITHUB_IDENTITY_REQUIRED'
      ? 'Link your GitHub profile to verify repository access, then retry.'
      : needWrite && probe?.canRead
        ? 'You need write access to this repository on GitHub to grant the write tier.'
        : 'You don’t have access to this repository on GitHub.'
    : null

  const q1 = q.trim().toLowerCase()
  const matches = (repos ?? []).filter((r) => !q1 || r.fullName.toLowerCase().includes(q1))
  // A typed owner/repo missing from a failed or stale roster refresh — the CP
  // re-validates it against the installations either way.
  const typedRepo = /^[^/\s]+\/[^/\s]+$/.test(q.trim()) ? q.trim() : null
  const typedIsListed = !!typedRepo && matches.some((r) => r.fullName.toLowerCase() === typedRepo.toLowerCase())
  const typedTaken = !!typedRepo && (isWorkspace(typedRepo) || isAuthorized(typedRepo))

  const canSubmit =
    provider === 'gitlab'
      ? !!glPick && glTakenBy(glPick) === null && gl.provisioning === null
      : !!pick && !isWorkspace(pick) && !isAuthorized(pick) && !uncovered && !probeDenies

  const submit = async () => {
    if (busyRef.current || !canSubmit) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      const row = await createAgentRepo(
        agent.id,
        provider === 'gitlab' ? { provider: 'gitlab', projectId: glPick, access } : { repoFullName: pick, access }
      )
      onCreated(row)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'GITHUB_IDENTITY_REQUIRED') {
        setErr('Link your GitHub profile to verify repository access, then retry.')
      } else if (e instanceof ApiError && e.code === 'USER_NO_ACCESS') {
        setErr(
          needWrite
            ? 'You need write access to this repository on GitHub to grant the write tier.'
            : 'You don’t have access to this repository on GitHub.'
        )
      } else {
        // 400 not-covered / 409 duplicate-or-workspace come back with the CP's
        // human-readable message — surface it verbatim.
        setErr(e instanceof Error ? e.message : String(e))
      }
      setSaving(false)
      busyRef.current = false
    }
  }

  return (
    <div className="scrim">
      <div className="modal">
        <div className="modalhead">
          {showBack ? (
            <button className="iconbtn" title="Back to workspace settings" onClick={onClose}>
              <Icon name="arrow-left" size={16} />
            </button>
          ) : (
            <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
              <span className="flex h-[17px] w-[17px] items-center justify-center">
                <GithubMark color="var(--text-secondary)" />
              </span>
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[16px] font-semibold leading-normal">
              {workspaceContext ? 'Edit workspace' : 'Add repository'}
            </div>
            <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {workspaceContext
                ? provider === 'gitlab'
                  ? 'authorize an additional project for '
                  : 'authorize an additional repository for '
                : provider === 'gitlab'
                  ? 'authorize a GitLab project for '
                  : 'authorize a GitHub repository for '}
              <span className="mono">{agentLabel(agent)}</span>
            </div>
          </div>
          <button className="iconbtn" onClick={onExit ?? onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          {/* A repository fixed by a manual GitHub workspace pins the host too. */}
          {!fixedRepo && (
            <div className="fld mb-[18px]">
              <span className="fldlbl">Code host</span>
              <div className="grid grid-cols-2 gap-[10px]">
                {(
                  [
                    {
                      v: 'github',
                      label: 'GitHub',
                      hint: 'Authorize a repository.',
                      mark: <GithubMark color="var(--text-primary)" />
                    },
                    { v: 'gitlab', label: 'GitLab', hint: 'Authorize a project.', mark: <GitlabMark /> }
                  ] as const
                ).map((host) => (
                  <button
                    key={host.v}
                    type="button"
                    className={provider === host.v ? 'ptile on items-start text-left' : 'ptile items-start text-left'}
                    onClick={() => {
                      setProvider(host.v)
                      setErr(null)
                    }}
                  >
                    <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                      <span className="flex h-4 w-4 items-center justify-center">{host.mark}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-sans text-[13px] font-semibold leading-normal">{host.label}</span>
                      <span className="mt-[2px] block truncate font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                        {host.hint}
                      </span>
                    </span>
                    <span
                      className={
                        provider === host.v
                          ? 'ml-auto flex h-4 w-4 flex-none items-center justify-center self-center rounded-full border-[1.5px] border-(--brand)'
                          : 'ml-auto flex h-4 w-4 flex-none items-center justify-center self-center rounded-full border-[1.5px] border-(--border-strong)'
                      }
                    >
                      {provider === host.v && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {provider === 'gitlab' ? (
            gl.error ? (
              <div className="mb-4 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                Couldn&rsquo;t load your GitLab projects — {gl.error}
              </div>
            ) : gl.loading ? (
              <div className="mb-4">
                <LoadingState size={20} padding={16} />
              </div>
            ) : glNoProjects ? (
              <div className="mb-4">
                <GitlabNoProjectsNotice
                  connected={gl.connected}
                  enabled={gl.enabled}
                  onConnect={() => void gl.connect()}
                  onSync={gl.reload}
                  syncing={gl.reloading}
                />
              </div>
            ) : (
              <>
                <div className="mb-[18px]">
                  <GitlabProjectField
                    value={glPicked?.projectPath ?? ''}
                    icon="book-marked"
                    loading={false}
                    open={glPickOpen}
                    query={glQ}
                    onToggle={() => {
                      setGlQ('')
                      setGlPickOpen((value) => !value)
                    }}
                    onClose={() => setGlPickOpen(false)}
                    onQueryChange={setGlQ}
                    error={gl.provisionError ? `Couldn’t set up that project — ${gl.provisionError}` : undefined}
                  >
                    {glMatches.map((choice) => {
                      const taken = glTakenBy(choice.projectId)
                      if (taken !== null) {
                        return (
                          <div key={choice.projectId} className="fnohit">
                            {choice.projectPath}
                            {taken === 'workspace'
                              ? ' is the agent’s workspace project'
                              : ' is already authorized for this agent'}
                          </div>
                        )
                      }
                      return (
                        <GitlabProjectOption
                          key={choice.projectId}
                          choice={choice}
                          selected={glPick === choice.projectId}
                          busy={gl.provisioning === choice.projectId}
                          onSelect={() => void selectProject(choice)}
                        />
                      )
                    })}
                    {glMatches.length === 0 && <div className="fnohit">No projects match &ldquo;{glQ}&rdquo;</div>}
                  </GitlabProjectField>
                </div>

                <div className="fldlbl mb-2">Access</div>
                <div className="mb-4 flex flex-col gap-[9px]">
                  {GITLAB_TIERS.map((t) => {
                    const on = access === t.v
                    return (
                      <div
                        key={t.v}
                        className={`flex cursor-pointer items-center gap-[11px] rounded-[9px] border px-[13px] py-[11px] ${
                          on ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-subtle) bg-(--surface-card)'
                        }`}
                        onClick={() => setAccess(t.v)}
                      >
                        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                          <Icon name={t.icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-sans text-[13px] font-semibold leading-normal">{t.label}</div>
                          <div className="mt-[2px] font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                            {t.desc}
                          </div>
                        </div>
                        <span
                          className={`flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] ${
                            on ? 'border-(--brand)' : 'border-(--border-strong)'
                          }`}
                        >
                          {on && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            )
          ) : gh === null ? (
            <div className="mb-4 flex items-center gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              <Icon name="loader" size={15} className="flex-none animate-spin" />
              Checking your GitHub setup…
            </div>
          ) : !gh.enabled ? (
            <div className="mb-4 flex items-start gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
              <Icon name="info" size={15} className="mt-[1px] flex-none" />
              <span>
                The GitHub App isn&rsquo;t configured for this deployment. Ask a deployment owner to configure it before
                authorizing repositories.
              </span>
            </div>
          ) : gh.installations.length === 0 ? (
            <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
              <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
                Connect GitHub to grant repos
              </div>
              <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                Install the AgentConnect GitHub app, then choose which repositories this agent can access.
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={() => void openGhInstall()}>
                  <span className="flex h-4 w-4 items-center justify-center">
                    <GithubMark color="#fff" />
                  </span>
                  Install GitHub app
                </Button>
                <button type="button" className="lnk inline-flex items-center gap-[6px]" onClick={() => void syncGh()}>
                  <Icon
                    name={ghSyncing ? 'loader' : 'refresh-cw'}
                    size={13}
                    className={ghSyncing ? 'animate-spin' : undefined}
                  />
                  I&rsquo;ve installed it — sync
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="fld relative mb-[18px] min-w-0">
                <span className="fldlbl">Repository</span>
                <div
                  className={fixedRepo ? 'inp min-w-0 cursor-default gap-2' : 'inp min-w-0 cursor-pointer gap-2'}
                  onClick={() => {
                    if (fixedRepo) return
                    setQ('')
                    setPickOpen((v) => !v)
                  }}
                >
                  <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
                    {pick ? (
                      <>
                        <Icon
                          name={picked && !picked.private ? 'book-marked' : 'lock'}
                          size={16}
                          color="var(--text-tertiary)"
                          className="flex-none"
                        />
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium leading-normal"
                          title={pick}
                        >
                          {pick}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                          <GithubMark color="var(--text-secondary)" />
                        </span>
                        <span className="truncate text-(--text-tertiary)">
                          {repos === null ? 'Loading repositories…' : 'Pick a repository'}
                        </span>
                      </>
                    )}
                  </span>
                  {!fixedRepo && <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />}
                </div>
                {privateReposHidden ? (
                  <GithubPrivateReposNotice profileHref={orgPath('/profile#sign-in-methods')} />
                ) : null}
                {!fixedRepo && pickOpen && (
                  <>
                    <div className="fscrim" onClick={() => setPickOpen(false)} />
                    <div className="fmenu left-0 right-0 z-40 min-w-0 rounded-lg p-2 shadow-(--shadow-xl)">
                      <input
                        className="fsearch h-10 rounded-md px-3 font-sans text-[13px] font-medium leading-normal"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search or type owner/repo…"
                        autoFocus
                      />
                      {reposError === 'failed' && (
                        <div className="flex items-center gap-2 px-2 py-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                          <span className="min-w-0 flex-1">
                            Couldn’t load repositories from GitHub — the list may be incomplete.
                          </span>
                          <button
                            type="button"
                            className="lnk flex-none text-[12px]"
                            onClick={() => {
                              invalidateGithubRepoRosterCache()
                              setReposError(null)
                              setPrivateReposHidden(false)
                              setRepos(null)
                              setReposNonce((n) => n + 1)
                            }}
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      {matches.map((r) => {
                        const taken = isWorkspace(r.fullName) || isAuthorized(r.fullName)
                        return (
                          <button
                            key={r.fullName}
                            className={`fopt min-h-[46px] items-center gap-3 px-2 py-2 ${taken ? 'cursor-default opacity-55' : ''}`}
                            disabled={taken}
                            onClick={() => {
                              setPick(r.fullName)
                              setPickOpen(false)
                            }}
                          >
                            <Icon
                              name={r.private ? 'lock' : 'book-marked'}
                              size={16}
                              color="var(--text-tertiary)"
                              className="flex-none"
                            />
                            <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                              <span
                                className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)"
                                title={r.fullName}
                              >
                                {r.fullName}
                              </span>
                              <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                                {isWorkspace(r.fullName)
                                  ? 'The agent’s workspace — already fully covered'
                                  : isAuthorized(r.fullName)
                                    ? 'Already authorized for this agent'
                                    : (r.description ?? 'No description')}
                              </span>
                            </span>
                            {isWorkspace(r.fullName) ? (
                              <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">
                                workspace
                              </span>
                            ) : isAuthorized(r.fullName) ? (
                              <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">
                                added
                              </span>
                            ) : (
                              pick.toLowerCase() === r.fullName.toLowerCase() && (
                                <Icon name="check" size={17} color="var(--brand)" />
                              )
                            )}
                          </button>
                        )
                      })}
                      {typedRepo && !typedIsListed && !typedTaken && (
                        <button
                          key={`typed:${typedRepo}`}
                          className="fopt min-h-[46px] items-center gap-3 px-2 py-2"
                          onClick={() => {
                            setPick(typedRepo)
                            setPickOpen(false)
                          }}
                        >
                          <Icon name="book-marked" size={16} color="var(--text-tertiary)" className="flex-none" />
                          <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                            <span className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                              {typedRepo}
                            </span>
                            <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                              Use this repository — must be covered by an installation
                            </span>
                          </span>
                        </button>
                      )}
                      {typedRepo && typedTaken && (
                        <div className="fnohit">
                          {isWorkspace(typedRepo)
                            ? `${typedRepo} is the agent’s workspace`
                            : `${typedRepo} is already authorized`}
                        </div>
                      )}
                      {repos !== null && matches.length === 0 && !typedRepo && !reposError && (
                        <div className="fnohit">No repositories match &ldquo;{q}&rdquo;</div>
                      )}
                      {repos === null && (
                        <div className="px-2 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                          Loading repositories…
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="fldlbl mb-2">Access</div>
              <div className="mb-4 flex flex-col gap-[9px]">
                {TIERS.map((t) => {
                  const on = access === t.v
                  return (
                    <div
                      key={t.v}
                      className={`flex cursor-pointer items-center gap-[11px] rounded-[9px] border px-[13px] py-[11px] ${
                        on ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-subtle) bg-(--surface-card)'
                      }`}
                      onClick={() => setAccess(t.v)}
                    >
                      <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                        <Icon name={t.icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-sans text-[13px] font-semibold leading-normal">{t.label}</div>
                        <div className="mt-[2px] font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                          {t.desc}
                        </div>
                      </div>
                      <span
                        className={`flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] ${
                          on ? 'border-(--brand)' : 'border-(--border-strong)'
                        }`}
                      >
                        {on && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
                      </span>
                    </div>
                  )
                })}
              </div>

              {uncovered && (
                <div className="mb-4 flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  <Icon name="info" size={14} className="mt-[1px] flex-none" />
                  <span>
                    No GitHub App installation covers <span className="mono">{pickOwner}</span>&#32;— install (or
                    extend) the app on that account first.
                  </span>
                </div>
              )}
              {!uncovered && probeNote && (
                <div className="mb-4 flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                  <Icon name="shield-alert" size={14} className="mt-[1px] flex-none" />
                  <span>{probeNote}</span>
                </div>
              )}
            </>
          )}
          {err && <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
        </div>
        <div className="modalfoot">
          <span className="flex-1 font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
            {provider === 'gitlab'
              ? 'Access applies only to this project and can be revoked at any time.'
              : 'Access applies only to this repository and can be revoked at any time.'}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            className={!canSubmit || saving ? 'pointer-events-none opacity-50' : undefined}
          >
            {saving ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </div>
    </div>
  )
}
