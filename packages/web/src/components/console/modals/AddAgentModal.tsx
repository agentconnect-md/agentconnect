// No 'use client' here: these modals are rendered only by ModalProvider, which
// is the client boundary. Keeping the directive off this file avoids Next's
// "props must be serializable" entry-file check on the onClose callback.

import { useEffect, useRef, useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useProfile } from '@/lib/profile'
import { useOrgs } from '@/lib/org-context'
import {
  FALLBACK_RUNTIME_IDS,
  poolLabel,
  poolTagline,
  groupPlacementValue,
  approvalsReviewerDefault,
  loginRequiredRuntimeIds,
  agentSlugFinalize,
  agentSlugSanitize,
  effortChoicesFor,
  effortField,
  effortLabel,
  fastModeAvailableFor,
  modelCapability,
  modelLabel,
  displayedEffort,
  preferredModelFor,
  resolvedPermissionMode,
  resolveEffortForModel,
  permissionModeChoicesFor,
  permissionModeDefault,
  permissionModePresets,
  permissionPresetSettings,
  selectedPermissionPreset,
  type AgentCallPolicy,
  type ApprovalsReviewer,
  supportsModes
} from '@/lib/data'
import { addAgentDaemonChoice } from './add-agent-daemon-choice'
import {
  fetchGithubBranches,
  fetchGithubInstallations,
  fetchGithubInstallationRepo,
  fetchGithubInstallUrl,
  fetchGithubRepoRoster,
  fetchGithubRepoAccess,
  invalidateGithubRepoRosterCache,
  type AgentWorkspaceDto,
  type GithubInstallationDto,
  type GithubRepoAccess,
  type GithubRepoDto
} from '@/lib/api'
import { GithubMark, LoadingState } from '@/components/marks'
import { AgentIconPicker } from '@/components/console/AgentIconPicker'
import { DaemonSelect, type DaemonSelectOption } from '@/components/console/DaemonSelect'
import { RuntimeSelect } from '@/components/console/RuntimeSelect'
import { randomGlyphIcon, type AgentIcon } from '@/lib/agent-icon'
import { DEFAULT_AGENT_OUTPUT_MODE, type OutputMode } from '@/lib/output-mode'
import { Button, Icon } from '@/components/ui'
import { VisibilityField, type SharingValue } from '@/components/console/VisibilityField'
import { AgentCallVisibility } from '@/components/console/AgentCallVisibility'
import { OutputModeField } from '@/components/console/OutputModeField'
import { RuntimeChatField } from '@/components/console/RuntimeChatField'
import { SandboxField } from '@/components/console/SandboxField'
import {
  EnvSecretsFields,
  envRecordFromRows,
  envSecretsError,
  secretsRecordFromRows,
  type EnvVarDraft,
  type SecretDraft
} from '@/components/console/EnvSecretsFields'
import { normalizeAgentDir } from '@/lib/repo-subdir'
import {
  DEFAULT_EXTERNAL_MEMORY_BINDING,
  ExternalMemoryBindingFields,
  type ExternalMemoryBindingDraft
} from '@/components/console/ExternalMemoryBindingFields'
import { MemoryProviderPicker } from '@/components/console/MemoryProviderPicker'
import type { MemoryProviderChoice } from '@/components/console/memory-settings'
import {
  GithubConnectedBanner,
  GithubInstallPrompt,
  GithubPrivateReposNotice,
  GithubRepositoryField,
  GithubRepositoryOption,
  GitlabNoProjectsNotice,
  GitlabProjectField,
  GitlabProjectOption,
  RepositoryAccessField,
  WorktreeField,
  WorkingSubdirectoryField,
  WorkspaceBranchField,
  WorkspaceModeField,
  type WorkspaceMode
} from '@/components/console/WorkspaceFormFields'
import { matchGitlabProjects, type GitlabProjectChoice } from '@/lib/gitlab-projects'
import { useGitlabProjects } from '@/lib/use-gitlab-projects'

type WsMode = WorkspaceMode
type RepoCheckState = 'idle' | 'checking' | 'missing' | 'found'

// The dialog is a single scrolling form with a section rail beside it: every
// section is listed up front (so nothing hides below the fold), clicking one
// jumps to it, and scrolling highlights whichever section you are in. The rail
// labels the runtime *behavior* group rather than plain "Runtime" — the runtime
// picker itself lives in Basics, and two things named Runtime would send you to
// the wrong place.
type SectionId = 'basics' | 'runtime' | 'workspace' | 'access' | 'memory' | 'secrets'

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; icon: string }> = [
  { id: 'basics', label: 'Basics', icon: 'id-card' },
  { id: 'runtime', label: 'Runtime', icon: 'sliders-horizontal' },
  { id: 'workspace', label: 'Workspace', icon: 'folder-git-2' },
  { id: 'access', label: 'Access', icon: 'lock' },
  { id: 'memory', label: 'Memory', icon: 'database' },
  { id: 'secrets', label: 'Variables and Secrets', icon: 'code-xml' }
]

const RAIL_ITEM_ON =
  'flex flex-none cursor-pointer items-center gap-[9px] rounded-sm border-0 bg-(--surface-card) px-[10px] py-[7px] text-left font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary) shadow-(--shadow-xs)'
const RAIL_ITEM_OFF =
  'flex flex-none cursor-pointer items-center gap-[9px] rounded-sm border-0 bg-transparent px-[10px] py-[7px] text-left font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover)'

/** "3d ago" style relative label for the repo rows (design: `updated {{ r.updated }}`). */
function fmtAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${Math.max(m, 1)}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`
}

type GithubApiRepo = {
  full_name?: string
  private?: boolean
  default_branch?: string
  description?: string | null
  updated_at?: string | null
}

function repoFromGithubApi(row: GithubApiRepo): GithubRepoDto | null {
  if (!row.full_name) return null
  return {
    fullName: row.full_name,
    private: !!row.private,
    defaultBranch: row.default_branch || 'main',
    description: row.description ?? null,
    updatedAt: row.updated_at ?? null
  }
}

function githubRepoLabelFromInput(input: string): string | null {
  const raw = input
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (!raw) return null
  const path = raw
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '')
  const [owner, repo, ...rest] = path.split('/').filter(Boolean)
  if (!owner || !repo || rest.length > 0) return null
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner)) return null
  if (!/^[a-z0-9._-]+$/i.test(repo)) return null
  return `${owner}/${repo}`
}

async function fetchPublicGithubRepo(fullName: string, signal?: AbortSignal): Promise<GithubRepoDto | null> {
  const label = githubRepoLabelFromInput(fullName)
  if (!label) return null
  const res = await fetch(`https://api.github.com/repos/${label}`, { signal, cache: 'no-store' })
  if (!res.ok) return null
  const repo = repoFromGithubApi((await res.json()) as GithubApiRepo)
  return repo && !repo.private ? repo : null
}

async function fetchPublicGithubBranches(fullName: string, signal?: AbortSignal): Promise<string[] | null> {
  const label = githubRepoLabelFromInput(fullName)
  if (!label) return null
  const res = await fetch(`https://api.github.com/repos/${label}/branches?per_page=100`, { signal, cache: 'no-store' })
  if (!res.ok) return null
  const rows = (await res.json()) as Array<{ name?: string }>
  return rows.map((r) => r.name).filter((name): name is string => !!name)
}

async function searchPublicGithubRepos(query: string, signal?: AbortSignal): Promise<GithubRepoDto[]> {
  const q = query.trim()
  if (q.length < 3) return []
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} in:name is:public`)}&per_page=5`,
    { signal, cache: 'no-store' }
  )
  if (!res.ok) return []
  const body = (await res.json()) as { items?: GithubApiRepo[] }
  return (body.items ?? []).map(repoFromGithubApi).filter((repo): repo is GithubRepoDto => !!repo && !repo.private)
}

export default function AddAgentModal({ onClose }: { onClose: () => void }) {
  const { createAgent, daemons, agents, memberSets } = useConsoleData()
  const { me } = useProfile()
  const { activeOrg, orgPath } = useOrgs()
  const defaultAgentVisibility = activeOrg?.defaultAgentVisibility ?? 'all'
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  // New agents default to a random glyph+color (product default — not runtime-branded).
  const [icon, setIcon] = useState<AgentIcon>(() => randomGlyphIcon())
  const [runtime, setRuntime] = useState('') // '' = untouched; the daemon supplies the default
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [fastMode, setFastMode] = useState(false)
  const [outputMode, setOutputMode] = useState<OutputMode>(DEFAULT_AGENT_OUTPUT_MODE)
  const [showFooter, setShowFooter] = useState(true)
  const [showStatusBar, setShowStatusBar] = useState(false)
  const [memoryProvider, setMemoryProvider] = useState<MemoryProviderChoice>('managed')
  const [externalMemory, setExternalMemory] = useState<ExternalMemoryBindingDraft>(DEFAULT_EXTERNAL_MEMORY_BINDING)
  const [permissionMode, setPermissionMode] = useState(permissionModeDefault(FALLBACK_RUNTIME_IDS[0]!))
  const [approvalsReviewer, setApprovalsReviewer] = useState<ApprovalsReviewer | ''>('')
  const [allowRuntimeChangesInChat, setAllowRuntimeChangesInChat] = useState(false)
  const [description, setDescription] = useState('')
  const [daemonId, setDaemonId] = useState('')
  const [runInSandbox, setRunInSandbox] = useState(false)
  const [wsMode, setWsMode] = useState<WsMode>('scratch')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [agentDir, setAgentDir] = useState('')
  const [worktree, setWorktree] = useState(true)
  // GitHub App picker state (design: the picker IS the github path once the App
  // is installed — repo options only EXIST after an install; no App on this
  // deployment ⇒ everything stays the manual free-text flow — the daemon host
  // is assumed to have its own GitHub access). `ghEnabled: null` = probe in flight.
  const [ghEnabled, setGhEnabled] = useState<boolean | null>(null)
  const [ghInstalls, setGhInstalls] = useState<GithubInstallationDto[]>([])
  // Repos MERGED across every installation (an AgentConnect org can attach many
  // GitHub orgs/accounts — one flat, owner-qualified list beats a two-level
  // account→repo picker); each row remembers its owning installation so the
  // submit can point provenance at the right one.
  const [ghRepos, setGhRepos] = useState<Array<GithubRepoDto & { installationId: string }>>([])
  const [ghRepo, setGhRepo] = useState('') // owner/repo fullName
  const [ghBranches, setGhBranches] = useState<string[] | null>(null) // null = fetch failed → free text
  const [ghPush, setGhPush] = useState(false) // gitAccess: write|read
  // Per-user authz preflight for the picked repo (deployments with the
  // identity-assertion gate). null = unknown/loading — never blocks the UI;
  // the CP re-checks at create either way.
  const [ghAccess, setGhAccess] = useState<GithubRepoAccess | null>(null)
  // Public repositories remain available without a linked GitHub identity;
  // this only records that the private subset is intentionally hidden.
  const [ghPrivateReposHidden, setGhPrivateReposHidden] = useState(false)
  const [ghLoading, setGhLoading] = useState(false)
  // At least one installation's roster failed to load (e.g. a GitHub outage) —
  // the list may be incomplete, which must not read as "no repositories".
  const [ghReposFailed, setGhReposFailed] = useState(false)
  const [ghReposNonce, setGhReposNonce] = useState(0)
  // Design's dropdowns: .fmenu popovers with a type-to-filter search (one shared
  // query, reset on every open — mirrors the Sessions filter dropdowns).
  const [ghRepoOpen, setGhRepoOpen] = useState(false)
  const [ghBranchOpen, setGhBranchOpen] = useState(false)
  const [ghAccessOpen, setGhAccessOpen] = useState(false)
  const [ghQ, setGhQ] = useState('')
  const [ghPublicRepos, setGhPublicRepos] = useState<GithubRepoDto[]>([])
  const [ghPublicLoading, setGhPublicLoading] = useState(false)
  // An exact owner/repo lookup through an App installation. This supplements
  // the first page of the roster, so private repositories never fall through
  // to anonymous public GitHub search.
  const [ghInstalledExactRepo, setGhInstalledExactRepo] = useState<(GithubRepoDto & { installationId: string }) | null>(
    null
  )
  const [ghPublicExactRepo, setGhPublicExactRepo] = useState<GithubRepoDto | null>(null)
  const [ghExactRepoState, setGhExactRepoState] = useState<RepoCheckState>('idle')
  const [ghManualPublicRepo, setGhManualPublicRepo] = useState<GithubRepoDto | null>(null)
  // GitLab path: projects picked by their numeric id. One this organization has
  // not added yet is set up as part of picking it (§18.1).
  const [glProject, setGlProject] = useState('')
  const [glOpen, setGlOpen] = useState(false)
  const [glQ, setGlQ] = useState('')
  const [glAccessOpen, setGlAccessOpen] = useState(false)
  const [glPush, setGlPush] = useState(true)
  const [sharing, setSharing] = useState<SharingValue>({ visibility: 'org', sharedWith: [] })
  // The org default seeds both directions; this form can still override either one.
  const [callPolicy, setCallPolicy] = useState<AgentCallPolicy>(defaultAgentVisibility)
  const [allowedCallers, setAllowedCallers] = useState<string[]>([])
  const [outboundPolicy, setOutboundPolicy] = useState<AgentCallPolicy>(defaultAgentVisibility)
  const [allowedTargets, setAllowedTargets] = useState<string[]>([])
  // Optional env vars + write-only secrets to seed at create (createAgent accepts
  // both). Shared "Secrets and variables" editor with the Edit-agent modal.
  const [envRows, setEnvRows] = useState<EnvVarDraft[]>([])
  const [secretRows, setSecretRows] = useState<SecretDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<SectionId>('basics')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef(new Map<SectionId, HTMLElement>())

  const sectionRef = (id: SectionId) => (node: HTMLElement | null) => {
    if (node) sectionRefs.current.set(id, node)
    else sectionRefs.current.delete(id)
  }

  // A clicked section keeps the highlight until the reader actually scrolls
  // away. The trailing sections are shorter than the pane, so they cannot reach
  // its top: jumping to one bottoms the scroller out, and a purely
  // position-derived highlight would answer a click on Workspace with "Memory".
  // Latching the position we scrolled to distinguishes our own scroll from the
  // reader's without a timer.
  const pinnedScrollTop = useRef<number | null>(null)

  const goToSection = (id: SectionId) => {
    setActiveSection(id)
    const pane = scrollRef.current
    const node = sectionRefs.current.get(id)
    if (!pane || !node) return
    // Move the pane by measured delta and assign `scrollTop` outright. Both
    // `scrollIntoView` and `scrollTo` resolve to a no-op inside the dialog's
    // nested overflow containers once a smooth behavior is requested, so the
    // jump is instant — which is what the macOS/Stripe settings panes this
    // pattern comes from do anyway.
    pane.scrollTop = pane.scrollTop + node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20
    pinnedScrollTop.current = pane.scrollTop // read back: the browser clamps it
  }

  // Scroll-spy: highlight the last section whose heading has crossed the top of
  // the scroller. The final section is shorter than the pane and could never
  // reach the top on its own, so reaching the bottom always selects it.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = () => {
      if (pinnedScrollTop.current !== null) {
        // Still parked where a rail click put us — this is our own scroll.
        if (Math.abs(el.scrollTop - pinnedScrollTop.current) < 2) return
        pinnedScrollTop.current = null
      }
      const scrollable = el.scrollHeight - el.clientHeight > 8
      if (scrollable && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
        setActiveSection(SECTIONS[SECTIONS.length - 1]!.id)
        return
      }
      const paneTop = el.getBoundingClientRect().top
      let current = SECTIONS[0]!.id
      for (const s of SECTIONS) {
        const node = sectionRefs.current.get(s.id)
        if (node && node.getBoundingClientRect().top - paneTop <= 24) current = s.id
      }
      setActiveSection(current)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    return () => el.removeEventListener('scroll', sync)
  }, [])

  // Cloud is one UI choice AND one server-side placement: the pool, named as itself.
  // Flagged: with the pool hidden the choice is computed WITHOUT its members, so an
  // untouched form defaults to the first machine rather than submitting a pool placement.
  const placementDaemons = featureFlagEnabled('daemon-pool') ? daemons : daemons.filter((d) => !d.pool)
  const daemonChoice = addAgentDaemonChoice(placementDaemons, daemonId, memberSets)
  const {
    poolAvailable,
    availableGroups,
    offeredGroups,
    daemon,
    localDaemons,
    placement,
    value: effectiveDaemonId
  } = daemonChoice
  const daemonOptions: DaemonSelectOption[] = [
    ...(poolAvailable
      ? [
          {
            value: '',
            label: poolLabel(),
            title: poolTagline(),
            kind: 'pool' as const
          }
        ]
      : []),
    // The org's own groups sit with Cloud, not with the machines: they are the same KIND of target
    // — the server picks which member serves, and the agent survives losing any one of them.
    ...(featureFlagEnabled('daemon-groups') ? offeredGroups : []).map((group) => ({
      value: groupPlacementValue(group.setId),
      label: group.name,
      meta: `${group.memberDaemonIds.length} daemon${group.memberDaemonIds.length === 1 ? '' : 's'}`,
      title: availableGroups.includes(group)
        ? 'Any daemon in the group can serve this agent.'
        : group.memberDaemonIds.length === 0
          ? 'No daemons in this group yet.'
          : 'No daemon in this group is serving right now.',
      kind: 'group' as const,
      disabled: !availableGroups.includes(group)
    })),
    ...localDaemons.map((candidate) => ({
      value: candidate.daemonId,
      label: candidate.name,
      ...(candidate.status === 'online' ? {} : { meta: candidate.status }),
      title:
        candidate.status === 'online'
          ? 'Uses the credentials on this machine.'
          : 'This machine is not currently serving.'
    }))
  ]
  const sandboxRequired = daemon?.caps.features.includes('sandbox-required') ?? false
  const sandboxSupported = sandboxRequired || (daemon?.caps.features.includes('sandbox') ?? false)
  const effectiveRunInSandbox = sandboxRequired || (sandboxSupported && runInSandbox)
  // Runtime ids come from the selected daemon's reported profiles — the registry ids
  // that round-trip back to the launch key — so a created agent actually resolves.
  // No daemon (or none reported) ⇒ the static fallback list.
  const runtimeIds = daemon?.runtimeModels.length ? daemon.runtimeModels.map((r) => r.runtime) : FALLBACK_RUNTIME_IDS
  // Runtimes the daemon reports as logged out. Marked in the picker, never blocked —
  // creating on one is a supported state (docs/designs/preset-agents.md §3.2).
  const runtimesNeedingLogin = loginRequiredRuntimeIds(daemon)
  // …but the DEFAULT prefers a signed-in one, mirroring how auto-placement picks a
  // preset's runtime. Falls through to the first reported id when all are logged out.
  const defaultRuntime = runtimeIds.find((id) => !runtimesNeedingLogin.includes(id)) ?? runtimeIds[0] ?? ''
  // `runtime` is '' until the user picks one, so the default above applies to a fresh
  // form while an explicit choice — logged out or not — always survives.
  const effectiveRuntime = runtime && runtimeIds.includes(runtime) ? runtime : defaultRuntime
  // Models come from the chosen daemon's reported capabilities for this runtime.
  // There is no separate "Default" entry: with real models known, the picker
  // preselects the runtime's resolved default (else the first model) and the
  // agent stores that concrete id. '' survives only when nothing is advertised.
  const runtimeProfile = daemon?.runtimeModels.find((r) => r.runtime === effectiveRuntime)
  const models = runtimeProfile?.models ?? []
  const modelCatalog = runtimeProfile?.modelCatalog ?? undefined
  const selectedModel = models.includes(model) ? model : preferredModelFor(daemon, effectiveRuntime)
  const runtimeSupportsModes = supportsModes(effectiveRuntime)
  // Dynamic-first vocabularies (runtime-model-catalog.md §7): the SELECTED
  // model's discovered capability drives the effort/fast controls, the catalog's
  // runtime-level list the permission modes; the static tables stay the fallback
  // when the catalog is absent. Discovered efforts decide visibility themselves
  // ([] ⇒ the model has no effort selector); the static fallback keeps the
  // legacy per-runtime supportsModes gate.
  const capability = modelCapability(daemon, effectiveRuntime, selectedModel)
  const effortChoices = effortChoicesFor(effectiveRuntime, capability)
  const showEffort = capability?.efforts ? effortChoices.length > 0 : runtimeSupportsModes
  // '' lights the vocabulary's Default pill when it has one, else the model's
  // own observed default level (and new agents then store the lit value
  // explicitly, mirroring the model treatment).
  const selectedEffort = showEffort ? displayedEffort(effort, effortChoices, capability?.defaultEffort) : ''
  // A selection the arriving vocabulary no longer offers stays visible as
  // unavailable — never auto-cleared (the user changes it, we don't).
  const effortOptions =
    capability?.efforts && selectedEffort && !effortChoices.some((o) => o.value === selectedEffort)
      ? [
          ...effortChoices,
          { value: selectedEffort, label: `${effortLabel(effectiveRuntime, selectedEffort)} (unavailable)` }
        ]
      : effortChoices
  const fastModeAvailable = fastModeAvailableFor(effectiveRuntime, capability)
  const permissionChoices = permissionModeChoicesFor(effectiveRuntime, modelCatalog)
  const showPermission = !!modelCatalog?.permissionModes?.length || runtimeSupportsModes
  // A statically-guessed initial mode the dynamic vocabulary doesn't offer is a
  // phantom, not user data — resolve it to the runtime's own default (probe
  // currentValue), else the first offered mode. No "(unavailable)" here: unlike
  // Edit, nothing in this modal is stored yet.
  const selectedPermissionMode = resolvedPermissionMode(permissionMode, permissionChoices, modelCatalog)
  const defaultApprovalsReviewer = approvalsReviewerDefault(effectiveRuntime)
  const selectedApprovalsReviewer = defaultApprovalsReviewer
    ? approvalsReviewer || defaultApprovalsReviewer
    : defaultApprovalsReviewer
  const permissionOptions = permissionModePresets(effectiveRuntime, permissionChoices)
  const selectedPermissionModePreset = selectedPermissionPreset(
    effectiveRuntime,
    selectedPermissionMode,
    selectedApprovalsReviewer
  )

  // A daemon selection defines the product default: optional means off; required
  // means on and immutable. Capability refreshes converge the same way.
  useEffect(() => {
    setRunInSandbox(sandboxRequired)
  }, [effectiveDaemonId, sandboxRequired])

  // Probe on open: App enabled on this deployment? Any installations? Refetch on
  // window focus too — "Install GitHub app" finishes in another tab, and coming
  // back should light the picker up without reopening the modal.
  useEffect(() => {
    let alive = true
    const probe = () =>
      fetchGithubInstallations()
        .then(({ enabled, installations }) => {
          if (!alive) return
          setGhEnabled(enabled)
          setGhInstalls(installations)
        })
        .catch(() => alive && setGhEnabled(false))
    void probe()
    const onFocus = () => void probe()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const usingPicker = wsMode === 'github' && ghEnabled === true && ghInstalls.length > 0

  // Only the GitLab pane asks for projects; every other source issues no request.
  const gl = useGitlabProjects(wsMode === 'gitlab', glQ)
  const glNoProjects = wsMode === 'gitlab' && gl.empty
  const glPicked = gl.choices.find((choice) => choice.projectId === glProject)
  const glMatches = matchGitlabProjects(gl.choices, glQ)

  // Picking an unadded project provisions it first; a failed setup picks nothing.
  const pickGlProject = async (choice: GitlabProjectChoice) => {
    if (!choice.binding && !(await gl.provision(choice.projectId))) return
    setGlProject(choice.projectId)
    setGlOpen(false)
    setBranch(choice.defaultBranch ?? '')
    setErr(null)
  }

  // Installations loaded or refreshed → merge repository pages as they arrive.
  // GitHub has no server-side search here, so the dropdown filters locally.
  // Refreshing this roster must not reset an in-progress agent setup.
  useEffect(() => {
    if (!usingPicker) return
    let alive = true
    const ctrl = new AbortController()
    setGhLoading(true)
    setGhPrivateReposHidden(false)
    setGhReposFailed(false)
    const applyRoster = (refreshed: Array<GithubRepoDto & { installationId: string }>) => {
      if (!alive) return
      setGhRepos((current) => {
        // Keep an exact App-backed selection through a failed or stale
        // metadata refresh so it remains associated with the installation
        // for later branch and access checks.
        const selected = current.find((repo) => repo.fullName === ghRepo)
        if (
          !selected ||
          !ghInstalls.some((installation) => installation.id === selected.installationId) ||
          refreshed.some(
            (repo) =>
              repo.installationId === selected.installationId &&
              repo.fullName.toLowerCase() === selected.fullName.toLowerCase()
          )
        ) {
          return refreshed
        }
        return [...refreshed, selected]
      })
    }
    void fetchGithubRepoRoster(ghInstalls, ctrl.signal, applyRoster)
      .then(({ repos, privateReposHidden, failed }) => {
        if (!alive) return
        setGhPrivateReposHidden(privateReposHidden)
        // A failed roster read (GitHub outage) must not render as an empty
        // list — keep the pages that loaded and surface the gap with a retry.
        setGhReposFailed(failed)
        applyRoster(repos)
      })
      .finally(() => alive && setGhLoading(false))
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [usingPicker, ghInstalls, ghReposNonce])

  // Bonus autocomplete for public GitHub repos outside the installation grant
  // set. The exact owner/repo free-text path below still works if GitHub search
  // is rate-limited or unavailable in the browser.
  useEffect(() => {
    if (!usingPicker || !ghRepoOpen || ghQ.trim().length < 3) {
      setGhPublicRepos([])
      setGhPublicLoading(false)
      return
    }
    const ctrl = new AbortController()
    const t = window.setTimeout(() => {
      setGhPublicLoading(true)
      searchPublicGithubRepos(ghQ, ctrl.signal)
        .then((repos) => setGhPublicRepos(repos))
        .catch(() => setGhPublicRepos([]))
        .finally(() => {
          if (!ctrl.signal.aborted) setGhPublicLoading(false)
        })
    }, 250)
    return () => {
      ctrl.abort()
      window.clearTimeout(t)
    }
  }, [usingPicker, ghRepoOpen, ghQ])

  const ghRepoQuery = ghQ.trim()
  const typedPublicRepo = githubRepoLabelFromInput(ghRepoQuery)
  const syncedRepoMatches = ghRepos.filter(
    (r) => !ghRepoQuery || r.fullName.toLowerCase().includes(ghRepoQuery.toLowerCase())
  )
  const typedPublicRepoLower = typedPublicRepo?.toLowerCase()
  const exactSyncedRepoMatch = typedPublicRepoLower
    ? ghRepos.find((r) => r.fullName.toLowerCase() === typedPublicRepoLower)
    : undefined
  const exactInstalledRepoMatch =
    typedPublicRepoLower && ghInstalledExactRepo?.fullName.toLowerCase() === typedPublicRepoLower
      ? ghInstalledExactRepo
      : undefined
  const picked = ghRepos.find((r) => r.fullName === ghRepo)
  const manualPublicRepo = !!ghManualPublicRepo && ghManualPublicRepo.fullName === ghRepo && !picked
  const publicRepo = manualPublicRepo ? ghManualPublicRepo.fullName : null
  const publicRepoMatches = ghPublicRepos.filter((r) => {
    const fullName = r.fullName.toLowerCase()
    return (
      fullName !== typedPublicRepoLower &&
      !ghRepos.some((repo) => repo.fullName.toLowerCase() === fullName) &&
      fullName !== exactInstalledRepoMatch?.fullName.toLowerCase()
    )
  })
  const canUseTypedPublicRepo =
    !!typedPublicRepo &&
    !exactSyncedRepoMatch &&
    !exactInstalledRepoMatch &&
    !!ghPublicExactRepo &&
    ghPublicExactRepo.fullName.toLowerCase() === typedPublicRepoLower

  useEffect(() => {
    if (!usingPicker || !ghRepoOpen || !typedPublicRepo || exactSyncedRepoMatch) {
      setGhInstalledExactRepo(null)
      setGhPublicExactRepo(null)
      setGhExactRepoState('idle')
      return
    }
    let alive = true
    const ctrl = new AbortController()
    const t = window.setTimeout(() => {
      const [owner, repo] = typedPublicRepo.split('/')
      if (!owner || !repo) return
      setGhInstalledExactRepo(null)
      setGhPublicExactRepo(null)
      setGhExactRepoState('checking')
      const matchingInstallations = ghInstalls.filter(
        (installation) => installation.accountLogin.toLowerCase() === owner.toLowerCase()
      )
      const candidates = matchingInstallations.length > 0 ? matchingInstallations : ghInstalls
      void Promise.all(
        candidates.map(async (installation) => {
          const found = await fetchGithubInstallationRepo(installation.id, owner, repo, ctrl.signal).catch(() => null)
          return found ? { ...found, installationId: installation.id } : null
        })
      ).then((matches) => {
        if (!alive || ctrl.signal.aborted) return
        const installed = matches.find((match): match is GithubRepoDto & { installationId: string } => match !== null)
        if (installed) {
          setGhInstalledExactRepo(installed)
          setGhExactRepoState('found')
          return
        }
        fetchPublicGithubRepo(typedPublicRepo, ctrl.signal)
          .then((publicRepo) => {
            if (!alive) return
            setGhPublicExactRepo(publicRepo)
            setGhExactRepoState(publicRepo ? 'found' : 'missing')
          })
          .catch(() => {
            if (alive && !ctrl.signal.aborted) {
              setGhPublicExactRepo(null)
              setGhExactRepoState('missing')
            }
          })
      })
    }, 250)
    return () => {
      alive = false
      ctrl.abort()
      window.clearTimeout(t)
    }
  }, [usingPicker, ghRepoOpen, ghInstalls, typedPublicRepo, exactSyncedRepoMatch])

  // The gate's two UI shapes: an outright denial (no read → block create with a
  // note), and read-but-not-write (pin the agent to read-only).
  const ghDenied = ghAccess?.gated && !ghAccess.canRead ? ghAccess : null
  const ghReadOnly = !!ghAccess?.gated && ghAccess.canRead && !ghAccess.canWrite
  const ghPushDisabled = ghReadOnly || manualPublicRepo
  const ghPushChecked = manualPublicRepo ? false : ghPush

  // A read-only user must not submit gitAccess=write — clamp the toggle state
  // itself so the request body follows.
  useEffect(() => {
    if (ghReadOnly) setGhPush(false)
  }, [ghReadOnly])

  const pickSyncedGithubRepo = (r: GithubRepoDto & { installationId: string }) => {
    // Keep an exact App-backed result in the local roster after the popover
    // closes, so the selected private repository retains its installation id.
    setGhRepos((repos) =>
      repos.some(
        (repo) => repo.installationId === r.installationId && repo.fullName.toLowerCase() === r.fullName.toLowerCase()
      )
        ? repos
        : [...repos, r]
    )
    setGhManualPublicRepo(null)
    setGhRepo(r.fullName)
    setBranch(r.defaultBranch)
    setGhRepoOpen(false)
  }

  const pickPublicGithubRepo = (r: GithubRepoDto) => {
    const label = githubRepoLabelFromInput(r.fullName)
    if (!label) return
    setGhRepo(label)
    setGhManualPublicRepo({ ...r, fullName: label })
    setBranch(r.defaultBranch)
    setGhAccess(null)
    setGhBranches(null)
    setGhBranchOpen(false)
    setGhRepoOpen(false)
  }

  const submitGithubRepoSearch = () => {
    if (exactSyncedRepoMatch) {
      pickSyncedGithubRepo(exactSyncedRepoMatch)
      return
    }
    if (exactInstalledRepoMatch) {
      pickSyncedGithubRepo(exactInstalledRepoMatch)
      return
    }
    if (canUseTypedPublicRepo && ghPublicExactRepo) pickPublicGithubRepo(ghPublicExactRepo)
  }

  // Repo picked → branch to its real default (never assume 'main' for synced
  // repos); a failed listing degrades to a free-text branch input. Manually
  // typed public repos use anonymous GitHub reads only as a UX enhancement.
  useEffect(() => {
    if (!usingPicker) return
    if (!ghRepo) {
      setBranch('')
      setGhBranches([])
      setGhBranchOpen(false)
      setGhAccess(null)
      setGhManualPublicRepo(null)
      return
    }
    if (!picked) {
      setGhAccess(null)
      setGhBranchOpen(false)
      setGhBranches(null)
      const manualRepo = manualPublicRepo ? ghManualPublicRepo : null
      if (!manualRepo) {
        setBranch('')
        setGhManualPublicRepo(null)
        return
      }
      const label = manualRepo.fullName
      let alive = true
      const ctrl = new AbortController()
      void fetchPublicGithubRepo(label, ctrl.signal)
        .then((repo) => {
          if (alive && repo?.defaultBranch)
            setBranch((cur) => (!cur.trim() || cur === 'main' ? repo.defaultBranch : cur))
        })
        .catch(() => {})
      void fetchPublicGithubBranches(label, ctrl.signal)
        .then((names) => {
          if (alive && names?.length) setGhBranches(names)
        })
        .catch(() => {})
      return () => {
        alive = false
        ctrl.abort()
      }
    }
    setBranch(picked.defaultBranch)
    const [owner, repo] = picked.fullName.split('/')
    if (!owner || !repo) return
    let alive = true
    setGhBranches(null)
    setGhAccess(null)
    fetchGithubBranches(picked.installationId, owner, repo)
      .then((names) => alive && setGhBranches(names))
      .catch(() => alive && setGhBranches(null))
    fetchGithubRepoAccess(picked.installationId, owner, repo)
      .then((a) => alive && setGhAccess(a))
      .catch(() => alive && setGhAccess(null)) // unknown — don't block; the CP enforces at create
    return () => {
      alive = false
    }
  }, [
    usingPicker,
    ghRepo,
    manualPublicRepo,
    ghManualPublicRepo?.fullName,
    picked?.defaultBranch,
    picked?.fullName,
    picked?.installationId
  ])

  const submit = async () => {
    // The name input sanitizes as you type, so finalize only trims a trailing
    // hyphen. An empty name falls back to a slug derived from the display name
    // ("Deploy Bot" → deploy-bot) — a non-latin display name derives nothing,
    // so the explicit name stays required then.
    const slug = agentSlugFinalize(name) || agentSlugFinalize(displayName)
    if (busy) return
    if (!slug) {
      setErr('Name is required — lowercase letters, digits and hyphens.')
      return
    }
    if (!daemon) {
      setErr('No daemon available — start a daemon first.')
      return
    }
    if (usingPicker && !ghRepo) {
      setErr('Pick a repository, type an authorized GitHub repository, or switch to “From scratch”.')
      return
    }
    if (usingPicker && !picked && !publicRepo) {
      setErr('Type an authorized GitHub repository as owner/repo, or pick a synced repository.')
      return
    }
    if (usingPicker && ghDenied) {
      setErr(
        ghDenied.denied === 'GITHUB_IDENTITY_REQUIRED'
          ? 'Link your GitHub profile to verify repository access, then retry.'
          : 'You don’t have access to this repository on GitHub.'
      )
      return
    }
    if (wsMode === 'github' && !usingPicker && !repo.trim()) {
      setErr('Pick a GitHub repository, or switch to “From scratch”.')
      return
    }
    if (wsMode === 'gitlab' && !glProject) {
      setErr('Pick a GitLab project, or switch to “From scratch”.')
      return
    }
    if (memoryProvider === 'external' && !externalMemory.connectionId) {
      setErr('Select an external-memory connection, or choose another memory backend.')
      return
    }
    if (envSecretError) {
      setErr(envSecretError)
      return
    }
    const envRecord = envRecordFromRows(envRows)
    const secretsRecord = secretsRecordFromRows(secretRows)
    let normalizedAgentDir: string | undefined
    if (wsMode !== 'scratch') {
      try {
        normalizedAgentDir = normalizeAgentDir(agentDir)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return
      }
    }
    setBusy(true)
    setErr(null)
    const workspace: AgentWorkspaceDto =
      wsMode === 'gitlab'
        ? {
            mode: 'gitlab',
            worktree,
            projectId: glProject,
            ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
            ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
            gitAccess: glPush ? ('write' as const) : ('read' as const)
          }
        : wsMode === 'github'
          ? usingPicker
            ? picked
              ? {
                  mode: 'github',
                  worktree,
                  gitRepo: picked.fullName, // owner/repo — the CP normalizes to the full address
                  ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                  ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {}),
                  installationId: picked.installationId,
                  gitAccess: ghPush ? ('write' as const) : ('read' as const)
                }
              : {
                  mode: 'github',
                  worktree,
                  gitRepo: publicRepo ?? ghRepo.trim(),
                  ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                  ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {})
                }
            : {
                mode: 'github',
                worktree,
                gitRepo: repo.trim(),
                ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
                ...(normalizedAgentDir ? { agentDir: normalizedAgentDir } : {})
              }
          : { mode: 'scratch' }
    try {
      await createAgent({
        name: slug,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        icon,
        runtime: effectiveRuntime,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(placement?.kind === 'pool'
          ? { placementKind: 'pool' as const }
          : placement?.kind === 'set'
            ? { placementKind: 'set' as const, setId: placement.setId }
            : placement
              ? { daemonId: placement.daemonId }
              : {}),
        outputMode,
        showFooter,
        showStatusBar,
        ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        fastMode: fastModeAvailable ? fastMode : false,
        ...(memoryProvider === 'external'
          ? {
              memory: {
                provider: 'external' as const,
                connectionId: externalMemory.connectionId,
                recall: externalMemory.recall,
                capture: { mode: externalMemory.captureMode }
              }
            }
          : memoryProvider !== 'managed'
            ? { memory: { provider: memoryProvider as 'native' | 'none' } }
            : {}),
        runInSandbox: effectiveRunInSandbox,
        ...(Object.keys(envRecord).length ? { env: envRecord } : {}),
        ...(Object.keys(secretsRecord).length ? { secrets: secretsRecord } : {}),
        permissionMode: selectedPermissionMode,
        ...(selectedApprovalsReviewer ? { approvalsReviewer: selectedApprovalsReviewer } : {}),
        allowRuntimeChangesInChat,
        workspace,
        // Atomic restricted-create: the CP intersects sharedWith with org members.
        ...(sharing.visibility === 'restricted'
          ? { visibility: 'restricted' as const, sharedWith: sharing.sharedWith }
          : {}),
        // Preserve the choices shown in this form even if the organization default
        // changes concurrently. The CP intersects selected lists with visible peers.
        callPolicy,
        allowedCallerAgentIds: callPolicy === 'selected' ? allowedCallers : [],
        outboundPolicy,
        allowedTargetAgentIds: outboundPolicy === 'selected' ? allowedTargets : []
      })
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // The CP replies 409 when (org, name) is already taken.
      setErr(msg.includes('409') ? `An agent named “${slug}” already exists.` : msg)
      setBusy(false)
    }
  }

  // Fresh link per click — the install URL carries a ONE-SHOT signed state.
  const installGithubApp = async () => {
    try {
      const url = await fetchGithubInstallUrl()
      if (url) window.open(url, '_blank', 'noopener')
      else setErr('Could not mint an install link (viewer role cannot install).')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  // "Manage access" lands on the App's ACCOUNT CHOOSER (installations/new): every
  // account is listed — already-installed ones open their repo-selection config,
  // and a fresh org can be installed from the same page. The signed setup callback
  // binds each new installation to this AgentConnect org. Same one-shot link as
  // the install button.
  const manageGithubAccess = installGithubApp

  const modeHint =
    wsMode === 'gitlab'
      ? 'The project is cloned onto the machine; the agent runs from the directory you pick.'
      : wsMode === 'github'
        ? 'The repo is cloned onto the machine; the agent runs from the directory you pick.'
        : 'We create a fresh working directory on the daemon — nothing is cloned.'

  // What still blocks Create, per section — an amber dot on the rail item plus,
  // in the footer, the first one you have to go fix. These mirror `submit`'s
  // guards, so the dots clear exactly when the button starts working. Access
  // never appears: visibility always carries a value (org by default).
  const envSecretError = envSecretsError(envRows, secretRows)
  // What the agent-visibility copy calls this not-yet-created agent.
  const callVisibilityTarget =
    agentSlugFinalize(name) || agentSlugFinalize(displayName) ? (
      <span className="font-mono text-[12.5px]">{agentSlugFinalize(name) || agentSlugFinalize(displayName)}</span>
    ) : (
      'this agent'
    )

  const blockers: Partial<Record<SectionId, string>> = {}
  if (!(agentSlugFinalize(name) || agentSlugFinalize(displayName))) blockers.basics = 'name is required'
  else if (!daemon) blockers.basics = 'no daemon available'
  if (usingPicker && !ghRepo) blockers.workspace = 'pick a repository'
  else if (usingPicker && ghDenied) blockers.workspace = 'no access to this repository'
  else if (usingPicker && !picked && !publicRepo) blockers.workspace = 'pick a repository'
  else if (wsMode === 'github' && !usingPicker && !repo.trim()) blockers.workspace = 'add a repository'
  else if (wsMode === 'gitlab' && glNoProjects) blockers.workspace = 'no GitLab projects added'
  else if (wsMode === 'gitlab' && !glProject) blockers.workspace = 'pick a project'
  if (envSecretError) blockers.secrets = envSecretError
  if (memoryProvider === 'external' && !externalMemory.connectionId) blockers.memory = 'select a connection'
  const firstBlocker = SECTIONS.find((s) => blockers[s.id])
  const blockerHint = firstBlocker ? `${firstBlocker.label}: ${blockers[firstBlocker.id]}` : null

  return (
    <>
      <div className="modalhead">
        <AgentIconPicker value={icon} runtime={effectiveRuntime} onChange={setIcon} size={30} />
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Add agent</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col desktop:min-h-[420px] desktop:flex-row">
        {/* Section rail: a column beside the form on desktop, a scrollable strip
            above it on phones (a 172px rail would eat a bottom sheet). */}
        <nav className="flex flex-none items-center gap-1 overflow-x-auto border-b border-(--border-subtle) bg-(--surface-sunken) p-2 desktop:w-[200px] desktop:flex-col desktop:items-stretch desktop:gap-[2px] desktop:overflow-x-visible desktop:overflow-y-auto desktop:border-r desktop:border-b-0 desktop:py-[10px]">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={activeSection === s.id ? RAIL_ITEM_ON : RAIL_ITEM_OFF}
              onClick={() => goToSection(s.id)}
            >
              <Icon
                name={s.icon}
                size={14}
                color={activeSection === s.id ? 'var(--brand)' : 'var(--text-tertiary)'}
                className="flex-none"
              />
              <span className="truncate">{s.label}</span>
              {blockers[s.id] ? (
                <span
                  className="h-[6px] w-[6px] flex-none rounded-full bg-(--amber-500) desktop:ml-auto"
                  title={blockers[s.id]}
                />
              ) : null}
            </button>
          ))}
        </nav>
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto p-5">
          <section ref={sectionRef('basics')}>
            <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Basics</div>
            <div className="mt-[13px] grid grid-cols-1 gap-[14px] desktop:grid-cols-2">
              <div className="fld">
                <span className="fldlbl">Name</span>
                <input
                  className="inp mn"
                  placeholder="deploy-bot"
                  value={name}
                  onChange={(e) => setName(agentSlugSanitize(e.target.value))}
                  autoFocus
                />
              </div>
              <div className="fld">
                <span className="fldlbl">Display name</span>
                <input
                  className="inp"
                  placeholder="Deploy Bot (optional)"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="fld desktop:col-span-2">
                <span className="fldlbl">Description</span>
                <textarea
                  className="inp resize-y px-3 py-[8px] leading-[1.5] focus:border-(--brand) focus:outline-none"
                  rows={2}
                  placeholder="Ships and rolls back deploys from chat"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              {/* Daemon / Runtime / Model share one 3-up row inside the Basics grid. */}
              <div className="desktop:col-span-2 grid grid-cols-1 gap-[14px] desktop:grid-cols-3">
                <div className="fld">
                  <span className="fldlbl">Runs on</span>
                  <DaemonSelect value={effectiveDaemonId} options={daemonOptions} onChange={setDaemonId} />
                </div>
                <div className="fld">
                  <span className="fldlbl">Runtime</span>
                  <RuntimeSelect
                    value={effectiveRuntime}
                    options={runtimeIds}
                    needsLogin={runtimesNeedingLogin}
                    onChange={(nextRuntime) => {
                      setRuntime(nextRuntime)
                      setEffort('')
                      setPermissionMode(permissionModeDefault(nextRuntime))
                      setApprovalsReviewer(approvalsReviewerDefault(nextRuntime))
                    }}
                  />
                </div>
                <div className="fld">
                  <span className="fldlbl">Model</span>
                  {/* No advertised models ⇒ nothing to choose: an inert em-dash field
                  rather than a fabricated "Default" entry the runtime never offered. */}
                  <div
                    className={models.length ? 'inp relative' : 'inp cursor-not-allowed'}
                    title={models.length ? undefined : 'This runtime reports no selectable models'}
                  >
                    <span className={`truncate ${models.length ? '' : 'text-(--text-tertiary)'}`}>
                      {models.length ? modelLabel(selectedModel) : '—'}
                    </span>
                    {models.length > 0 && (
                      <>
                        <Icon name="chevron-down" size={15} color="var(--text-tertiary)" className="flex-none" />
                        <select
                          value={selectedModel}
                          onChange={(e) => {
                            const next = e.target.value
                            setModel(next)
                            // Picking a model resolves an effort the new model doesn't offer:
                            // its default level, else the nearest available tier.
                            setEffort((cur) =>
                              resolveEffortForModel(
                                effectiveRuntime,
                                modelCapability(daemon, effectiveRuntime, next),
                                cur
                              )
                            )
                          }}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="Model"
                        >
                          {models.map((m) => (
                            <option key={m} value={m}>
                              {modelLabel(m)}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section ref={sectionRef('runtime')} className="mt-5 border-t border-(--border-subtle) pt-5">
            <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Runtime</div>
            <div className="mt-[13px] grid grid-cols-1 gap-[14px] desktop:grid-cols-2">
              {(showEffort || fastModeAvailable || showPermission) && (
                <div className="fld desktop:col-span-2">
                  <div className="grid grid-cols-1 gap-x-7 gap-y-[14px] desktop:grid-cols-[minmax(0,1fr)_auto]">
                    {showEffort && (
                      <div className="flex min-w-0 flex-col gap-[6px]">
                        <span className="fldlbl">{effortField(effectiveRuntime).label}</span>
                        <div className="pillbar self-start">
                          {effortOptions.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              title={o.description}
                              className={
                                selectedEffort === o.value
                                  ? 'pill on px-[10px] py-1 text-[12px]'
                                  : 'pill px-[10px] py-1 text-[12px]'
                              }
                              onClick={() => setEffort(o.value)}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {fastModeAvailable && (
                      <div className="flex flex-col gap-[6px]">
                        <span className="fldlbl">Fast mode</span>
                        <div className="pillbar self-start">
                          <button
                            type="button"
                            className={
                              fastMode ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'
                            }
                            onClick={() => setFastMode(true)}
                          >
                            On
                          </button>
                          <button
                            type="button"
                            className={
                              fastMode ? 'pill px-[10px] py-1 text-[12px]' : 'pill on px-[10px] py-1 text-[12px]'
                            }
                            onClick={() => setFastMode(false)}
                          >
                            Off
                          </button>
                        </div>
                      </div>
                    )}
                    {showPermission && (
                      <div className="flex min-w-0 flex-col gap-[6px] desktop:col-span-2">
                        <span className="fldlbl">Permission mode</span>
                        <div className="pillbar max-w-full overflow-x-auto self-start">
                          {permissionOptions.map((o) => (
                            <button
                              key={o.v}
                              type="button"
                              title={o.description}
                              className={
                                selectedPermissionModePreset === o.v
                                  ? 'pill on whitespace-nowrap px-[10px] py-1 text-[12px]'
                                  : 'pill whitespace-nowrap px-[10px] py-1 text-[12px]'
                              }
                              onClick={() => {
                                const next = permissionPresetSettings(effectiveRuntime, o.v)
                                setPermissionMode(next.permissionMode)
                                setApprovalsReviewer(next.approvalsReviewer)
                              }}
                            >
                              {o.l}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <RuntimeChatField checked={allowRuntimeChangesInChat} onChange={setAllowRuntimeChangesInChat} />
              <SandboxField
                checked={effectiveRunInSandbox}
                supported={sandboxSupported}
                required={sandboxRequired}
                clusterPlacement={placement?.kind === 'pool'}
                onChange={setRunInSandbox}
              />
              <OutputModeField
                className="desktop:col-span-2"
                value={outputMode}
                onChange={setOutputMode}
                showFooter={showFooter}
                onShowFooterChange={setShowFooter}
                showStatusBar={showStatusBar}
                onShowStatusBarChange={setShowStatusBar}
              />
            </div>
          </section>

          <section ref={sectionRef('workspace')} className="mt-5 border-t border-(--border-subtle) pt-5">
            <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Workspace</div>
            <div className="mt-[13px] grid grid-cols-1 gap-[14px] desktop:grid-cols-2">
              <WorkspaceModeField className="desktop:col-span-2" label={null} value={wsMode} onChange={setWsMode} />

              {wsMode === 'github' && ghEnabled === true && ghInstalls.length === 0 && (
                <GithubInstallPrompt onInstall={installGithubApp} />
              )}

              {usingPicker && (
                <div className="desktop:col-span-2 grid grid-cols-1 gap-[14px] desktop:grid-cols-2 desktop:gap-x-7">
                  <GithubConnectedBanner onManage={manageGithubAccess} />

                  <GithubRepositoryField
                    value={picked?.fullName ?? publicRepo ?? ''}
                    icon={picked?.private ? 'lock' : 'book-marked'}
                    badge={manualPublicRepo ? 'public' : undefined}
                    loading={ghLoading}
                    open={ghRepoOpen}
                    query={ghQ}
                    onToggle={() => {
                      setGhQ('')
                      setGhBranchOpen(false)
                      setGhAccessOpen(false)
                      setGhRepoOpen((value) => !value)
                    }}
                    onClose={() => setGhRepoOpen(false)}
                    onQueryChange={setGhQ}
                    onSearchKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        submitGithubRepoSearch()
                      }
                    }}
                    error={
                      ghReposFailed && !ghLoading
                        ? 'Couldn’t load repositories from GitHub — the list may be incomplete.'
                        : undefined
                    }
                    onRetry={() => {
                      invalidateGithubRepoRosterCache()
                      setGhReposNonce((value) => value + 1)
                    }}
                    note={
                      <>
                        {ghDenied && (
                          <span className="mt-[6px] inline-flex items-start gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--red-500)">
                            <Icon name="triangle-alert" size={13} className="mt-[1px] flex-none" />
                            {ghDenied.denied === 'GITHUB_IDENTITY_REQUIRED'
                              ? 'Link your GitHub profile to verify repository access, then retry.'
                              : 'You don’t have access to this repository on GitHub, so it can’t be attached to an agent.'}
                          </span>
                        )}
                        {ghPrivateReposHidden && (
                          <GithubPrivateReposNotice profileHref={orgPath('/profile#sign-in-methods')} />
                        )}
                      </>
                    }
                  >
                    {ghExactRepoState === 'checking' && typedPublicRepo && !exactSyncedRepoMatch && (
                      <div className="px-2 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                        Checking GitHub repository…
                      </div>
                    )}
                    {exactInstalledRepoMatch && !exactSyncedRepoMatch && (
                      <GithubRepositoryOption
                        key={`installation:${exactInstalledRepoMatch.installationId}:${exactInstalledRepoMatch.fullName}`}
                        fullName={exactInstalledRepoMatch.fullName}
                        icon={exactInstalledRepoMatch.private ? 'lock' : 'book-marked'}
                        description="Available through the GitHub App"
                        selected={ghRepo === exactInstalledRepoMatch.fullName}
                        onSelect={() => pickSyncedGithubRepo(exactInstalledRepoMatch)}
                      />
                    )}
                    {canUseTypedPublicRepo && ghPublicExactRepo && (
                      <GithubRepositoryOption
                        key={`public:${ghPublicExactRepo.fullName}`}
                        fullName={ghPublicExactRepo.fullName}
                        icon="book-marked"
                        description="Use public repository"
                        selected={ghRepo === ghPublicExactRepo.fullName}
                        onSelect={() => pickPublicGithubRepo(ghPublicExactRepo)}
                      />
                    )}
                    {syncedRepoMatches.map((repo) => (
                      <GithubRepositoryOption
                        key={repo.fullName}
                        fullName={repo.fullName}
                        icon={repo.private ? 'lock' : 'book-marked'}
                        description={
                          <>
                            {repo.description ?? 'No description'}
                            {repo.updatedAt ? ` · updated ${fmtAgo(repo.updatedAt)}` : ''}
                          </>
                        }
                        selected={ghRepo === repo.fullName}
                        onSelect={() => pickSyncedGithubRepo(repo)}
                      />
                    ))}
                    {publicRepoMatches.map((repo) => (
                      <GithubRepositoryOption
                        key={`public-search:${repo.fullName}`}
                        fullName={repo.fullName}
                        icon="book-marked"
                        description={
                          <>
                            {repo.description ?? 'Public GitHub repository'}
                            {repo.updatedAt ? ` · updated ${fmtAgo(repo.updatedAt)}` : ''}
                          </>
                        }
                        selected={ghRepo === repo.fullName}
                        onSelect={() => pickPublicGithubRepo(repo)}
                      />
                    ))}
                    {ghPublicLoading && (
                      <div className="px-2 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                        Searching public repositories…
                      </div>
                    )}
                    {!canUseTypedPublicRepo &&
                      !exactInstalledRepoMatch &&
                      ghExactRepoState !== 'checking' &&
                      !ghPublicLoading &&
                      !ghReposFailed &&
                      ghRepoQuery &&
                      syncedRepoMatches.length === 0 &&
                      publicRepoMatches.length === 0 && (
                        <div className="fnohit">
                          {typedPublicRepo && ghExactRepoState === 'missing'
                            ? `No GitHub repository found for "${typedPublicRepo}"`
                            : `No repositories match "${ghQ}"`}
                        </div>
                      )}
                  </GithubRepositoryField>

                  <RepositoryAccessField
                    repositorySelected={!!picked || manualPublicRepo}
                    value={ghPushChecked ? 'write' : 'read'}
                    open={ghAccessOpen}
                    readOnly={ghPushDisabled}
                    readOnlyNote={
                      ghPushDisabled ? (
                        <span className="mt-[6px] inline-flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                          <Icon name="info" size={13} className="mt-[1px] flex-none" />
                          {manualPublicRepo
                            ? 'Public repository — read-only clone.'
                            : ghAccess?.identityRequired
                              ? 'Link your GitHub profile to verify write access.'
                              : 'You have read-only access to this repository on GitHub.'}
                        </span>
                      ) : undefined
                    }
                    onToggle={() => {
                      setGhRepoOpen(false)
                      setGhBranchOpen(false)
                      setGhAccessOpen((value) => !value)
                    }}
                    onClose={() => setGhAccessOpen(false)}
                    onChange={(value) => {
                      setGhPush(value === 'write')
                      setGhAccessOpen(false)
                    }}
                  />

                  <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px] desktop:gap-x-[14px]">
                    <WorkspaceBranchField
                      repositorySelected={!!ghRepo}
                      value={branch}
                      branches={ghBranches}
                      defaultBranch={picked?.defaultBranch}
                      open={ghBranchOpen}
                      query={ghQ}
                      onToggle={() => {
                        setGhQ('')
                        setGhRepoOpen(false)
                        setGhAccessOpen(false)
                        setGhBranchOpen((value) => !value)
                      }}
                      onClose={() => setGhBranchOpen(false)}
                      onQueryChange={setGhQ}
                      onChange={(value) => {
                        setBranch(value)
                        if (ghBranchOpen) setGhBranchOpen(false)
                      }}
                    />

                    <WorkingSubdirectoryField value={agentDir} onChange={setAgentDir} />
                    <WorktreeField checked={worktree} onChange={setWorktree} />
                  </div>
                </div>
              )}

              {wsMode === 'github' && ghEnabled === false && (
                <>
                  <div className="fld desktop:col-span-2">
                    <span className="fldlbl">GitHub repository</span>
                    <div className="inp relative min-w-0 pl-[10px]">
                      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
                        <span className="imark h-4 w-4 border-0 bg-transparent">
                          <GithubMark color="var(--text-secondary)" />
                        </span>
                        <input
                          className="mn min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] font-medium leading-normal text-(--text-primary) outline-none"
                          placeholder="acme/infra"
                          value={repo}
                          onChange={(e) => setRepo(e.target.value)}
                        />
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px] desktop:gap-x-[14px]">
                    <WorkspaceBranchField
                      repositorySelected
                      value={branch}
                      branches={null}
                      open={false}
                      query=""
                      onToggle={() => undefined}
                      onClose={() => undefined}
                      onQueryChange={() => undefined}
                      onChange={setBranch}
                    />
                    <WorkingSubdirectoryField value={agentDir} onChange={setAgentDir} />
                    <WorktreeField checked={worktree} onChange={setWorktree} />
                  </div>
                </>
              )}

              {wsMode === 'gitlab' &&
                (gl.error ? (
                  <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error) desktop:col-span-2">
                    Couldn&rsquo;t load your GitLab projects — {gl.error}
                  </div>
                ) : gl.loading ? (
                  <div className="desktop:col-span-2">
                    <LoadingState size={20} padding={16} />
                  </div>
                ) : glNoProjects ? (
                  <GitlabNoProjectsNotice
                    connected={gl.connected}
                    enabled={gl.enabled}
                    onConnect={() => void gl.connect()}
                    onSync={gl.reload}
                    syncing={gl.reloading}
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-2 desktop:gap-x-7">
                    <GitlabProjectField
                      value={glPicked?.projectPath ?? ''}
                      icon="book-marked"
                      loading={false}
                      open={glOpen}
                      query={glQ}
                      onToggle={() => {
                        setGlQ('')
                        setGlAccessOpen(false)
                        setGlOpen((value) => !value)
                      }}
                      onClose={() => setGlOpen(false)}
                      onQueryChange={setGlQ}
                      error={gl.provisionError ? `Couldn’t set up that project — ${gl.provisionError}` : undefined}
                    >
                      {glMatches.map((choice) => (
                        <GitlabProjectOption
                          key={choice.projectId}
                          choice={choice}
                          selected={glProject === choice.projectId}
                          busy={gl.provisioning === choice.projectId}
                          onSelect={() => void pickGlProject(choice)}
                        />
                      ))}
                      {glMatches.length === 0 && <div className="fnohit">No projects match &ldquo;{glQ}&rdquo;</div>}
                    </GitlabProjectField>

                    <RepositoryAccessField
                      repositorySelected={!!glProject}
                      label="Project access"
                      unselectedLabel="Select project first"
                      writeDescription="Push, open merge requests & run pipelines"
                      value={glPush ? 'write' : 'read'}
                      open={glAccessOpen}
                      onToggle={() => {
                        setGlOpen(false)
                        setGlAccessOpen((value) => !value)
                      }}
                      onClose={() => setGlAccessOpen(false)}
                      onChange={(value) => {
                        setGlPush(value === 'write')
                        setGlAccessOpen(false)
                      }}
                    />

                    <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px] desktop:gap-x-[14px]">
                      <WorkspaceBranchField
                        repositorySelected={!!glProject}
                        unselectedLabel="Pick project first"
                        defaultBranchLabel="GitLab default branch"
                        value={branch}
                        branches={null}
                        open={false}
                        query=""
                        onToggle={() => undefined}
                        onClose={() => undefined}
                        onQueryChange={() => undefined}
                        onChange={setBranch}
                      />
                      <WorkingSubdirectoryField value={agentDir} onChange={setAgentDir} />
                      <WorktreeField checked={worktree} onChange={setWorktree} />
                    </div>
                  </div>
                ))}
            </div>
            <div className="mt-2 flex items-center gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              <Icon name="corner-down-right" size={13} />
              {modeHint}
            </div>
          </section>

          <section ref={sectionRef('access')} className="mt-5 border-t border-(--border-subtle) pt-5">
            <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Access</div>
            <div className="flex flex-col gap-[14px]">
              <VisibilityField value={sharing} onChange={setSharing} label="Team visibility" />
              {/* Both directions, same cards as the Edit modal's Access section. */}
              <div className="fld">
                <span className="fldlbl">Agent visibility</span>
                <div className="flex flex-col gap-3">
                  <AgentCallVisibility
                    variant="section"
                    direction="inbound"
                    mode={callPolicy}
                    selectedIds={allowedCallers}
                    peers={agents}
                    daemons={daemons}
                    groups={memberSets}
                    target={callVisibilityTarget}
                    onChange={(nextMode, nextSelected) => {
                      setCallPolicy(nextMode)
                      setAllowedCallers(nextSelected)
                    }}
                  />
                  <AgentCallVisibility
                    variant="section"
                    direction="outbound"
                    mode={outboundPolicy}
                    selectedIds={allowedTargets}
                    peers={agents}
                    daemons={daemons}
                    groups={memberSets}
                    target={callVisibilityTarget}
                    onChange={(nextMode, nextSelected) => {
                      setOutboundPolicy(nextMode)
                      setAllowedTargets(nextSelected)
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="mt-[14px] flex items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              <Icon name="info" size={14} />
              You&apos;ll assign an integration after the agent is created.
            </div>
          </section>

          <section ref={sectionRef('memory')} className="mt-5 border-t border-(--border-subtle) pt-5">
            <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Memory</div>
            <div className="mt-[13px] flex flex-col gap-[14px]">
              <div className="fld">
                <MemoryProviderPicker value={memoryProvider} onChange={setMemoryProvider} disabled={busy} />
                <span className="mt-[6px] text-[11px] text-(--text-secondary)">
                  Managed: a memory directory we keep for the agent. Native: the runtime&apos;s own memory (Claude /
                  Codex), isolated under the agent root. External: an owner-reviewed plugin connection. Off: no
                  persistent memory.
                </span>
              </div>
              {memoryProvider === 'external' && (
                <div className="flex flex-col gap-2">
                  <ExternalMemoryBindingFields value={externalMemory} onChange={setExternalMemory} disabled={busy} />
                  {!externalMemory.connectionId ? (
                    <div className="font-sans text-[12px] font-normal leading-normal text-(--red-600)" role="alert">
                      Choose an external-memory connection before creating this agent.
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          <section ref={sectionRef('secrets')} className="mt-5 border-t border-(--border-subtle) pt-5">
            {/* A new agent is enrolled into the organization's "All agents"
                variables and secrets as part of its creation, and those win a
                same-name collision (organization-secrets-and-variables.md §3.4).
                The registry itself is owner-only, so this states the behavior
                rather than listing entries the creator may not be allowed to
                enumerate; the agent's own cards show exactly what applied as soon
                as it exists. */}
            <div className="mb-[14px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              Organization-wide variables and secrets set for all agents also apply to this one, and take precedence
              over a value with the same name here. They appear on the agent’s Variables and Secrets cards once it is
              created.
            </div>
            <EnvSecretsFields
              envRows={envRows}
              setEnvRows={setEnvRows}
              secretRows={secretRows}
              setSecretRows={setSecretRows}
            />
          </section>
        </div>
      </div>
      <div className="modalfoot">
        {err ? (
          <span className="mr-auto font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</span>
        ) : blockerHint ? (
          <button
            type="button"
            className="mr-auto inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary)"
            onClick={() => firstBlocker && goToSection(firstBlocker.id)}
          >
            <Icon name="circle-alert" size={13} color="var(--amber-500)" className="flex-none" />
            {blockerHint}
          </button>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || (memoryProvider === 'external' && !externalMemory.connectionId)} onClick={submit}>
          <Icon name="bot" size={15} />
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </>
  )
}
