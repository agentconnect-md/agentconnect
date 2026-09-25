'use client'

// One workspace editor owns mode, repository, branch, working directory, and
// both workspace and additional-repository access. The server drains active
// work, replaces daemon-local files only when mode/repo/branch changes, and
// rejects edits that conflict with enabled GitHub review or Check actions.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { AgentRepositorySelector } from '@agentconnect.md/protocol/decision'
import { GithubMark, LoadingState } from '@/components/marks'
import { CodeHostMark } from '@/components/console/CodeHostMark'
import { Button, Icon } from '@/components/ui'
import { codeHostRecord } from '@/lib/code-hosts'
import { agentLabel, isPoolPlacementKind, workspaceSourceOf, type Agent } from '@/lib/data'
import { sessionIsolationLabel } from '@/lib/session-isolation'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { matchGiteaRepositories, type GiteaRepositoryChoice } from '@/lib/gitea-repositories'
import { matchGitlabProjects, type GitlabProjectChoice } from '@/lib/gitlab-projects'
import { gitRepoUrlTileHint } from '@/lib/git-url-tile'
import { useGiteaRepositories } from '@/lib/use-gitea-repositories'
import { useGitlabProjects } from '@/lib/use-gitlab-projects'
import {
  ApiError,
  setAgentWorkspace,
  fetchGithubBranches,
  fetchGithubInstallations,
  fetchGithubInstallUrl,
  fetchGithubRepoRoster,
  fetchGithubRepoAccess,
  invalidateGithubRepoRosterCache,
  repoAuthMaterialize,
  repoAuthProvider,
  syncGithubInstallations,
  updateAgent,
  type AgentInstallationAuthDto,
  type AgentRepoAuthDto,
  type GithubInstallationDto,
  type GithubRepoAccess,
  type GithubRepoDto,
  type InstallationMaterialize,
  type RepoAccess
} from '@/lib/api'
import { useRepositoryDecision } from '@/lib/repository-selector'
import { useRepositoryGrantEdits } from '@/lib/use-repository-grant-edits'
import { RepositorySelectorField } from '@/components/console/RepositorySelectorField'
import { fetchPublicGithubBranches } from '@/lib/github-public-repos'
import { useGithubRepoPicker, type InstalledRepo } from '@/lib/use-github-repo-picker'
import { GithubRepoPickerOptions } from '@/components/console/GithubRepoPickerOptions'
import { agentDirInputValue, normalizeAgentDir } from '@/lib/repo-subdir'
import {
  GiteaNoRepositoriesNotice,
  GiteaRepositoryField,
  GiteaRepositoryOption,
  GithubConnectedBanner,
  GithubInstallPrompt,
  GithubPrivateReposNotice,
  GithubRepositoryField,
  GitlabNoProjectsNotice,
  GitlabProjectField,
  GitlabProjectOption,
  GitUrlTileFields,
  INSTALLATION_MATERIALIZE_OPTIONS,
  PublicGitlabProjectOption,
  RepositoryAccessField,
  RepositoryAccessToggle,
  RepositoryMaterializeSelect,
  WorktreeField,
  WorkingSubdirectoryField,
  WorkspaceBranchField,
  WorkspaceModeField,
  type WorkspaceMode
} from '@/components/console/WorkspaceFormFields'
import AddAgentRepoModal from '@/components/console/modals/AddAgentRepoModal'

/** Stable empty roster: a fresh literal would re-run the picker's lookups. */
const NO_INSTALLATIONS: GithubInstallationDto[] = []
const NO_INSTALLATION_GRANTS: AgentInstallationAuthDto[] = []
// The busy marker while the repository selector saves; no row id takes this form.
const SELECTOR_BUSY = 'repository-selector'

export interface InitialRepositoryAuthorization {
  repo?: string
  access?: RepoAccess
}

export default function EditWorkspaceModal({
  agent,
  authorized,
  installationGrants = NO_INSTALLATION_GRANTS,
  initialMode,
  initialRepositoryAuthorization,
  onAuthorizedChange,
  onInstallationGrantsChange,
  onRepositoryCreated,
  onAgentChange,
  onClose,
  onChanged
}: {
  agent: Agent
  /** Existing grants — managed here and badged in the workspace picker. */
  authorized: AgentRepoAuthDto[]
  /** Installation grants — listed beside the repository rows, written by an organization owner only. */
  installationGrants?: AgentInstallationAuthDto[]
  /** Preselected mode — the workspace card's Source segment opens the editor
   *  already switched to the mode the user picked. Defaults to the current one. */
  initialMode?: WorkspaceMode
  /** Open directly at the additional-repository step for contextual shortcuts. */
  initialRepositoryAuthorization?: InitialRepositoryAuthorization
  /** Keep the caller's shared repository cache synchronized after add/revoke. */
  onAuthorizedChange?: (rows: AgentRepoAuthDto[]) => void
  /** Keep the caller's shared installation-grant cache synchronized after authorize/revoke. */
  onInstallationGrantsChange?: (rows: AgentInstallationAuthDto[]) => void
  /** Resume a contextual flow, such as GitHub integration setup, after adding. */
  onRepositoryCreated?: (row: AgentRepoAuthDto) => void
  /** The agent after an edit saved here directly, such as its repository selector. */
  onAgentChange?: (agent: Agent) => void
  onClose: () => void
  onChanged: () => void
}) {
  const t = useTranslations('Agents.workspaceEdit')
  const { orgPath, myRole } = useOrgs()
  // Installation grants are organization-owner writes (decision 10); other editors see them read-only.
  const isOwner = myRole === 'owner'
  const { orgSetIds } = useConsoleData()
  // Pool placements do not materialize secondary roots yet, so they keep the authorization-only wording.
  const poolPlaced = isPoolPlacementKind(agent.placementKind, agent.setId, orgSetIds)
  // Session isolation is named by its EFFECTIVE boundary (git-workspace-model.md §11), and a pool pod is one whether or not a sandbox is.
  const isolationLabel = sessionIsolationLabel({
    pool: poolPlaced,
    runInSandbox: agent.runInSandbox,
    sandboxSupported: agent.sandboxSupported,
    sandboxRequired: agent.sandboxRequired
  })
  // The tile an existing workspace edits under is DERIVED from host + credential
  // (git-workspace-model.md §7) — no source is stored.
  const currentSource = workspaceSourceOf(agent.workspace)
  const gitWorkspace = agent.workspace.mode === 'git' ? agent.workspace : null
  // The workspace each host's own editor sees — the checkout when this is its tile, else nothing.
  const codeHostWorkspace = codeHostRecord((provider) => (currentSource === provider ? gitWorkspace : null))
  const githubWorkspace = codeHostWorkspace.github
  const gitlabWorkspace = codeHostWorkspace.gitlab
  const giteaWorkspace = codeHostWorkspace.gitea
  const giturlWorkspace = currentSource === 'giturl' ? gitWorkspace : null
  const isGithubApp = githubWorkspace?.provider === 'github'
  // An anonymous checkout mints nothing, so only a credentialed workspace can hold write.
  const currentWrite = gitWorkspace ? gitWorkspace.provider !== undefined && gitWorkspace.gitAccess !== 'read' : null
  const currentAgentDir = agentDirInputValue(gitWorkspace?.agentDir)
  const [mode, setMode] = useState<WorkspaceMode>(initialMode ?? currentSource)
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
    githubWorkspace && githubWorkspace.provider === undefined
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
  const [glPick, setGlPick] = useState(gitlabWorkspace?.provider === 'gitlab' ? (gitlabWorkspace.repoId ?? '') : '')
  // A public GitLab project path (anonymous clone) — the gitlab tile's second arm.
  const [glPublic, setGlPublic] = useState<string | null>(
    gitlabWorkspace && gitlabWorkspace.provider === undefined ? gitlabWorkspace.repo : null
  )
  // The Git URL tile's address; full https/ssh only — never shorthand.
  const [urlInput, setUrlInput] = useState(giturlWorkspace?.gitRepo ?? '')
  const [glPickOpen, setGlPickOpen] = useState(false)
  const [glQ, setGlQ] = useState('')
  // Gitea arm: a repository is named by its numeric id, and there is no anonymous second arm —
  // a public Gitea repository is the Git URL tile's business (gitea-integration.md §9).
  const [gtPick, setGtPick] = useState(giteaWorkspace?.provider === 'gitea' ? (giteaWorkspace.repoId ?? '') : '')
  const [gtPickOpen, setGtPickOpen] = useState(false)
  const [gtQ, setGtQ] = useState('')
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
  const [grants, setGrants] = useState(installationGrants)
  const [selector, setSelector] = useState<AgentRepositorySelector | null>(agent.repositorySelector ?? null)
  const [selectorRevealed, setSelectorRevealed] = useState(false)
  const selectorRef = useRef<HTMLDivElement>(null)
  const { providers: selectorProviders, block: decisionBlock } = useRepositoryDecision(agent, selector)
  const edits = useRepositoryGrantEdits({
    agentId: agent.id,
    repositories: authorizations,
    grants,
    onRepositoriesChange: (next) => {
      setAuthorizations(next)
      onAuthorizedChange?.(next)
    },
    onGrantsChange: (next) => {
      setGrants(next)
      onInstallationGrantsChange?.(next)
    }
  })
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

  useEffect(() => {
    setGrants(installationGrants)
  }, [installationGrants])

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

  // The repositories this organization added, plus the ones the bot administers — saving one of
  // those as the workspace binds it (gitea-integration.md §6).
  const gt = useGiteaRepositories(repositoryEditor === null && mode === 'gitea')

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
    githubWorkspace && githubWorkspace.provider === undefined ? grantOf(githubWorkspace.repo) : undefined

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
  const noRepositories = mode === 'gitea' && gt.empty
  const gtPicked = gt.choices.find((choice) => choice.repoId === gtPick)
  const gtMatches = matchGiteaRepositories(gt.choices, gtQ)
  // Falls back to the stored path so the current repository reads correctly before the list lands.
  const gtPickLabel = gtPicked?.repoPath ?? (gtPick && gtPick === giteaWorkspace?.repoId ? giteaWorkspace.repo : '')
  const glPicked = gl.choices.find((choice) => choice.projectId === glPick)
  const glMatches = matchGitlabProjects(gl.choices, glQ)
  // Falls back to the stored path so the current project reads correctly before the list lands.
  const glPickLabel =
    glPublic ?? glPicked?.projectPath ?? (glPick && glPick === gitlabWorkspace?.repoId ? gitlabWorkspace.repo : '')
  // The Git URL tile refuses the managed hosts with a switch-tile hint, so
  // tile ↔ stored-shape stays injective by construction (§7).
  const urlTileHint = mode === 'giturl' ? gitRepoUrlTileHint(urlInput) : null
  const accessChanged = gitWorkspace !== null && effectiveWrite !== currentWrite
  const repoChanged =
    mode === 'github'
      ? githubWorkspace === null || pick.toLowerCase() !== githubWorkspace.repo.toLowerCase()
      : mode === 'gitlab'
        ? gitlabWorkspace === null ||
          (glPublic !== null
            ? glPublic !== (gitlabWorkspace.provider === undefined ? gitlabWorkspace.repo : null)
            : glPick !== gitlabWorkspace.repoId)
        : mode === 'gitea'
          ? giteaWorkspace === null || gtPick !== giteaWorkspace.repoId
          : mode === 'giturl' && (giturlWorkspace === null || urlInput.trim() !== giturlWorkspace.gitRepo)
  const branchChanged = mode === currentSource && gitWorkspace !== null && branch.trim() !== gitWorkspace.branch
  const agentDirChanged =
    mode === currentSource && gitWorkspace !== null && (normalizedAgentDir ?? '') !== currentAgentDir
  const worktreeChanged = mode === currentSource && gitWorkspace !== null && worktree !== !!gitWorkspace.worktree
  // Binding a manual checkout to the App is a real edit even when nothing else
  // moves: the stored credential flips from anonymous to github-vouched.
  const bindsApp =
    mode === 'github' &&
    githubWorkspace !== null &&
    githubWorkspace.provider === undefined &&
    !publicSelected &&
    pickInstallationId !== null
  const destructiveChange = mode !== currentSource || repoChanged || branchChanged
  const changed =
    mode !== currentSource ||
    (mode === 'github' &&
      (githubWorkspace === null ||
        repoChanged ||
        branchChanged ||
        agentDirChanged ||
        worktreeChanged ||
        accessChanged ||
        bindsApp)) ||
    (mode === 'gitlab' &&
      (gitlabWorkspace === null ||
        repoChanged ||
        branchChanged ||
        agentDirChanged ||
        worktreeChanged ||
        accessChanged)) ||
    (mode === 'gitea' &&
      (giteaWorkspace === null ||
        repoChanged ||
        branchChanged ||
        agentDirChanged ||
        worktreeChanged ||
        accessChanged)) ||
    (mode === 'giturl' &&
      (giturlWorkspace === null || repoChanged || branchChanged || agentDirChanged || worktreeChanged))
  const canSubmit =
    changed &&
    (mode === 'scratch' ||
      (mode === 'gitlab'
        ? (!!glPick || !!glPublic) && agentDirError === null
        : mode === 'gitea'
          ? !!gtPick && agentDirError === null
          : mode === 'giturl'
            ? !!urlInput.trim() && urlTileHint === null && agentDirError === null
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
    setGlPublic(null)
    setGlPick(choice.projectId)
    setGlPickOpen(false)
    setAccessOpen(false)
    setBranch(choice.defaultBranch ?? '')
    setAgentDir('')
    setErr(null)
  }

  // An unadded repository is bound by the save itself, so the pick is only a pick.
  const selectRepository = (choice: GiteaRepositoryChoice) => {
    setGtPick(choice.repoId)
    setGtPickOpen(false)
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
      // Every tile produces the same payload (git-workspace-model.md §5/§7): one
      // gitRepo address; the server derives who vouches for it.
      await setAgentWorkspace(
        agent.id,
        mode === 'scratch'
          ? { mode: 'scratch' }
          : mode === 'gitlab'
            ? {
                mode: 'git',
                // An unchanged pick submits the STORED address — never a client-side
                // recomposition, which cannot know the deployment's instance URL.
                gitRepo:
                  !repoChanged && gitlabWorkspace !== null
                    ? gitlabWorkspace.gitRepo
                    : `${gl.instanceUrl.replace(/\/+$/, '')}/${glPickLabel}`,
                worktree,
                ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
                access: glPublic === null && write ? 'write' : 'read'
              }
            : mode === 'gitea'
              ? {
                  mode: 'git',
                  // An unchanged pick submits the STORED address — never a client-side
                  // recomposition, which cannot know the deployment's instance URL.
                  gitRepo:
                    !repoChanged && giteaWorkspace !== null
                      ? giteaWorkspace.gitRepo
                      : `${gt.instanceUrl.replace(/\/+$/, '')}/${gtPickLabel}`,
                  worktree,
                  ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                  ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
                  access: write ? 'write' : 'read'
                }
              : mode === 'giturl'
                ? {
                    mode: 'git',
                    gitRepo: urlInput.trim(),
                    worktree,
                    ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                    ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {})
                  }
                : {
                    mode: 'git',
                    gitRepo: pick,
                    worktree,
                    ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                    ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
                    access: effectiveWrite ? 'write' : 'read'
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

  // Saved at once, like a checkout switch; the Control Plane refuses a clear while anything is By decision.
  const changeSelector = (value: AgentRepositorySelector | null) =>
    edits.run(SELECTOR_BUSY, async () => {
      const updated = await updateAgent(agent.id, { repositorySelector: value })
      setSelector(updated.repositorySelector ?? null)
      onAgentChange?.(updated)
    })

  const revealSelector = () => {
    setSelectorRevealed(true)
    requestAnimationFrame(() => selectorRef.current?.querySelector('button')?.focus())
  }

  if (repositoryEditor) {
    const closeRepositoryEditor = repositoryEditor.returnToWorkspace ? () => setRepositoryEditor(null) : onClose
    return (
      <AddAgentRepoModal
        agent={agent}
        workspaceRepo={isGithubApp && githubWorkspace ? githubWorkspace.repo : null}
        authorized={authorizations}
        installationGrants={grants}
        canAuthorizeInstallation={isOwner}
        onInstallationCreated={(grant) => {
          const next = [...grants, grant]
          setGrants(next)
          onInstallationGrantsChange?.(next)
          if (repositoryEditor.returnToWorkspace) setRepositoryEditor(null)
          else onClose()
        }}
        repositorySelector={selector}
        {...(githubWorkspace && githubWorkspace.provider === undefined ? { fixedRepo: githubWorkspace.repo } : {})}
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

  const usesDecision =
    authorizations.some((row) => repoAuthMaterialize(row) === 'decision') ||
    grants.some((grant) => grant.materialize === 'decision')
  const showSelector = selectorRevealed || selector !== null || usesDecision
  const rowBusy = edits.busy

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
            <div className="font-sans text-[16px] font-semibold leading-normal">{t('title')}</div>
            <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {t('subtitle', { agent: agentLabel(agent) })}
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
              setGtPickOpen(false)
              setErr(null)
            }}
          />

          {destructiveChange && (
            <div className="mb-4 flex items-start gap-[10px] rounded-[9px] border border-(--status-error) bg-(--surface-sunken) p-[13px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
              <Icon name="shield-alert" size={14} className="mt-[2px] flex-none" />
              <span>{t('destructiveWarning')}</span>
            </div>
          )}

          {mode === 'gitlab' && (
            <div className="mb-4 grid grid-cols-1 gap-[14px] desktop:grid-cols-2 desktop:gap-x-7">
              {gl.error ? (
                <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error) desktop:col-span-2">
                  {t('gitlabLoadError', { error: gl.error })}
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
                    icon="book-bookmark"
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
                    {/* A public project outside the managed set rides the anonymous arm (§7). */}
                    <PublicGitlabProjectOption
                      query={glQ}
                      choices={gl.choices}
                      onSelect={(path) => {
                        setGlPublic(path)
                        setGlPick('')
                        setGlPickOpen(false)
                        setAccessOpen(false)
                        setWrite(false)
                        setBranch('')
                        setAgentDir('')
                        setErr(null)
                      }}
                    />
                    {glMatches.length === 0 && !glQ.trim().includes('/') && (
                      <div className="fnohit">{t('noProjectsMatch', { query: glQ })}</div>
                    )}
                  </GitlabProjectField>

                  <RepositoryAccessField
                    repositorySelected={!!glPick || !!glPublic}
                    label={t('projectAccess')}
                    unselectedLabel={t('selectProjectFirst')}
                    writeDescription={t('gitlabWriteAccess')}
                    value={glPublic !== null ? 'read' : write ? 'write' : 'read'}
                    readOnly={glPublic !== null}
                    readOnlyNote={
                      glPublic !== null ? (
                        <span className="mt-[6px] inline-flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                          <Icon name="info" size={13} className="mt-[1px] flex-none" />
                          {t('publicProjectReadOnly')}
                        </span>
                      ) : undefined
                    }
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
                      repositorySelected={!!glPick || !!glPublic}
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
                    <WorktreeField label={isolationLabel.mode} checked={worktree} onChange={setWorktree} />
                  </div>
                </>
              )}
            </div>
          )}
          {mode === 'gitea' && (
            <div className="mb-4 grid grid-cols-1 gap-[14px] desktop:grid-cols-2 desktop:gap-x-7">
              {gt.error ? (
                <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error) desktop:col-span-2">
                  {t('giteaLoadError', { error: gt.error })}
                </div>
              ) : gt.loading ? (
                <div className="desktop:col-span-2">
                  <LoadingState size={20} padding={16} />
                </div>
              ) : noRepositories ? (
                <GiteaNoRepositoriesNotice
                  connected={gt.connected}
                  enabled={gt.enabled}
                  integrationsHref={orgPath('/integrations')}
                  onSync={gt.reload}
                  syncing={gt.reloading}
                />
              ) : (
                <>
                  <GiteaRepositoryField
                    value={gtPickLabel}
                    icon="book-bookmark"
                    loading={false}
                    open={gtPickOpen}
                    query={gtQ}
                    onToggle={() => {
                      setGtQ('')
                      setAccessOpen(false)
                      setGtPickOpen((value) => !value)
                    }}
                    onClose={() => setGtPickOpen(false)}
                    onQueryChange={setGtQ}
                  >
                    {gtMatches.map((choice) => (
                      <GiteaRepositoryOption
                        key={choice.repoId}
                        choice={choice}
                        selected={gtPick === choice.repoId}
                        onSelect={() => selectRepository(choice)}
                      />
                    ))}
                    {gtMatches.length === 0 && <div className="fnohit">{t('noRepositoriesMatch', { query: gtQ })}</div>}
                  </GiteaRepositoryField>

                  <RepositoryAccessField
                    repositorySelected={!!gtPick}
                    writeDescription={t('giteaWriteAccess')}
                    value={write ? 'write' : 'read'}
                    open={accessOpen}
                    onToggle={() => {
                      setGtPickOpen(false)
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
                      repositorySelected={!!gtPick}
                      defaultBranchLabel="Gitea default branch"
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
                    <WorktreeField label={isolationLabel.mode} checked={worktree} onChange={setWorktree} />
                  </div>
                </>
              )}
            </div>
          )}
          {mode === 'github' &&
            (gh === null ? (
              <div className="mb-4 flex items-center gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                <Icon name="loader" size={15} className="flex-none animate-spin" />
                {t('checkingGithub')}
              </div>
            ) : (
              // The fields render whatever the App state is: a public repository needs
              // no installation, so an anonymous workspace stays editable on a
              // deployment with no App and on an organization with none installed.
              <div className="mb-4 grid grid-cols-1 gap-[14px] desktop:grid-cols-2 desktop:gap-x-7">
                {!gh.enabled ? (
                  <div className="flex items-start gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
                    <Icon name="info" size={15} className="mt-[1px] flex-none" />
                    <span>{t('githubNotConfigured')}</span>
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
                  icon={publicSelected || (picked && !picked.private) ? 'book-bookmark' : 'lock'}
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
                  error={reposError === 'failed' ? t('githubLoadError') : undefined}
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
                        description: grant ? t('alreadyAuthorized') : (repo.description ?? t('noDescription')),
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
                        {t('publicRepositoryReadOnly')}
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
                  <WorktreeField label={isolationLabel.mode} checked={worktree} onChange={setWorktree} />
                </div>

                {uncovered && (
                  <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
                    <Icon name="info" size={14} className="mt-[1px] flex-none" />
                    <span>{t('installationMissing', { owner: pickOwner })}</span>
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

          {mode === 'giturl' && (
            <GitUrlTileFields
              worktreeLabel={isolationLabel.mode}
              url={urlInput}
              urlHint={urlTileHint}
              branch={branch}
              agentDir={agentDir}
              agentDirError={agentDirError}
              worktree={worktree}
              onUrlChange={(value) => {
                setUrlInput(value)
                setErr(null)
              }}
              onBranchChange={(value) => {
                setBranch(value)
                setErr(null)
              }}
              onAgentDirChange={(value) => {
                setAgentDir(value)
                setErr(null)
              }}
              onWorktreeChange={setWorktree}
            />
          )}

          <div className="mt-1 border-t border-(--border-subtle) pt-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
                  {t('additionalRepositories')}
                </div>
              </div>
              {!manualWorkspaceAuthorization && (
                <Button
                  size="sm"
                  onClick={() => {
                    edits.setError(null)
                    setRepositoryEditor({ returnToWorkspace: true })
                  }}
                >
                  <Icon name="plus" size={13} />
                  {t('authorizeRepository')}
                </Button>
              )}
            </div>

            {mode === 'scratch' && gh?.enabled && gh.installations.length > 0 && (
              <div className="mt-3">
                <GithubConnectedBanner onManage={() => void openGhInstall()} />
              </div>
            )}

            <div className="mt-3 flex flex-col gap-2">
              {grants.map((grant) => (
                <div
                  key={grant.id}
                  data-installation-grant={grant.installationId}
                  className="flex min-w-0 items-center gap-[10px] rounded-md border border-(--border-subtle) bg-(--surface-card) px-3 py-[9px] max-desktop:flex-wrap"
                >
                  <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                    <GithubMark />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary) max-desktop:min-w-[45%]">
                    {t.rich('allRepositoriesIn', {
                      account: grant.accountLogin,
                      mono: (chunks) => <span className="mono">{chunks}</span>
                    })}
                  </span>
                  <span className="flex flex-none" title={isOwner ? undefined : t('installationOwnerOnly')}>
                    <RepositoryAccessToggle
                      value={grant.access}
                      name={grant.accountLogin}
                      disabled={!isOwner || rowBusy}
                      onChange={(access) => void edits.updateGrant(grant, { access })}
                    />
                  </span>
                  <span title={isOwner ? undefined : t('installationOwnerOnly')}>
                    <RepositoryMaterializeSelect
                      name={grant.accountLogin}
                      options={INSTALLATION_MATERIALIZE_OPTIONS}
                      value={grant.materialize}
                      disabled={!isOwner || rowBusy}
                      decisionBlock={decisionBlock}
                      onDecisionBlocked={revealSelector}
                      onChange={(value) =>
                        void edits.updateGrant(grant, { materialize: value as InstallationMaterialize })
                      }
                    />
                  </span>
                  <span title={isOwner ? t('revokeInstallationAccess') : t('installationOwnerOnly')}>
                    <button
                      type="button"
                      aria-label={t('revokeInstallationAccess')}
                      className={`iconbtn h-6 w-6 flex-none ${
                        !isOwner || edits.removing === grant.id ? 'pointer-events-none opacity-50' : ''
                      }`}
                      disabled={!isOwner || rowBusy}
                      onClick={() => void edits.removeGrant(grant)}
                    >
                      <Icon name={edits.removing === grant.id ? 'loader' : 'trash'} size={13} />
                    </button>
                  </span>
                </div>
              ))}
              {authorizations.length === 0 && grants.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[10px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  <Icon name="info" size={14} className="flex-none" />
                  {t('noAdditionalRepositories')}
                </div>
              ) : (
                authorizations.map((authorization) => (
                  <div
                    key={authorization.id}
                    className="flex min-w-0 items-center gap-[10px] rounded-md border border-(--border-subtle) bg-(--surface-card) px-3 py-[9px] max-desktop:flex-wrap"
                  >
                    <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                      <CodeHostMark provider={repoAuthProvider(authorization)} />
                    </span>
                    <span
                      className="mono min-w-0 flex-1 truncate text-[12.5px] font-semibold text-(--text-primary) max-desktop:min-w-[45%]"
                      title={authorization.repoFullName}
                    >
                      {authorization.repoFullName}
                    </span>
                    <RepositoryAccessToggle
                      value={authorization.access}
                      name={authorization.repoFullName}
                      disabled={rowBusy}
                      onChange={(access) => void edits.updateRepository(authorization, { access })}
                    />
                    <RepositoryMaterializeSelect
                      name={authorization.repoFullName}
                      value={repoAuthMaterialize(authorization)}
                      disabled={rowBusy}
                      decisionBlock={decisionBlock}
                      onDecisionBlocked={revealSelector}
                      onChange={(materialize) => void edits.updateRepository(authorization, { materialize })}
                    />
                    <button
                      type="button"
                      className={`iconbtn h-6 w-6 flex-none ${
                        edits.removing === authorization.id ? 'pointer-events-none opacity-50' : ''
                      }`}
                      title={t('revokeRepositoryAccess')}
                      disabled={rowBusy}
                      onClick={() => void edits.removeRepository(authorization)}
                    >
                      <Icon name={edits.removing === authorization.id ? 'loader' : 'trash'} size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
            {showSelector && (
              <RepositorySelectorField
                ref={selectorRef}
                value={selector}
                providers={selectorProviders}
                disabled={rowBusy}
                onChange={(value) => void changeSelector(value)}
              />
            )}
            {edits.error && (
              <div className="mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                {edits.error}
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
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit || saving || noProjects}
            className={!canSubmit || saving || noProjects ? 'pointer-events-none opacity-50' : undefined}
          >
            {saving ? t('saving') : destructiveChange ? t('replaceWorkspace') : t('save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
