'use client'

// One workspace editor owns mode, repository, branch, working directory, and
// both workspace and additional-repository access. The server drains active
// work, replaces daemon-local files only when mode/repo/branch changes, and
// rejects edits that conflict with enabled GitHub review or Check actions.

import { useEffect, useMemo, useRef, useState } from 'react'
import { GithubMark, GitlabMark, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { agentLabel, isPoolPlacementKind, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { matchGitlabProjects, type GitlabProjectChoice } from '@/lib/gitlab-projects'
import { useGitlabProjects } from '@/lib/use-gitlab-projects'
import {
  ApiError,
  deleteAgentRepo,
  setAgentWorkspace,
  fetchGithubBranches,
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
import { fetchPublicGithubBranches } from '@/lib/github-public-repos'
import { useGithubRepoPicker, type InstalledRepo } from '@/lib/use-github-repo-picker'
import { GithubRepoPickerOptions } from '@/components/console/GithubRepoPickerOptions'
import { agentDirInputValue, normalizeAgentDir } from '@/lib/repo-subdir'
import {
  GithubConnectedBanner,
  GithubInstallPrompt,
  GithubPrivateReposNotice,
  GithubRepositoryField,
  GitlabNoProjectsNotice,
  GitlabProjectField,
  GitlabProjectOption,
  RepositoryAccessField,
  REPOSITORY_ACCESS_BADGE,
  WorktreeField,
  WorkingSubdirectoryField,
  WorkspaceBranchField,
  WorkspaceModeField,
  type WorkspaceMode
} from '@/components/console/WorkspaceFormFields'
import AddAgentRepoModal from '@/components/console/modals/AddAgentRepoModal'

/** Stable empty roster: a fresh literal would re-run the picker's lookups. */
const NO_INSTALLATIONS: GithubInstallationDto[] = []

export interface InitialRepositoryAuthorization {
  repo?: string
  access?: RepoAccess
}

export default function EditWorkspaceModal({
  agent,
  authorized,
  initialMode,
  initialRepositoryAuthorization,
  onAuthorizedChange,
  onRepositoryCreated,
  onClose,
  onChanged
}: {
  agent: Agent
  /** Existing grants — managed here and badged in the workspace picker. */
  authorized: AgentRepoAuthDto[]
  /** Preselected mode — the workspace card's Source segment opens the editor
   *  already switched to the mode the user picked. Defaults to the current one. */
  initialMode?: WorkspaceMode
  /** Open directly at the additional-repository step for contextual shortcuts. */
  initialRepositoryAuthorization?: InitialRepositoryAuthorization
  /** Keep the caller's shared repository cache synchronized after add/revoke. */
  onAuthorizedChange?: (rows: AgentRepoAuthDto[]) => void
  /** Resume a contextual flow, such as GitHub integration setup, after adding. */
  onRepositoryCreated?: (row: AgentRepoAuthDto) => void
  onClose: () => void
  onChanged: () => void
}) {
  const { orgPath } = useOrgs()
  const { orgSetIds } = useConsoleData()
  // Pool placements do not materialize secondary roots yet, so they keep the authorization-only wording.
  const poolPlaced = isPoolPlacementKind(agent.placementKind, agent.setId, orgSetIds)
  const githubWorkspace = agent.workspace.mode === 'github' ? agent.workspace : null
  const gitlabWorkspace = agent.workspace.mode === 'gitlab' ? agent.workspace : null
  const gitWorkspace = githubWorkspace ?? gitlabWorkspace
  const currentWrite = githubWorkspace
    ? !!githubWorkspace.installationId && githubWorkspace.gitAccess !== 'read'
    : gitlabWorkspace
      ? gitlabWorkspace.gitAccess !== 'read'
      : null
  const currentAgentDir = agentDirInputValue(gitWorkspace?.agentDir)
  const [mode, setMode] = useState<WorkspaceMode>(initialMode ?? agent.workspace.mode)
  const [gh, setGh] = useState<{ enabled: boolean; installations: GithubInstallationDto[] } | null>(null)
  const [ghSyncing, setGhSyncing] = useState(false)
  const [repos, setRepos] = useState<Array<GithubRepoDto & { installationId: string }> | null>(null)
  const [reposError, setReposError] = useState<'failed' | null>(null)
  const [privateReposHidden, setPrivateReposHidden] = useState(false)
  const [reposNonce, setReposNonce] = useState(0)
  const [pick, setPick] = useState(githubWorkspace?.repo ?? authorized[0]?.repoFullName ?? '')
  // A repository no installation covers, verified public by an anonymous GitHub
  // read: cloned without credentials, so read-only. A workspace that already has
  // no installation is one of these, and stays editable without re-verifying it.
  const [publicPick, setPublicPick] = useState<GithubRepoDto | null>(() =>
    githubWorkspace && !githubWorkspace.installationId
      ? {
          fullName: githubWorkspace.repo,
          private: false,
          defaultBranch: githubWorkspace.branch,
          description: null,
          updatedAt: null
        }
      : null
  )
  const [pickOpen, setPickOpen] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const [q, setQ] = useState('')
  const [branch, setBranch] = useState(gitWorkspace?.branch ?? '')
  const [branches, setBranches] = useState<string[] | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchQ, setBranchQ] = useState('')
  const [agentDir, setAgentDir] = useState(currentAgentDir)
  const [worktree, setWorktree] = useState(gitWorkspace ? gitWorkspace.worktree === true : true)
  const [glPick, setGlPick] = useState(gitlabWorkspace?.projectId ?? '')
  const [glPickOpen, setGlPickOpen] = useState(false)
  const [glQ, setGlQ] = useState('')
  const [write, setWrite] = useState(currentWrite ?? (authorized[0] ? authorized[0].access === 'write' : true))
  const [authorizations, setAuthorizations] = useState(authorized)
  const [repositoryEditor, setRepositoryEditor] = useState<{
    repo?: string
    access?: RepoAccess
    returnToWorkspace: boolean
  } | null>(() =>
    initialRepositoryAuthorization !== undefined
      ? { ...initialRepositoryAuthorization, returnToWorkspace: false }
      : null
  )
  const [removingAuthorization, setRemovingAuthorization] = useState<string | null>(null)
  const [repositoryError, setRepositoryError] = useState<string | null>(null)
  // Per-user authz preflight for the picked repo. null = unknown/loading —
  // never blocks; the server re-checks when the edit is submitted.
  const [probe, setProbe] = useState<GithubRepoAccess | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving || repositoryEditor !== null) return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, repositoryEditor, saving])

  useEffect(() => {
    setAuthorizations(authorized)
  }, [authorized])

  // Probe installations on open; re-probe on focus ("Install GitHub app"
  // finishes in another tab, coming back should light the picker up).
  useEffect(() => {
    if (repositoryEditor !== null) return
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
  }, [repositoryEditor])

  useEffect(() => {
    if (repositoryEditor !== null || !gh) return
    // No App, or none installed: the roster is empty rather than pending, so the
    // picker offers public GitHub instead of loading forever.
    if (!gh.enabled || gh.installations.length === 0) {
      setRepos([])
      return
    }
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
  }, [gh, repositoryEditor, reposNonce])

  // The projects this organization added, plus the ones the connected account can
  // still add — picking one of those sets it up here (§18.1).
  const gl = useGitlabProjects(repositoryEditor === null && mode === 'gitlab', glQ)

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

  // Keyed by github name only: `grantOf` answers questions about the GitHub arm,
  // and a GitLab project path shares no namespace with `owner/repo`.
  const authorizedByName = useMemo(
    () =>
      new Map(
        authorizations
          .filter((r) => repoAuthProvider(r) === 'github')
          .map((r) => [r.repoFullName.toLowerCase(), r] as const)
      ),
    [authorizations]
  )
  const grantOf = (fullName: string) => authorizedByName.get(fullName.toLowerCase())
  const manualWorkspaceAuthorization =
    githubWorkspace && !githubWorkspace.installationId ? grantOf(githubWorkspace.repo) : undefined

  const picked = repos?.find((r) => r.fullName.toLowerCase() === pick.toLowerCase())
  const publicSelected =
    mode === 'github' && !picked && !!publicPick && publicPick.fullName.toLowerCase() === pick.toLowerCase()
  const pickOwner = pick.split('/')[0] ?? ''
  // Installation covering the pick: the picked row's own, else match the owner
  // to an installation account — mirrors the CP's liveByOrgAndAccount lookup.
  const pickInstallationId = publicSelected
    ? null
    : (picked?.installationId ??
      (gh?.installations ?? []).find((i) => i.accountLogin.toLowerCase() === pickOwner.toLowerCase())?.id ??
      null)
  // Installations to bind against. None ⇒ every pick is an anonymous checkout, so
  // the covered-owner notice would be noise and the public confirmation optional.
  const appAvailable = gh?.enabled === true && gh.installations.length > 0
  const uncovered = !!pick && appAvailable && !publicSelected && pickInstallationId === null
  // An anonymous clone carries no credential, so a public pick cannot push.
  const effectiveWrite = write && !publicSelected

  // Preflight the caller's OWN GitHub access to the picked repo (identity-
  // assertion deployments): read access needs ≥read, push access ≥write.
  useEffect(() => {
    setProbe(null)
    if (repositoryEditor !== null || mode !== 'github' || !pick || !pickInstallationId) return
    const [owner, repo] = pick.split('/')
    if (!owner || !repo) return
    let alive = true
    fetchGithubRepoAccess(pickInstallationId, owner, repo)
      .then((a) => alive && setProbe(a))
      .catch(() => alive && setProbe(null)) // unknown — don't block; the server enforces on save
    return () => {
      alive = false
    }
  }, [mode, pick, pickInstallationId, repositoryEditor])

  useEffect(() => {
    setBranches(null)
    setBranchOpen(false)
    if (repositoryEditor !== null || mode !== 'github' || !pick) return
    const [owner, repo] = pick.split('/')
    if (!owner || !repo) return
    let alive = true
    if (publicSelected) {
      // Anonymous listing is a convenience only; a failure degrades to free text.
      const ctrl = new AbortController()
      void fetchPublicGithubBranches(pick, ctrl.signal)
        .then((names) => alive && names?.length && setBranches(names))
        .catch(() => undefined)
      return () => {
        alive = false
        ctrl.abort()
      }
    }
    if (!pickInstallationId) return
    fetchGithubBranches(pickInstallationId, owner, repo)
      .then((names) => alive && setBranches(names))
      .catch(() => alive && setBranches(null))
    return () => {
      alive = false
    }
  }, [mode, pick, pickInstallationId, publicSelected, repositoryEditor])

  const probeDenies = !!probe?.gated && (effectiveWrite ? !probe.canWrite : !probe.canRead)
  const probeNote = probeDenies
    ? probe?.identityRequired || probe?.denied === 'GITHUB_IDENTITY_REQUIRED'
      ? 'Link your GitHub profile to verify repository access, then retry.'
      : effectiveWrite && probe?.canRead
        ? 'You need write access to this repository on GitHub to enable push access.'
        : 'You don’t have access to this repository on GitHub.'
    : null

  // Which repositories the picker may offer, and on what credentials (shared
  // with agent creation): the synced roster, one exact owner/repo past it, and
  // public GitHub for anything no installation grants.
  const lookup = useGithubRepoPicker({
    enabled: repositoryEditor === null && mode === 'github' && pickOpen,
    query: q,
    installations: gh?.installations ?? NO_INSTALLATIONS,
    repos
  })

  let normalizedAgentDir: string | undefined
  let agentDirError: string | null = null
  try {
    normalizedAgentDir = normalizeAgentDir(agentDir)
  } catch (error) {
    agentDirError = error instanceof Error ? error.message : String(error)
  }

  const noProjects = mode === 'gitlab' && gl.empty
  const glPicked = gl.choices.find((choice) => choice.projectId === glPick)
  const glMatches = matchGitlabProjects(gl.choices, glQ)
  // Falls back to the stored path so the current project reads correctly before the list lands.
  const glPickLabel =
    glPicked?.projectPath ?? (glPick && glPick === gitlabWorkspace?.projectId ? gitlabWorkspace.repo : '')
  const accessChanged = gitWorkspace !== null && effectiveWrite !== currentWrite
  const installationChanged =
    githubWorkspace !== null && pickInstallationId !== null && githubWorkspace.installationId !== pickInstallationId
  const repoChanged =
    mode === 'github'
      ? githubWorkspace === null || pick.toLowerCase() !== githubWorkspace.repo.toLowerCase()
      : mode === 'gitlab' && (gitlabWorkspace === null || glPick !== gitlabWorkspace.projectId)
  const branchChanged = mode === agent.workspace.mode && gitWorkspace !== null && branch.trim() !== gitWorkspace.branch
  const agentDirChanged =
    mode === agent.workspace.mode && gitWorkspace !== null && (normalizedAgentDir ?? '') !== currentAgentDir
  const worktreeChanged = mode === agent.workspace.mode && gitWorkspace !== null && worktree !== !!gitWorkspace.worktree
  const destructiveChange = mode !== agent.workspace.mode || repoChanged || branchChanged
  const changed =
    mode !== agent.workspace.mode ||
    (mode === 'github' &&
      (githubWorkspace === null ||
        repoChanged ||
        branchChanged ||
        agentDirChanged ||
        worktreeChanged ||
        accessChanged ||
        installationChanged)) ||
    (mode === 'gitlab' &&
      (gitlabWorkspace === null || repoChanged || branchChanged || agentDirChanged || worktreeChanged || accessChanged))
  const canSubmit =
    changed &&
    (mode === 'scratch' ||
      (mode === 'gitlab'
        ? !!glPick && agentDirError === null
        : !!pick &&
          !uncovered &&
          !probeDenies &&
          agentDirError === null &&
          (!!pickInstallationId || publicSelected || !appAvailable)))

  const applyPick = (fullName: string, defaultBranch: string | undefined, asPublic: GithubRepoDto | null) => {
    setPick(fullName)
    setPublicPick(asPublic)
    setPickOpen(false)
    setAccessOpen(false)
    setBranchOpen(false)
    setBranch(defaultBranch ?? '')
    setAgentDir('')
    const grant = grantOf(fullName)
    setWrite(asPublic ? false : grant ? grant.access === 'write' : true)
    setErr(null)
  }

  // An exact lookup may reach past the roster: keep the row locally so the pick
  // retains its installation once the popover closes.
  const selectInstalledRepo = (repo: InstalledRepo) => {
    setRepos((rows) =>
      (rows ?? []).some(
        (row) =>
          row.installationId === repo.installationId && row.fullName.toLowerCase() === repo.fullName.toLowerCase()
      )
        ? rows
        : [...(rows ?? []), repo]
    )
    applyPick(repo.fullName, repo.defaultBranch, null)
  }

  const selectPublicRepo = (repo: GithubRepoDto) => applyPick(repo.fullName, repo.defaultBranch, repo)

  // Picking an unadded project provisions it first; a failed setup picks nothing.
  const selectProject = async (choice: GitlabProjectChoice) => {
    if (!choice.binding && !(await gl.provision(choice.projectId))) return
    setGlPick(choice.projectId)
    setGlPickOpen(false)
    setAccessOpen(false)
    setBranch(choice.defaultBranch ?? '')
    setAgentDir('')
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
          : mode === 'gitlab'
            ? {
                mode: 'gitlab',
                worktree,
                projectId: glPick,
                ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
                gitAccess: write ? 'write' : 'read'
              }
            : {
                mode: 'github',
                worktree,
                repoFullName: pick,
                ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
                gitAccess: effectiveWrite ? 'write' : 'read'
              }
      )
      onChanged()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'GITHUB_IDENTITY_REQUIRED') {
        setErr('Link your GitHub profile to verify repository access, then retry.')
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

  const removeAuthorization = async (row: AgentRepoAuthDto) => {
    if (removingAuthorization) return
    setRemovingAuthorization(row.id)
    setRepositoryError(null)
    try {
      await deleteAgentRepo(agent.id, row.id)
      const next = authorizations.filter((authorization) => authorization.id !== row.id)
      setAuthorizations(next)
      onAuthorizedChange?.(next)
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemovingAuthorization(null)
    }
  }

  if (repositoryEditor) {
    const closeRepositoryEditor = repositoryEditor.returnToWorkspace ? () => setRepositoryEditor(null) : onClose
    return (
      <AddAgentRepoModal
        agent={agent}
        workspaceRepo={githubWorkspace?.installationId ? githubWorkspace.repo : null}
        authorized={authorizations}
        {...(githubWorkspace && !githubWorkspace.installationId ? { fixedRepo: githubWorkspace.repo } : {})}
        {...(repositoryEditor.repo ? { initialRepo: repositoryEditor.repo } : {})}
        {...(repositoryEditor.access ? { initialAccess: repositoryEditor.access } : {})}
        workspaceContext
        showBack={repositoryEditor.returnToWorkspace}
        onClose={closeRepositoryEditor}
        onExit={onClose}
        onCreated={(row) => {
          const next = [...authorizations, row]
          setAuthorizations(next)
          onAuthorizedChange?.(next)
          onRepositoryCreated?.(row)
          if (repositoryEditor.returnToWorkspace) setRepositoryEditor(null)
          else onClose()
        }}
      />
    )
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
              setGlPickOpen(false)
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

          {mode === 'gitlab' && (
            <div className="mb-4 grid grid-cols-1 gap-[14px] desktop:grid-cols-2 desktop:gap-x-7">
              {gl.error ? (
                <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error) desktop:col-span-2">
                  Couldn&rsquo;t load your GitLab projects — {gl.error}
                </div>
              ) : gl.loading ? (
                <div className="desktop:col-span-2">
                  <LoadingState size={20} padding={16} />
                </div>
              ) : noProjects ? (
                <GitlabNoProjectsNotice
                  connected={gl.connected}
                  enabled={gl.enabled}
                  onConnect={() => void gl.connect()}
                  onSync={gl.reload}
                  syncing={gl.reloading}
                />
              ) : (
                <>
                  <GitlabProjectField
                    value={glPickLabel}
                    icon="book-marked"
                    loading={false}
                    open={glPickOpen}
                    query={glQ}
                    onToggle={() => {
                      setGlQ('')
                      setAccessOpen(false)
                      setGlPickOpen((value) => !value)
                    }}
                    onClose={() => setGlPickOpen(false)}
                    onQueryChange={setGlQ}
                    error={gl.provisionError ? `Couldn’t set up that project — ${gl.provisionError}` : undefined}
                  >
                    {glMatches.map((choice) => (
                      <GitlabProjectOption
                        key={choice.projectId}
                        choice={choice}
                        selected={glPick === choice.projectId}
                        busy={gl.provisioning === choice.projectId}
                        onSelect={() => void selectProject(choice)}
                      />
                    ))}
                    {glMatches.length === 0 && <div className="fnohit">No projects match &ldquo;{glQ}&rdquo;</div>}
                  </GitlabProjectField>

                  <RepositoryAccessField
                    repositorySelected={!!glPick}
                    label="Project access"
                    unselectedLabel="Select project first"
                    writeDescription="Push, open merge requests & run pipelines"
                    value={write ? 'write' : 'read'}
                    open={accessOpen}
                    onToggle={() => {
                      setGlPickOpen(false)
                      setAccessOpen((value) => !value)
                    }}
                    onClose={() => setAccessOpen(false)}
                    onChange={(value) => {
                      setWrite(value === 'write')
                      setAccessOpen(false)
                      setErr(null)
                    }}
                  />

                  <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px] desktop:gap-x-[14px]">
                    <WorkspaceBranchField
                      repositorySelected={!!glPick}
                      unselectedLabel="Pick project first"
                      defaultBranchLabel="GitLab default branch"
                      value={branch}
                      branches={null}
                      open={false}
                      query=""
                      onToggle={() => {}}
                      onClose={() => {}}
                      onQueryChange={() => {}}
                      onChange={(value) => {
                        setBranch(value)
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
                    <WorktreeField checked={worktree} onChange={setWorktree} />
                  </div>
                </>
              )}
            </div>
          )}
          {mode === 'github' &&
            (gh === null ? (
              <div className="mb-4 flex items-center gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                <Icon name="loader" size={15} className="flex-none animate-spin" />
                Checking your GitHub setup…
              </div>
            ) : (
              // The fields render whatever the App state is: a public repository needs
              // no installation, so an anonymous workspace stays editable on a
              // deployment with no App and on an organization with none installed.
              <div className="mb-4 grid grid-cols-1 gap-[14px] desktop:grid-cols-2 desktop:gap-x-7">
                {!gh.enabled ? (
                  <div className="flex items-start gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
                    <Icon name="info" size={15} className="mt-[1px] flex-none" />
                    <span>
                      The GitHub App isn&rsquo;t configured for this deployment — only public repositories are
                      available, cloned read-only.
                    </span>
                  </div>
                ) : gh.installations.length === 0 ? (
                  <div className="desktop:col-span-2">
                    <GithubInstallPrompt
                      onInstall={() => void openGhInstall()}
                      onSync={() => void syncGh()}
                      syncing={ghSyncing}
                    />
                  </div>
                ) : (
                  <GithubConnectedBanner onManage={() => void openGhInstall()} />
                )}
                <GithubRepositoryField
                  value={pick}
                  icon={publicSelected || (picked && !picked.private) ? 'book-marked' : 'lock'}
                  badge={publicSelected ? 'public' : undefined}
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
                  onSearchKeyDown={(event) => {
                    if (event.key !== 'Enter' || !lookup.exactChoice) return
                    event.preventDefault()
                    if (lookup.exactChoice.kind === 'installed') selectInstalledRepo(lookup.exactChoice.repo)
                    else selectPublicRepo(lookup.exactChoice.repo)
                  }}
                  error={
                    reposError === 'failed'
                      ? 'Couldn’t load repositories from GitHub — the list may be incomplete.'
                      : undefined
                  }
                  onRetry={() => {
                    invalidateGithubRepoRosterCache()
                    setReposError(null)
                    setPrivateReposHidden(false)
                    setRepos(null)
                    setReposNonce((value) => value + 1)
                  }}
                  note={
                    privateReposHidden ? (
                      <GithubPrivateReposNotice profileHref={orgPath('/profile#sign-in-methods')} />
                    ) : undefined
                  }
                >
                  <GithubRepoPickerOptions
                    lookup={lookup}
                    query={q}
                    loading={repos === null}
                    failed={reposError === 'failed'}
                    selected={pick}
                    describeRosterRow={(repo) => {
                      const grant = grantOf(repo.fullName)
                      return {
                        description: grant
                          ? 'Already authorized for this agent'
                          : (repo.description ?? 'No description'),
                        ...(grant ? { badge: 'authorized' } : {})
                      }
                    }}
                    onPickInstalled={selectInstalledRepo}
                    onPickPublic={selectPublicRepo}
                  />
                </GithubRepositoryField>

                <RepositoryAccessField
                  repositorySelected={!!pick}
                  value={effectiveWrite ? 'write' : 'read'}
                  open={accessOpen}
                  readOnly={publicSelected}
                  readOnlyNote={
                    publicSelected ? (
                      <span className="mt-[6px] inline-flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                        <Icon name="info" size={13} className="mt-[1px] flex-none" />
                        Public repository — read-only clone.
                      </span>
                    ) : undefined
                  }
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

                <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px] desktop:gap-x-[14px]">
                  <WorkspaceBranchField
                    repositorySelected={!!pick}
                    value={branch}
                    branches={branches}
                    defaultBranch={publicSelected ? publicPick?.defaultBranch : picked?.defaultBranch}
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
                  <WorktreeField checked={worktree} onChange={setWorktree} />
                </div>

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

          <div className="mt-1 border-t border-(--border-subtle) pt-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
                  Additional repositories
                </div>
                <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  {githubWorkspace && !githubWorkspace.installationId
                    ? 'This manual checkout can authorize only its workspace repository. Changes here apply immediately.'
                    : poolPlaced
                      ? 'Authorize repositories this agent can use in addition to its workspace. Changes here apply immediately.'
                      : 'Authorize repositories this agent can use in addition to its workspace. Each one is checked out alongside the workspace and available in the agent’s sessions; a review of its pull requests runs on an exact checkout of it. Changes here apply immediately.'}
                </div>
              </div>
              {!manualWorkspaceAuthorization && (
                <Button
                  size="sm"
                  onClick={() => {
                    setRepositoryError(null)
                    setRepositoryEditor({ returnToWorkspace: true })
                  }}
                >
                  <Icon name="plus" size={13} />
                  Authorize repository
                </Button>
              )}
            </div>

            {mode === 'scratch' && gh?.enabled && gh.installations.length > 0 && (
              <div className="mt-3">
                <GithubConnectedBanner onManage={() => void openGhInstall()} />
              </div>
            )}

            <div className="mt-3 flex flex-col gap-2">
              {authorizations.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[10px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  <Icon name="info" size={14} className="flex-none" />
                  No additional repositories authorized.
                </div>
              ) : (
                authorizations.map((authorization) => (
                  <div
                    key={authorization.id}
                    className="flex min-w-0 items-center gap-[10px] rounded-md border border-(--border-subtle) bg-(--surface-card) px-3 py-[9px]"
                  >
                    <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                      {repoAuthProvider(authorization) === 'gitlab' ? <GitlabMark /> : <GithubMark />}
                    </span>
                    <span
                      className="mono min-w-0 flex-1 truncate text-[12.5px] font-semibold text-(--text-primary)"
                      title={authorization.repoFullName}
                    >
                      {authorization.repoFullName}
                    </span>
                    <span className={REPOSITORY_ACCESS_BADGE[authorization.access]}>{authorization.access}</span>
                    <button
                      type="button"
                      className={`iconbtn h-6 w-6 flex-none ${
                        removingAuthorization === authorization.id ? 'pointer-events-none opacity-50' : ''
                      }`}
                      title="Revoke repository access"
                      disabled={removingAuthorization !== null}
                      onClick={() => void removeAuthorization(authorization)}
                    >
                      <Icon name={removingAuthorization === authorization.id ? 'loader' : 'trash-2'} size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
            {repositoryError && (
              <div className="mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                {repositoryError}
              </div>
            )}
          </div>

          {err && (
            <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
          )}
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
            disabled={!canSubmit || saving || noProjects}
            className={!canSubmit || saving || noProjects ? 'pointer-events-none opacity-50' : undefined}
          >
            {saving ? 'Saving…' : destructiveChange ? 'Replace workspace' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
