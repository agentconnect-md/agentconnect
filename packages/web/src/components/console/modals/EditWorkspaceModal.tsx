'use client'

// One workspace editor owns mode, repository, branch, working directory, and
// access. The server drains active work, replaces daemon-local files only when
// mode/repo/branch changes, and rejects edits that conflict with enabled GitHub
// review or Check actions.

import { useEffect, useMemo, useRef, useState } from 'react'
import { GithubMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { agentLabel, type Agent } from '@/lib/data'
import {
  ApiError,
  setAgentWorkspace,
  fetchAllGithubRepos,
  fetchGithubBranches,
  fetchGithubInstallations,
  fetchGithubInstallUrl,
  fetchGithubRepoAccess,
  syncGithubInstallations,
  type AgentRepoAuthDto,
  type GithubInstallationDto,
  type GithubRepoAccess,
  type GithubRepoDto
} from '@/lib/api'
import { agentDirInputValue, normalizeAgentDir } from '@/lib/repo-subdir'
import {
  GithubConnectedBanner,
  GithubInstallPrompt,
  GithubRepositoryField,
  GithubRepositoryOption,
  RepositoryAccessField,
  WorkingSubdirectoryField,
  WorkspaceBranchField,
  WorkspaceModeField
} from '@/components/console/WorkspaceFormFields'

export default function EditWorkspaceModal({
  agent,
  authorized,
  initialMode,
  onClose,
  onChanged
}: {
  agent: Agent
  /** Existing grants — pre-picked and badged, but any covered repo converts. */
  authorized: AgentRepoAuthDto[]
  /** Preselected mode — the workspace card's Source segment opens the editor
   *  already switched to the mode the user picked. Defaults to the current one. */
  initialMode?: 'scratch' | 'github'
  onClose: () => void
  onChanged: () => void
}) {
  const githubWorkspace = agent.workspace.mode === 'github' ? agent.workspace : null
  const currentWrite = githubWorkspace ? !!githubWorkspace.installationId && githubWorkspace.gitAccess !== 'read' : null
  const currentAgentDir = agentDirInputValue(githubWorkspace?.agentDir)
  const [mode, setMode] = useState<'scratch' | 'github'>(initialMode ?? agent.workspace.mode)
  const [gh, setGh] = useState<{ enabled: boolean; installations: GithubInstallationDto[] } | null>(null)
  const [ghSyncing, setGhSyncing] = useState(false)
  const [repos, setRepos] = useState<Array<GithubRepoDto & { installationId: string }> | null>(null)
  const [reposError, setReposError] = useState<'failed' | 'denied' | null>(null)
  const [reposNonce, setReposNonce] = useState(0)
  const [pick, setPick] = useState(githubWorkspace?.repo ?? authorized[0]?.repoFullName ?? '')
  const [pickOpen, setPickOpen] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const [q, setQ] = useState('')
  const [branch, setBranch] = useState(githubWorkspace?.branch ?? '')
  const [branches, setBranches] = useState<string[] | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchQ, setBranchQ] = useState('')
  const [agentDir, setAgentDir] = useState(currentAgentDir)
  const [write, setWrite] = useState(currentWrite ?? (authorized[0] ? authorized[0].access === 'write' : true))
  // Per-user authz preflight for the picked repo. null = unknown/loading —
  // never blocks; the server re-checks when the edit is submitted.
  const [probe, setProbe] = useState<GithubRepoAccess | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, saving])

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
    void Promise.all(
      gh.installations.map(async (ins) => {
        try {
          const page = await fetchAllGithubRepos(ins.id, ctrl.signal)
          return { page: page.map((r) => ({ ...r, installationId: ins.id })) }
        } catch (e) {
          const denied = e instanceof ApiError && e.code === 'GITHUB_IDENTITY_REQUIRED'
          return { error: denied ? ('denied' as const) : ('failed' as const) }
        }
      })
    ).then((batches) => {
      if (!alive) return
      // A failed roster read (GitHub outage) must not render as an empty
      // list — keep the pages that loaded and surface the gap with a retry.
      setReposError(batches.find((b) => b.error === 'denied')?.error ?? batches.find((b) => b.error)?.error ?? null)
      setRepos(batches.flatMap((b) => b.page ?? []))
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
      setRepos(null) // fresh install set ⇒ re-pull the repo list
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGhSyncing(false)
    }
  }

  const authorizedByName = useMemo(
    () => new Map(authorized.map((r) => [r.repoFullName.toLowerCase(), r])),
    [authorized]
  )
  const grantOf = (fullName: string) => authorizedByName.get(fullName.toLowerCase())

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
  // assertion deployments): read access needs ≥read, push access ≥write.
  useEffect(() => {
    setProbe(null)
    if (mode !== 'github' || !pick || !pickInstallationId) return
    const [owner, repo] = pick.split('/')
    if (!owner || !repo) return
    let alive = true
    fetchGithubRepoAccess(pickInstallationId, owner, repo)
      .then((a) => alive && setProbe(a))
      .catch(() => alive && setProbe(null)) // unknown — don't block; the server enforces on save
    return () => {
      alive = false
    }
  }, [mode, pick, pickInstallationId])

  useEffect(() => {
    setBranches(null)
    setBranchOpen(false)
    if (mode !== 'github' || !pick || !pickInstallationId) return
    const [owner, repo] = pick.split('/')
    if (!owner || !repo) return
    let alive = true
    fetchGithubBranches(pickInstallationId, owner, repo)
      .then((names) => alive && setBranches(names))
      .catch(() => alive && setBranches(null))
    return () => {
      alive = false
    }
  }, [mode, pick, pickInstallationId])

  const probeDenies = !!probe?.gated && (write ? !probe.canWrite : !probe.canRead)
  const probeNote = probeDenies
    ? probe?.denied === 'GITHUB_IDENTITY_REQUIRED'
      ? 'Your GitHub identity could not be verified — sign in with GitHub, then retry.'
      : write && probe?.canRead
        ? 'You need write access to this repository on GitHub to enable push access.'
        : 'You don’t have access to this repository on GitHub.'
    : null

  const q1 = q.trim().toLowerCase()
  const matches = (repos ?? []).filter((r) => !q1 || r.fullName.toLowerCase().includes(q1))
  // A typed owner/repo missing from a failed or stale roster refresh — the CP
  // re-validates it against the installations either way.
  const typedRepo = /^[^/\s]+\/[^/\s]+$/.test(q.trim()) ? q.trim() : null
  const typedIsListed = !!typedRepo && matches.some((r) => r.fullName.toLowerCase() === typedRepo.toLowerCase())

  let normalizedAgentDir: string | undefined
  let agentDirError: string | null = null
  try {
    normalizedAgentDir = normalizeAgentDir(agentDir)
  } catch (error) {
    agentDirError = error instanceof Error ? error.message : String(error)
  }

  const noInstall = mode === 'github' && gh !== null && (!gh.enabled || gh.installations.length === 0)
  const accessChanged = githubWorkspace !== null && write !== currentWrite
  const installationChanged =
    githubWorkspace !== null && pickInstallationId !== null && githubWorkspace.installationId !== pickInstallationId
  const repoChanged =
    mode === 'github' && (githubWorkspace === null || pick.toLowerCase() !== githubWorkspace.repo.toLowerCase())
  const branchChanged =
    mode === 'github' && githubWorkspace !== null && branch.trim() !== (githubWorkspace.branch ?? '')
  const agentDirChanged =
    mode === 'github' && githubWorkspace !== null && (normalizedAgentDir ?? '') !== currentAgentDir
  const destructiveChange = mode !== agent.workspace.mode || repoChanged || branchChanged
  const changed =
    mode !== agent.workspace.mode ||
    (mode === 'github' &&
      (githubWorkspace === null ||
        repoChanged ||
        branchChanged ||
        agentDirChanged ||
        accessChanged ||
        installationChanged))
  const canSubmit =
    changed &&
    (mode === 'scratch' || (!!pick && !uncovered && !probeDenies && agentDirError === null && !!pickInstallationId))

  const selectRepo = (fullName: string) => {
    const selected = repos?.find((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase())
    setPick(fullName)
    setPickOpen(false)
    setAccessOpen(false)
    setBranchOpen(false)
    setBranch(selected?.defaultBranch ?? '')
    setAgentDir('')
    const grant = grantOf(fullName)
    setWrite(grant ? grant.access === 'write' : true)
    setErr(null)
  }

  const submit = async () => {
    if (busyRef.current || !canSubmit) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      if (agentDirError) throw new Error(agentDirError)
      await setAgentWorkspace(
        agent.id,
        mode === 'scratch'
          ? { mode: 'scratch' }
          : {
              mode: 'github',
              repoFullName: pick,
              ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
              ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
              gitAccess: write ? 'write' : 'read'
            }
      )
      onChanged()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'GITHUB_IDENTITY_REQUIRED') {
        setErr('Your GitHub identity could not be verified — sign in with GitHub, then retry.')
      } else if (error instanceof ApiError && error.code === 'USER_NO_ACCESS') {
        setErr(
          write
            ? 'You need write access to this repository on GitHub to enable push access.'
            : 'You don’t have access to this repository on GitHub.'
        )
      } else {
        setErr(error instanceof Error ? error.message : String(error))
      }
      setSaving(false)
      busyRef.current = false
    }
  }

  return (
    <div className="scrim">
      <div className="modal">
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
            <span className="flex h-[17px] w-[17px] items-center justify-center">
              <GithubMark color="var(--text-secondary)" />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[16px] font-semibold leading-normal">Edit workspace</div>
            <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              workspace and repository access for <span className="mono">{agentLabel(agent)}</span>
            </div>
          </div>
          <button className="iconbtn" onClick={onClose} disabled={saving}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modalbody">
          <WorkspaceModeField
            className="mb-4"
            value={mode}
            onChange={(value) => {
              setMode(value)
              setPickOpen(false)
              setAccessOpen(false)
              setBranchOpen(false)
              setErr(null)
            }}
          />

          <div
            className={
              destructiveChange
                ? 'mb-4 flex items-start gap-[10px] rounded-[9px] border border-(--status-error) bg-(--surface-sunken) p-[13px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)'
                : 'mb-4 flex items-start gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) p-[13px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)'
            }
          >
            <Icon name={destructiveChange ? 'shield-alert' : 'info'} size={14} className="mt-[2px] flex-none" />
            <span>
              {destructiveChange
                ? 'Saving permanently replaces all files in the current workspace. Commit or back up anything you need first; this cannot be undone.'
                : 'Saving preserves the current workspace files, briefly stops active work, and clears cached repository credentials. Working-directory changes restart the agent in the selected subdirectory. GitHub integrations that review pull requests or report Checks require read & write access.'}
            </span>
          </div>

          {mode === 'github' &&
            (gh === null ? (
              <div className="mb-4 flex items-center gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                <Icon name="loader" size={15} className="flex-none animate-spin" />
                Checking your GitHub setup…
              </div>
            ) : !gh.enabled ? (
              <div className="mb-4 flex items-start gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                <Icon name="info" size={15} className="mt-[1px] flex-none" />
                <span>
                  The GitHub App isn&rsquo;t configured for this deployment. Configure it to enable GitHub workspaces.
                </span>
              </div>
            ) : gh.installations.length === 0 ? (
              <div className="mb-4">
                <GithubInstallPrompt
                  onInstall={() => void openGhInstall()}
                  onSync={() => void syncGh()}
                  syncing={ghSyncing}
                />
              </div>
            ) : (
              <div className="mb-4 grid grid-cols-1 gap-[14px] desktop:grid-cols-2 desktop:gap-x-7">
                <GithubConnectedBanner onManage={() => void openGhInstall()} />
                <GithubRepositoryField
                  value={pick}
                  icon={picked && !picked.private ? 'book-marked' : 'lock'}
                  loading={repos === null}
                  open={pickOpen}
                  query={q}
                  onToggle={() => {
                    setQ('')
                    setAccessOpen(false)
                    setBranchOpen(false)
                    setPickOpen((value) => !value)
                  }}
                  onClose={() => setPickOpen(false)}
                  onQueryChange={setQ}
                  error={
                    reposError === 'denied'
                      ? 'Your GitHub identity could not be verified — sign in with GitHub, then retry.'
                      : reposError === 'failed'
                        ? 'Couldn’t load repositories from GitHub — the list may be incomplete.'
                        : undefined
                  }
                  onRetry={() => {
                    setReposError(null)
                    setRepos(null)
                    setReposNonce((value) => value + 1)
                  }}
                >
                  {matches.map((repo) => {
                    const grant = grantOf(repo.fullName)
                    return (
                      <GithubRepositoryOption
                        key={repo.fullName}
                        fullName={repo.fullName}
                        icon={repo.private ? 'lock' : 'book-marked'}
                        description={
                          grant ? 'Already authorized for this agent' : (repo.description ?? 'No description')
                        }
                        badge={grant ? 'authorized' : undefined}
                        selected={pick.toLowerCase() === repo.fullName.toLowerCase()}
                        onSelect={() => selectRepo(repo.fullName)}
                      />
                    )
                  })}
                  {typedRepo && !typedIsListed && (
                    <GithubRepositoryOption
                      key={`typed:${typedRepo}`}
                      fullName={typedRepo}
                      icon="book-marked"
                      description="Use this repository — must be covered by an installation"
                      onSelect={() => selectRepo(typedRepo)}
                    />
                  )}
                  {repos !== null && matches.length === 0 && !typedRepo && !reposError && (
                    <div className="fnohit">No repositories match &ldquo;{q}&rdquo;</div>
                  )}
                  {repos === null && (
                    <div className="px-2 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      Loading repositories…
                    </div>
                  )}
                </GithubRepositoryField>

                <RepositoryAccessField
                  repositorySelected={!!pick}
                  value={write ? 'write' : 'read'}
                  open={accessOpen}
                  onToggle={() => {
                    setPickOpen(false)
                    setBranchOpen(false)
                    setAccessOpen((value) => !value)
                  }}
                  onClose={() => setAccessOpen(false)}
                  onChange={(value) => {
                    setWrite(value === 'write')
                    setAccessOpen(false)
                    setErr(null)
                  }}
                />

                <WorkspaceBranchField
                  repositorySelected={!!pick}
                  value={branch}
                  branches={branches}
                  defaultBranch={picked?.defaultBranch}
                  open={branchOpen}
                  query={branchQ}
                  onToggle={() => {
                    setBranchQ('')
                    setPickOpen(false)
                    setAccessOpen(false)
                    setBranchOpen((value) => !value)
                  }}
                  onClose={() => setBranchOpen(false)}
                  onQueryChange={setBranchQ}
                  onChange={(value) => {
                    setBranch(value)
                    if (branchOpen) setBranchOpen(false)
                    setErr(null)
                  }}
                />

                <WorkingSubdirectoryField
                  value={agentDir}
                  error={agentDirError}
                  onChange={(value) => {
                    setAgentDir(value)
                    setErr(null)
                  }}
                />

                {uncovered && (
                  <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
                    <Icon name="info" size={14} className="mt-[1px] flex-none" />
                    <span>
                      No GitHub App installation covers <span className="mono">{pickOwner}</span>&#32;— install (or
                      extend) the app on that account first.
                    </span>
                  </div>
                )}
                {!uncovered && probeNote && (
                  <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error) desktop:col-span-2">
                    <Icon name="shield-alert" size={14} className="mt-[1px] flex-none" />
                    <span>{probeNote}</span>
                  </div>
                )}
              </div>
            ))}

          {err && <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
        </div>

        <div className="modalfoot">
          <span className="flex-1" />
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={saving}
            className={saving ? 'pointer-events-none opacity-50' : undefined}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit || saving || noInstall}
            className={!canSubmit || saving || noInstall ? 'pointer-events-none opacity-50' : undefined}
          >
            {saving ? 'Saving…' : destructiveChange ? 'Replace workspace' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
