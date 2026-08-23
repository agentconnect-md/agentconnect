'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  agentDaemonLabel,
  agentEffortDisplay,
  agentLabel,
  agentModelDisplay,
  agentPermissionDisplay,
  effectiveAgentStatus,
  effortField,
  enrichSessionWithAgent,
  flattenFiles,
  isGitWorkspace,
  isPoolPlacementKind,
  MOCK_MODE,
  MOCK_PREFIX,
  runtimeLabel,
  status,
  supportsModes,
  workspaceStatus,
  type IntegrationRow
} from '@/lib/data'
import {
  creatorLabel,
  fetchAgentHooks,
  fetchAgentRepos,
  fetchGithubInstallations,
  fetchHookRuns,
  fetchSessionDetail,
  sessionFromDetailDto,
  updateGithubHook,
  updateGitlabHook,
  uploadAgentIcon,
  type GithubInstallationDto,
  type GitlabProjectAccountDto,
  type HookDto,
  type HookRunDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { useModal } from '@/components/console/ModalProvider'
import { AgentEnvCard } from '@/components/console/AgentEnvCard'
import { IntegrationMarks } from '@/components/console/IntegrationMarks'
import { AgentSecretsCard } from '@/components/console/AgentSecretsCard'
import { AgentToolsCard } from '@/components/console/AgentToolsCard'
import { AgentSkillsCard } from '@/components/console/AgentSkillsCard'
import { AgentCallVisibility } from '@/components/console/AgentCallVisibility'
import { ApprovalRequestsCard } from '@/components/console/ApprovalRequestsCard'
import { IntegrationChannelList, roomGlyph, rowLabel } from '@/components/console/IntegrationChannelList'
import { RecentSessionsCard } from '@/components/console/RecentSessionsCard'
import { TriggerSelect } from '@/components/console/TriggerSelect'
import { discordBotInviteUrl } from '@/components/console/platforms/discord/invite'
import { WorkspaceCard, type WorkspaceHeaderInfo } from '@/components/console/WorkspaceCard'
import { WorkspaceFiles, workspaceReadModelKey } from '@/components/console/WorkspaceFiles'
import { WorkspaceFilesMock } from '@/components/console/WorkspaceFilesMock'
import { resolveWorkspaceRepoScope, workspaceRepoParamRewrite } from '@/components/console/WorkspaceRepoPicker'
import { WorkspaceScopePicker } from '@/components/console/WorkspaceScopePicker'
import { FileBrowserShell } from '@/components/console/FileBrowser'
import { MemoryPanel } from '@/components/console/MemoryPanel'
import { LocalSkillsList } from '@/components/console/LocalSkillsList'
import { GithubReviewSettings } from '@/components/console/GithubReviewSettings'
import { GitlabReviewSettings } from '@/components/console/GitlabReviewSettings'
import { VisibilityValue } from '@/components/console/VisibilityField'
import LarkFeishuSwitcher from '@/components/LarkFeishuSwitcher'
import { AgentMark, GithubMark, GitlabMark, LoadingState, PlatformMark } from '@/components/marks'
import { buildAgentReachabilityGraph } from '@/lib/agent-reachability'
import type { Platform } from '@/components/console/modals/AddIntegrationModal'
import { INTEGRATION_BLURB, PLATFORMS, isCoreTriggerKind } from '@/components/console/platforms/host-projections'
import {
  GL_TRIGGER_MODES,
  GL_TRIGGER_PILL,
  commentFamiliesForGitlabFamilies,
  eventsForGitlabFamilies,
  gitlabCadencePick,
  gitlabCommentFamilies,
  gitlabFamCovered,
  gitlabFamilyToggle,
  gitlabHookNeedsNormalization,
  gitlabRowFamilies,
  gitlabTriggerModeOf,
  gitlabTriggerTooltip,
  type GlFamily,
  type GlTriggerMode
} from '@/lib/gitlab-events'
import { GITLAB_PROJECT_STATE, gitlabAgentBot, gitlabProfileUrl, gitlabStateReasonText } from '@/lib/gitlab-projects'
import { useGitlabProjectBindings } from '@/lib/use-gitlab-projects'
import { AgentIconPicker } from '@/components/console/AgentIconPicker'
import { BuiltinBadge } from '@/components/console/BuiltinBadge'
import { NotFound } from '@/components/console/NotFound'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { useSessionList } from '@/lib/use-session-list'
import {
  GH_FAMILIES,
  GH_TRIGGER_MODES,
  GH_TRIGGER_PILL,
  commentFamiliesForFamilies,
  githubCommentFamilies,
  eventsForFamilies,
  famCovered,
  githubHookNeedsNormalization,
  githubTriggerTooltip,
  triggerModeOf,
  type GhFamily,
  type GhTriggerMode
} from '@/lib/github-events'
import {
  effectiveRepoAccess,
  hasChecksWritePermission,
  hasPullRequestsReadPermission,
  hasPullRequestsWritePermission,
  installationForRepo,
  repoAccessSatisfies,
  requiredRepoAccess,
  reviewPolicyLabel,
  type HookReportingMode,
  type HookReviewPolicy
} from '@/lib/github-review-settings'

type DetailTab = 'config' | 'integrations' | 'workspace' | 'memory' | 'tools'
const HOOK_REFRESH_MS = 30_000

// The tile SET is derived from the owning daemon's advertised adapters (below)
// — never hard-coded — so a tile can't promise a platform the Add-integration
// modal would swap out from under the click. webhook/github are relay/CP-backed
// triggers: always offered. Their one-liners (`INTEGRATION_BLURB`) are a host
// projection over the same axis, drift-tested beside the picker's tiles.
const HOOK_RUN_REFRESH_MS = 10_000

function FeishuRegionBadge({ integration }: { integration: Pick<IntegrationRow, 'platform' | 'region'> }) {
  if (integration.platform !== 'feishu') return null
  return (
    <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">
      {integration.region === 'lark' ? 'Lark' : 'Feishu'}
    </span>
  )
}

// The bot this agent acts as on a GitLab project. Identity lives in the integration row, the way
// every platform's row names its bot (gitlab-com-integration.md §18.1) — health only when it is off.
function GitlabBotChip({ bot }: { bot: GitlabProjectAccountDto | null }) {
  if (!bot) return null
  const handle = `bot @${bot.username}`
  const reason = gitlabStateReasonText(bot.stateReason)
  const state = GITLAB_PROJECT_STATE[bot.state]
  return (
    <span className="inline-flex min-w-0 flex-none items-center gap-[6px]">
      {bot.userId ? (
        <a
          href={gitlabProfileUrl(bot.username)}
          target="_blank"
          rel="noopener noreferrer"
          title={bot.displayName ? `Shown on GitLab as ${bot.displayName}` : 'The bot this agent acts as on GitLab'}
          className="mono min-w-0 truncate text-[11.5px] text-(--text-tertiary) hover:underline"
        >
          {handle}
        </a>
      ) : (
        <span className="mono min-w-0 truncate text-[11.5px] text-(--text-tertiary)">{handle}</span>
      )}
      {bot.state !== 'ready' && (
        <span className={`badge flex-none ${state.badge}`} {...(reason ? { title: reason } : {})}>
          {state.label}
        </span>
      )}
    </span>
  )
}

interface CodeHostReviewSettingsDraft {
  hookId: string
  kind: 'github' | 'gitlab'
  reviewPolicy: HookReviewPolicy
  reportingMode: HookReportingMode
}

export default function AgentDetailView() {
  const acpRegistry = useAcpRegistry()
  const { orgPath, activeOrg } = useOrgs()
  const { me } = useProfile()
  const { id } = useParams<{ id: string }>()
  const params = useSearchParams()
  const router = useRouter()
  const rawTab = params.get('tab')
  // Integrations is the default landing tab (first, no `?tab=`); everything else
  // is `?tab=<id>`.
  const tab: DetailTab =
    rawTab === 'config' || rawTab === 'workspace' || rawTab === 'memory' || rawTab === 'tools' ? rawTab : 'integrations'
  const {
    agents,
    getAgent,
    getSessions,
    daemons,
    daemonsLoading,
    integrations,
    agentsLoading,
    updateAgent,
    refresh,
    memberSets,
    orgSetIds
  } = useConsoleData()
  const { openPlayground } = usePlayground()
  const { openModal } = useModal()
  const {
    sessions: agentSessionRows,
    total: agentSessionTotal,
    isLoading: agentSessionsLoading
  } = useSessionList(MOCK_MODE ? null : activeOrg?.id, { agentId: id })
  const {
    sessions: workspaceSessionRows,
    nextCursor: workspaceSessionsNextCursor,
    loadingMore: workspaceSessionsLoadingMore,
    loadMore: loadMoreWorkspaceSessions,
    isLoading: workspaceSessionsLoading
  } = useSessionList(MOCK_MODE || tab !== 'workspace' ? null : activeOrg?.id, { agentId: id }, { grouped: false })
  const selectedWorktreeSessionId = params.get('worktree')?.trim() || null
  const { data: selectedWorktreeDetail } = useSWR(
    tab === 'workspace' && selectedWorktreeSessionId
      ? consoleKeys.sessionDetail(activeOrg?.id, selectedWorktreeSessionId)
      : null,
    ([, orgId, , sessionId]) => fetchSessionDetail(sessionId, orgId)
  )
  // The Recent-sessions card reads the agent-filtered page above, NOT the
  // org-wide loaded window (`getSessions`) — a busy org's newest 50 may not
  // include this agent at all, which would render a false "No sessions yet"
  // beside a nonzero header count. Mock mode has no CP to filter server-side,
  // so it keeps the demo rows. Rows are display-enriched like data-context does.
  const recentSessions = useMemo(
    () =>
      MOCK_MODE
        ? getSessions(id)
        : agentSessionRows.map((s) => enrichSessionWithAgent(s, s.agentId ? getAgent(s.agentId) : undefined)),
    [agentSessionRows, getAgent, getSessions, id]
  )
  const workspaceSessions = useMemo(
    () => workspaceSessionRows.map((s) => enrichSessionWithAgent(s, s.agentId ? getAgent(s.agentId) : undefined)),
    [getAgent, workspaceSessionRows]
  )
  const selectedWorktreeSession =
    workspaceSessions.find((session) => session.id === selectedWorktreeSessionId) ??
    (selectedWorktreeDetail?.agentId === id &&
    selectedWorktreeDetail.workspaceIsolation === 'session' &&
    !selectedWorktreeDetail.contentPurgedAt
      ? sessionFromDetailDto(selectedWorktreeDetail)
      : undefined)
  // Which webhook row has its recent-deliveries panel expanded (one at a time).
  const [hookRunsFor, setHookRunsFor] = useState<string | null>(null)
  // Hooks are agent-scoped (no org-wide list). Keep a stable resource key so a
  // create/delete revalidation retains the last good rows while it refetches.
  const hooksKey = consoleKeys.agentHooks(activeOrg?.id, id)
  const {
    data: agentHooksData,
    error: hooksError,
    isLoading: hooksLoading,
    mutate: mutateHooks
  } = useSWR(hooksKey, ([, orgId, , agentId]) => fetchAgentHooks(agentId, orgId), {
    refreshInterval: HOOK_REFRESH_MS
  })
  const agentHooks = agentHooksData ?? []
  const hooksLoadError = agentHooksData === undefined && hooksError
  // Each code host renders as ONE group with a row per watched repository or
  // project (design); webhooks stay flat rows.
  const webhookHooks = agentHooks.filter((h) => h.kind === 'webhook')
  const githubHooks = agentHooks.filter((h) => h.kind === 'github')
  const gitlabHooks = agentHooks.filter((h) => h.kind === 'gitlab')
  // The project bindings name each project's member bots, so a row can show the one this agent acts as.
  const gitlabBindings = useGitlabProjectBindings(gitlabHooks.length > 0)
  const githubInstallationsKey =
    activeOrg && githubHooks.length > 0 ? (['github-review-installations', activeOrg.id] as const) : null
  const { data: githubInstallationsData } = useSWR<GithubInstallationDto[]>(githubInstallationsKey, () =>
    fetchGithubInstallations().then((result) => result.installations)
  )
  const githubInstallations = githubInstallationsData ?? []

  // Authorization provenance for the unauthorized-watch badge (multi-repo
  // design §web 3): numeric repo ids first, names only for rolling legacy rows.
  // GitHub-App workspaces have an implicit workspace grant. Scratch and manual
  // GitHub workspaces rely on explicit grants (manual remains limited to its
  // own repo).
  const wsForRepos = getAgent(id)?.workspace
  const reposKey = wsForRepos ? consoleKeys.agentRepos(activeOrg?.id, id) : null
  const { data: agentReposData } = useSWR(reposKey, ([, orgId, , agentId]) => fetchAgentRepos(agentId, orgId))
  // Which ROOT the Workspace tab browses, beside `?worktree=` which chooses the checkout within it.
  // Pool placements hold their grants as authorization only — no secondary root is materialized
  // there yet — so the menu offers nothing to switch to and the browser stays on the workspace.
  const poolPlacedForRepos = isPoolPlacementKind(getAgent(id)?.placementKind, getAgent(id)?.setId, orgSetIds)
  const workspaceRepoOptions = poolPlacedForRepos ? [] : (agentReposData ?? [])
  const selectedRepo = resolveWorkspaceRepoScope(params.get('repo'), poolPlacedForRepos ? [] : agentReposData)
  const selectRepoScope = useCallback(
    (repo: string | null) => {
      const next = new URLSearchParams(params)
      if (repo) next.set('repo', repo)
      else next.delete('repo')
      router.replace(`${orgPath(`/agents/${id}`)}?${next.toString()}`, { scroll: false })
    },
    [id, orgPath, params, router]
  )
  // ...and once the grants are definitive, make the URL say which root the browser is actually
  // reading, so a hand-written or revoked link stops disagreeing with the picker beside it.
  const repoParamRewrite = workspaceRepoParamRewrite(
    params.get('repo'),
    selectedRepo,
    poolPlacedForRepos ? [] : agentReposData
  )
  useEffect(() => {
    if (repoParamRewrite !== undefined) selectRepoScope(repoParamRewrite)
  }, [repoParamRewrite, selectRepoScope])
  // Grandfathered out-of-set hooks keep firing; only the gh write-back is
  // credential-less — badge them once the grant list has actually loaded.
  const watchUnauthorized = (h: HookDto): boolean =>
    wsForRepos !== undefined &&
    agentReposData !== undefined &&
    effectiveRepoAccess({
      repoId: h.repoId,
      repoFullName: h.repoFullName,
      workspace: wsForRepos ?? { mode: 'scratch' },
      authorizations: agentReposData
    }) === 'none'

  // The group-card identity line: the repos' common owner when they share one,
  // plain "GitHub" otherwise (subscriptions can span accounts).
  const githubOwner = useMemo(() => {
    const owners = [...new Set(githubHooks.map((h) => (h.repoFullName ?? h.name).split('/')[0]!))]
    return owners.length === 1 ? owners[0]! : 'GitHub'
  }, [githubHooks])

  const [reviewSettingsDraft, setReviewSettingsDraft] = useState<CodeHostReviewSettingsDraft | null>(null)
  const [reviewSettingsSaving, setReviewSettingsSaving] = useState(false)
  const [reviewSettingsError, setReviewSettingsError] = useState<string | null>(null)
  const isGitlabReviewDraft = reviewSettingsDraft?.kind === 'gitlab'
  const reviewSettingsHook = reviewSettingsDraft
    ? (isGitlabReviewDraft ? gitlabHooks : githubHooks).find((hook) => hook.id === reviewSettingsDraft.hookId)
    : undefined
  const reviewSettingsRepoAccess = effectiveRepoAccess({
    repoId: reviewSettingsHook?.repoId,
    repoFullName: reviewSettingsHook?.repoFullName,
    workspace: wsForRepos ?? { mode: 'scratch' },
    authorizations: agentReposData ?? []
  })
  const reviewSettingsInstallation = installationForRepo(reviewSettingsHook?.repoFullName, githubInstallations)
  const reviewSettingsNeededAccess = reviewSettingsDraft ? requiredRepoAccess(reviewSettingsDraft) : 'none'
  // Only the github surface has a config-time blocker; GitLab's writer is the
  // project bot, which carries no per-agent access tier to satisfy first.
  const reviewSettingsBlocked =
    !isGitlabReviewDraft &&
    (!repoAccessSatisfies(reviewSettingsRepoAccess, reviewSettingsNeededAccess) ||
      (reviewSettingsDraft?.reviewPolicy !== undefined &&
        reviewSettingsDraft.reviewPolicy !== 'off' &&
        !hasPullRequestsWritePermission(reviewSettingsInstallation)) ||
      (reviewSettingsDraft?.reportingMode === 'check' &&
        (!hasChecksWritePermission(reviewSettingsInstallation) ||
          !hasPullRequestsReadPermission(reviewSettingsInstallation))))

  const openReviewSettings = (hook: HookDto) => {
    setReviewSettingsError(null)
    setReviewSettingsDraft({
      hookId: hook.id,
      kind: hook.kind === 'gitlab' ? 'gitlab' : 'github',
      reviewPolicy: hook.reviewPolicy,
      reportingMode: hook.reportingMode
    })
  }

  const closeReviewSettings = () => {
    if (reviewSettingsSaving) return
    setReviewSettingsDraft(null)
    setReviewSettingsError(null)
  }

  const saveReviewSettings = async () => {
    if (reviewSettingsSaving || reviewSettingsBlocked || !reviewSettingsDraft || !reviewSettingsHook?.agentId) {
      return
    }
    const agentId = reviewSettingsHook.agentId
    const hook = reviewSettingsHook
    const { reviewPolicy, reportingMode } = reviewSettingsDraft
    const common = { agentId, name: hook.name, enabled: hook.enabled, events: hook.events }
    // Each host's PUT re-sends its own whole block; only the two effect axes move.
    const save =
      hook.kind === 'gitlab'
        ? hook.repoId
          ? () =>
              updateGitlabHook(hook.id, {
                ...common,
                projectId: hook.repoId!,
                commentFamilies: gitlabCommentFamilies(hook.commentFamilies),
                mentionOnly: hook.mentionOnly,
                reviewPolicy,
                reportingMode
              })
          : null
        : hook.repoFullName
          ? () =>
              updateGithubHook(hook.id, {
                ...common,
                repoFullName: hook.repoFullName!,
                commentFamilies: githubCommentFamilies(hook.commentFamilies),
                labelFilter: hook.labelFilter,
                mentionOnly: hook.mentionOnly,
                reviewPolicy,
                reportingMode,
                gateMode: 'informational'
              })
          : null
    if (!save) return
    setReviewSettingsSaving(true)
    setReviewSettingsError(null)
    try {
      const updated = await save()
      void mutateHooks((rows) => rows?.map((row) => (row.id === hook.id ? updated : row)), {
        revalidate: false
      })
      setReviewSettingsDraft(null)
    } catch (error) {
      setReviewSettingsError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewSettingsSaving(false)
    }
  }

  // Edit one github subscription in place (PUT re-sends the whole block); the
  // SWR row is patched — no full revalidation. Families and the
  // create/update/@-mention trigger both ride the stored event patterns.
  const [hookBusy, setHookBusy] = useState<string | null>(null)
  const saveHookEvents = async (h: HookDto, fams: GhFamily[], mode: GhTriggerMode) => {
    if (hookBusy || !h.agentId || !h.repoFullName) return
    setHookBusy(h.id)
    try {
      const updated = await updateGithubHook(h.id, {
        agentId: h.agentId,
        name: h.name,
        enabled: h.enabled,
        repoFullName: h.repoFullName,
        events: eventsForFamilies(fams, mode),
        commentFamilies: commentFamiliesForFamilies(fams),
        labelFilter: h.labelFilter,
        mentionOnly: mode === 'mention',
        reviewPolicy: h.reviewPolicy,
        reportingMode: h.reportingMode,
        gateMode: 'informational'
      })
      void mutateHooks((rows) => rows?.map((r) => (r.id === h.id ? updated : r)), { revalidate: false })
    } catch {
      /* controls stay as they were — the next refresh interval reconciles */
    } finally {
      setHookBusy(null)
    }
  }
  // The GitLab counterpart of saveHookEvents — same two axes, no review knobs
  // yet (the M6 slice adds those, and the row must not imply them).
  const saveGitlabHookEvents = async (h: HookDto, families: GlFamily[], mode: GlTriggerMode) => {
    if (hookBusy || !h.agentId || !h.repoId) return
    setHookBusy(h.id)
    try {
      const updated = await updateGitlabHook(h.id, {
        agentId: h.agentId,
        name: h.name,
        enabled: h.enabled,
        projectId: h.repoId,
        events: eventsForGitlabFamilies(families, mode),
        commentFamilies: commentFamiliesForGitlabFamilies(families, mode),
        mentionOnly: mode === 'mention',
        reviewPolicy: h.reviewPolicy,
        reportingMode: h.reportingMode
      })
      void mutateHooks((rows) => rows?.map((r) => (r.id === h.id ? updated : r)), { revalidate: false })
    } catch {
      /* controls stay as they were — the next refresh interval reconciles */
    } finally {
      setHookBusy(null)
    }
  }
  // Pure helpers decide both edits: the toggle refuses to drop the last family, and the cadence pick refuses a no-op write, which is what leaves an inexpressible stored rule untouched.
  const toggleGitlabHookFam = async (h: HookDto, fam: GlFamily) => {
    const edit = gitlabFamilyToggle(h, fam)
    if (edit) await saveGitlabHookEvents(h, edit.families, edit.mode)
  }
  const setGitlabHookCadence = async (h: HookDto, mode: GlTriggerMode) => {
    const edit = gitlabCadencePick(h, mode)
    if (edit) await saveGitlabHookEvents(h, edit.families, edit.mode)
  }
  const toggleHookFam = async (h: HookDto, fam: GhFamily) => {
    const fams = GH_FAMILIES.map((f) => f.fam).filter((f) =>
      f === fam ? !famCovered(h.events, f) : famCovered(h.events, f)
    )
    if (fams.length === 0) return // at least one family must stay subscribed
    const mode = triggerModeOf(h)
    await saveHookEvents(h, fams, mode)
  }
  const setHookCadence = async (h: HookDto, mode: GhTriggerMode) => {
    if (mode === triggerModeOf(h) && !githubHookNeedsNormalization(h)) return
    const fams = GH_FAMILIES.map((f) => f.fam).filter((f) => famCovered(h.events, f))
    await saveHookEvents(h, fams, mode)
  }
  // One open-state drives both agent-actions surfaces: the desktop kebab dropdown
  // and the mobile bottom sheet (only one is ever visible — CSS gates them).
  const [actionsOpen, setActionsOpen] = useState(false)
  const [actionSaving, setActionSaving] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const openActions = () => {
    setActionErr(null)
    setActionsOpen(true)
  }
  const toggleActions = () => {
    setActionErr(null)
    setActionsOpen((v) => !v)
  }

  // Effective agent-call reachability over the whole roster: an A→B edge exists
  // only when A's outbound AND B's inbound both permit it. The read-only Access
  // summary shows these intersected sets (not this agent's one-sided policy), so
  // it never lists a peer as callable when the peer's own policy blocks the edge.
  const agentReach = useMemo(() => buildAgentReachabilityGraph(agents), [agents])

  const da = getAgent(id)
  // Unknown id (a stale deep link, or a demo agent that's hidden outside mock mode) —
  // show a not-found notice rather than crash on the `da.*` reads below. While the
  // agents pull is still in flight, though, it's not "not found" yet — spin instead.
  if (!da) {
    return (
      <div className="wrap">
        {agentsLoading ? (
          <LoadingState fill />
        ) : (
          <NotFound
            icon="bot-off"
            kind="AGENT"
            title="Agent not found"
            pre="No agent "
            chip={id}
            post=" in this organization. It may have been deleted or renamed."
            actionLabel="Back to agents"
            actionHref={orgPath('/agents')}
            searchLabel="Search agents"
          />
        )}
      </div>
    )
  }
  // The owning daemon (if placed in the live fleet). Gates the agent's "online" —
  // an agent can't be online when its daemon is offline — and names the daemon.
  const owningDaemon = daemons.find((d) => d.daemonId === da.daemon)
  const runtimeMeta = acpRuntime(acpRegistry, da.runtime)
  // Config rows read the daemon-advertised runtime-model catalog so a placed
  // agent shows the SAME effective model / effort / permission the Edit modal
  // does (else a blank model reads "Default" here but its resolved default in the
  // editor). Falls back to the static labels when the daemon reports no catalog.
  const modelText = agentModelDisplay(owningDaemon, da.runtime, da.model)
  const ds = status(effectiveAgentStatus(da, owningDaemon))
  const ws = da.workspace
  // Demo agents have no daemon to read git state from, so the workspace card's
  // live half comes straight from their static mock workspace instead.
  const mockWorkspaceHeader: WorkspaceHeaderInfo = isGitWorkspace(ws)
    ? {
        status: workspaceStatus(ws),
        ...(ws.commitMsg ? { commit: { sha: ws.commit, time: ws.commitTime, title: ws.commitMsg } } : {}),
        repoUrl: ws.repoUrl ?? `https://${ws.mode === 'gitlab' ? 'gitlab.com' : 'github.com'}/${ws.repo}`,
        remoteLabel: ws.mode === 'gitlab' ? 'GitLab' : 'GitHub'
      }
    : { status: workspaceStatus(ws) }
  // Counts walk the whole mock tree (files are nested under folder children).
  const allFiles = flattenFiles(ws.files)
  const changedFiles = allFiles.filter((f) => f.tag).length
  const filesSummary = allFiles.length
    ? `${allFiles.length} items${changedFiles ? ` · ${changedFiles} changed` : ''}`
    : 'empty'
  // Live integrations owned by THIS agent (the CP-managed ones; demo rows carry no
  // agentId so they never leak onto a real agent's page).
  const agentInts = integrations.filter((i) => i.agentId === da.id)
  // Peer agents for the read-only Access card's agent-call summary (self excluded).
  const agentPeers = agents.filter((peer) => peer.id !== da.id)
  // The empty Integrations tab renders the SAME platform grid as the
  // Add-integration modal — same list, order, tile size and disabled treatment.
  // A bot platform the owning daemon doesn't advertise is greyed out rather than
  // clickable (the modal applies this identical gate), so a tile can never open a
  // pane other than the one it names. webhook/github are relay/CP-backed
  // triggers: always available.
  // An UNPLACED agent keeps bot platforms selectable — the platform "Add to
  // Slack" card / the funnel mint CP-side rows whose delivery converges at
  // placement; the modal + server gate what genuinely needs a daemon.
  const integrationPlatformAvailable = (key: Platform) =>
    isCoreTriggerKind(key) || daemonsLoading || !owningDaemon || owningDaemon.caps.platforms.includes(key)
  // Effective (intersection) peer sets for the read-only Access summary.
  const inboundEffectiveIds = agentReach.incomingByAgentId.get(da.id) ?? []
  const outboundEffectiveIds = agentReach.outgoingByAgentId.get(da.id) ?? []
  // Webhook triggers share the Integrations card (the Add modal offers both);
  // `agentHooks` is fetched per-agent above.
  const hasInt = agentInts.length > 0 || agentHooks.length > 0
  // Match the list's enabled, distinct hook-kind summary. Use the agent snapshot
  // only until this page's live hook query resolves; hook mutations revalidate
  // that query immediately, keeping the header and Integrations card in sync.
  const integrationHookKinds =
    agentHooksData === undefined
      ? (da.hookKinds ?? [])
      : [...new Set(agentHooks.filter((hook) => hook.enabled).map((hook) => hook.kind))]
  const hasIntegrationMarks = agentInts.length > 0 || integrationHookKinds.length > 0
  const sessionCount = MOCK_MODE ? getSessions(da.id).length : agentSessionTotal
  // Icon upload is available only when the object store is configured (org flag) — the
  // picker hides Upload otherwise. On success the CP has persisted the new icon; refetch.
  const onUploadIcon = activeOrg?.iconUploadEnabled
    ? async (blob: Blob) => {
        await uploadAgentIcon(da.id, blob)
        refresh()
      }
    : undefined
  const daemonLabel = agentDaemonLabel(da, daemons, memberSets)
  // Append region only when the Agent projection has a real one.
  const daemonLine = da.region && da.region !== '—' ? `${daemonLabel} · ${da.region}` : daemonLabel
  // Only a daemon in the viewer's fleet has a working detail route.
  const daemonHref = orgPath(`/daemons/${da.daemon}`)
  const outputModeLabel =
    da.outputMode && da.outputMode !== '—' ? da.outputMode[0]!.toUpperCase() + da.outputMode.slice(1) : da.outputMode

  const onPlayground = () => {
    const pid = openPlayground(da)
    router.push(orgPath(`/sessions/${pid}`))
  }
  const pauseActionLabel = da.pause ? 'Unpause' : 'Pause'
  const pauseActionIcon = da.pause ? 'play' : 'pause'
  const togglePause = async () => {
    if (actionSaving) return
    setActionSaving(true)
    setActionErr(null)
    try {
      await updateAgent(da.id, { pause: !da.pause })
      setActionsOpen(false)
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActionSaving(false)
    }
  }

  const tabCls = (t: DetailTab) => (tab === t ? 'tab on' : 'tab')
  const tabHref = (t: DetailTab) => orgPath(t === 'integrations' ? `/agents/${da.id}` : `/agents/${da.id}?tab=${t}`)
  const botSettingsHref = (botId?: string) =>
    orgPath(botId ? `/integrations?bot=${encodeURIComponent(botId)}` : '/integrations')

  // ── Single responsive tree. Base classes are the mobile (≤768px) push-detail
  // body (the Shell provides the top push bar there); `desktop:` variants restore
  // the ≥769px layout. Fragments whose anatomy genuinely differs between widths
  // are dual-rendered and CSS-gated (`desktop:hidden` / `hidden desktop:*`).
  return (
    <div className="wrap flex max-w-[1240px] flex-col desktop:block">
      {/* Header identity — dual-rendered: the desktop header (name + displayName mono
          sub-label, integration chip / "No integration" warning, sessions link,
          Playground button + kebab dropdown) and the mobile compact identity block +
          full-width action row differ in anatomy, not just styling. */}
      <div className="mb-[18px] hidden items-start gap-4 desktop:flex">
        <AgentIconPicker
          value={da.icon ?? null}
          runtime={da.runtime}
          onCommit={(icon) => void updateAgent(da.id, { icon }).catch(() => {})}
          onUploadImage={onUploadIcon}
          disabled={!!da.builtin}
          size={52}
          radiusClass="rounded-[12px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px]">
            <h1 className="ptitle">{agentLabel(da)}</h1>
            {da.displayName && (
              <span className="mono font-mono text-[12px] font-medium leading-normal text-(--text-tertiary)">
                {da.name}
              </span>
            )}
            <BuiltinBadge show={!!da.builtin} />
            <span className="badge" style={{ background: ds.bg, color: ds.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: ds.dot }} />
              {ds.label}
            </span>
          </div>
          <div className="mt-[9px] flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="cpu" size={14} color="var(--text-tertiary)" />
              {modelText}
            </span>
            {owningDaemon ? (
              <Link className="lnk font-sans text-[12.5px] font-medium leading-normal" href={daemonHref}>
                <Icon name="server" size={14} color="var(--text-tertiary)" />
                {daemonLine}
              </Link>
            ) : da.daemon === '—' ? (
              // Unplaced (the preset before placement): an Add CTA instead of the
              // dash (preset-agents.md §3.4). With no daemon in the org yet it
              // launches the join-command dialog; otherwise the edit modal carries
              // the daemon picker + the deferred runtime choice.
              <button
                type="button"
                className="addchip border-0"
                onClick={() =>
                  daemons.length === 0
                    ? openModal('daemon', da, { focusSection: 'runtime' })
                    : openModal('editAgent', da, { focusSection: 'runtime' })
                }
              >
                <Icon name="plus" size={13} />
                Add daemon
              </button>
            ) : (
              <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                <Icon name="server" size={14} color="var(--text-tertiary)" />
                {daemonLine}
              </span>
            )}
            {hasIntegrationMarks ? (
              <IntegrationMarks integrations={agentInts} hookKinds={integrationHookKinds} />
            ) : (
              <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-semibold leading-normal text-(--amber-500)">
                <Icon name="triangle-alert" size={14} />
                No integration
              </span>
            )}
            {(hasIntegrationMarks || sessionCount > 0) && (
              <Link
                className="lnk font-sans text-[12.5px] font-medium leading-normal"
                href={orgPath(`/sessions?agent=${da.id}`)}
              >
                <Icon name="messages-square" size={14} />
                {sessionCount} sessions
                <Icon name="arrow-right" size={13} />
              </Link>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={onPlayground}>
            <Icon name="message-square-text" size={15} />
            Playground
          </Button>
          <div className="relative">
            <button className="iconbtn" onClick={toggleActions} title="Agent actions">
              <Icon name="ellipsis" size={16} />
            </button>
            {actionsOpen && (
              <>
                <div onClick={() => setActionsOpen(false)} className="fixed inset-0 z-[45]" />
                <div className="dmenu" onClick={(e) => e.stopPropagation()}>
                  {/* Edit lives on the General card now, not here. */}
                  <button className="dmi" onClick={() => void togglePause()} disabled={actionSaving}>
                    <Icon name={pauseActionIcon} size={15} />
                    {actionSaving ? 'Saving...' : pauseActionLabel}
                  </button>
                  {actionErr && (
                    <div className="px-[14px] py-[8px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
                      {actionErr}
                    </div>
                  )}
                  {/* Built-in preset agents are permanent — no Delete (the CP refuses it too). */}
                  {!da.builtin && (
                    <>
                      <div className="dmsep" />
                      <button
                        className="dmi danger"
                        onClick={() => {
                          setActionsOpen(false)
                          openModal('deleteAgent', da)
                        }}
                      >
                        <Icon name="trash-2" size={15} />
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Mobile identity block */}
      <div className="flex gap-3 bg-(--surface-card) p-4 desktop:hidden">
        <AgentIconPicker
          value={da.icon ?? null}
          runtime={da.runtime}
          onCommit={(icon) => void updateAgent(da.id, { icon }).catch(() => {})}
          onUploadImage={onUploadIcon}
          disabled={!!da.builtin}
          size={48}
          radiusClass="rounded-[12px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-sans text-[20px] font-semibold leading-normal tracking-[-.02em]">
              {agentLabel(da)}
            </span>
            <BuiltinBadge show={!!da.builtin} />
            <span
              className="inline-flex flex-none items-center gap-[5px] rounded-full px-[10px] py-[3px] font-sans text-[12px] font-semibold leading-normal"
              style={{ background: ds.bg, color: ds.text }}
            >
              <span className="h-[6px] w-[6px] rounded-full" style={{ background: ds.dot }} />
              {ds.label}
            </span>
            <button className="iconbtn ml-auto flex-none" onClick={openActions} title="Agent actions">
              <Icon name="ellipsis" size={18} />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-[14px] gap-y-[6px]">
            <span className="inline-flex items-center gap-[6px] font-mono text-[12px] font-medium leading-normal whitespace-nowrap text-(--text-secondary)">
              <Icon name="cpu" size={14} color="var(--text-tertiary)" className="flex-none" />
              {modelText}
            </span>
            <span className="inline-flex items-center gap-[6px] font-mono text-[12px] font-medium leading-normal whitespace-nowrap text-(--text-secondary)">
              <Icon name="server" size={14} color="var(--text-tertiary)" />
              {daemonLine}
            </span>
          </div>
        </div>
      </div>

      {/* Mobile action row */}
      <div className="flex gap-2 bg-(--surface-card) px-4 pt-0 pb-4 desktop:hidden">
        <button
          onClick={onPlayground}
          className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border-0 bg-(--brand) font-sans text-[14px] font-semibold leading-normal text-white"
        >
          <Icon name="message-square-text" size={18} />
          Playground
        </button>
        <button
          onClick={openActions}
          title={pauseActionLabel + ' agent'}
          className="flex h-11 w-11 flex-none cursor-pointer items-center justify-center rounded-md border border-(--border-default) bg-(--surface-card) text-(--text-secondary)"
        >
          <Icon name={pauseActionIcon} size={18} />
        </button>
      </div>

      {/* Tab strip — single-rendered: `.tab`/`.tab.on` style the desktop tabs,
          `max-desktop:` utilities restore the mobile scrollable strip (incl. hiding
          the .tab.on::after underline in favour of the mobile border-bottom). */}
      <div className="flex gap-6 overflow-x-auto border-b border-(--border-default) bg-(--surface-card) px-4 [-webkit-overflow-scrolling:touch] desktop:mb-[18px] desktop:gap-0 desktop:overflow-x-visible desktop:bg-transparent desktop:px-0">
        {(
          [
            ['integrations', 'Integrations'],
            ['config', 'Configuration'],
            ['workspace', 'Workspace'],
            ['memory', 'Memory'],
            ['tools', 'Tools & Skills']
          ] as [DetailTab, string][]
        ).map(([t, label]) => {
          const on = tab === t
          return (
            <Link
              key={t}
              href={tabHref(t)}
              className={`${tabCls(t)} whitespace-nowrap no-underline max-desktop:-mb-px max-desktop:mr-0 max-desktop:flex-none max-desktop:border-solid max-desktop:border-b-2 max-desktop:px-0 max-desktop:pt-3 max-desktop:pb-[10px] max-desktop:text-[14px] ${
                on
                  ? 'max-desktop:border-b-(--brand) max-desktop:after:hidden'
                  : 'max-desktop:border-b-transparent max-desktop:text-(--text-tertiary)'
              }`}
            >
              {label}
            </Link>
          )
        })}
      </div>

      {/* Config tab — one grid: mobile stacks Basics → Runtime → Description →
          Access → Variables → Secrets (flex order). Desktop puts Basics + Runtime
          in the 340px left column and the rest in the right column (the wrapper is
          display:contents on mobile so all the cards sit in the same flex column).
          Workspace is NOT here — it moved into the Workspace tab, next to the
          files it configures. */}
      {tab === 'config' && (
        <div className="flex flex-col gap-4 p-4 desktop:grid desktop:grid-cols-[340px_1fr] desktop:items-start desktop:gap-[18px] desktop:p-0">
          <div className="contents desktop:flex desktop:min-w-0 desktop:flex-col desktop:gap-[18px]">
            {/* Basics card — identity + placement facts (Name, Daemon, Runtime,
                Model, Created, Modified). Edit opens the sectioned Edit-agent modal
                at its Basics anchor. */}
            <div className="card order-1 overflow-hidden max-desktop:rounded-lg">
              <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
                <span className="font-sans text-[14px] font-semibold leading-normal">Basics</span>
                {!da.name.startsWith(MOCK_PREFIX) && (
                  <>
                    <button
                      onClick={() => openModal('editAgent', da, { focusSection: 'basics' })}
                      className="flex h-7 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 py-0 font-sans text-[14px] font-semibold leading-normal text-(--brand-soft-text) desktop:hidden"
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </button>
                    <Button
                      variant="secondary"
                      size="xs"
                      className="hidden desktop:inline-flex"
                      onClick={() => openModal('editAgent', da, { focusSection: 'basics' })}
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </Button>
                  </>
                )}
              </div>
              <div className="desktop:py-[6px]">
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Name
                  </span>
                  <span className="mono text-[12px] font-medium leading-normal text-(--text-primary) desktop:text-[12.5px] desktop:font-normal">
                    {da.name}
                  </span>
                </div>
                {/* Daemon row — dual-rendered: mobile is a tappable drill-in button
                    with a chevron; desktop an inline Link (or plain mono value). */}
                {owningDaemon ? (
                  <button
                    onClick={() => router.push(daemonHref)}
                    className="box-border flex w-full cursor-pointer items-center justify-between gap-4 border-0 border-b border-(--border-subtle) bg-(--surface-card) px-4 py-3 text-left desktop:hidden"
                  >
                    <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">
                      Runs on
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-[6px]">
                      <span className="truncate font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
                        {daemonLine}
                      </span>
                      <Icon name="chevron-right" size={14} color="var(--text-tertiary)" />
                    </span>
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3 desktop:hidden">
                    <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">
                      Runs on
                    </span>
                    <span className="font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
                      {daemonLine}
                    </span>
                  </div>
                )}
                <div className="hidden items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3 desktop:flex">
                  <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                    Runs on
                  </span>
                  {owningDaemon ? (
                    <Link className="lnk font-mono text-[12.5px] font-medium leading-normal" href={daemonHref}>
                      {daemonLine}
                    </Link>
                  ) : da.daemon === '—' ? (
                    <button
                      type="button"
                      className="addchip border-0"
                      onClick={() =>
                        daemons.length === 0
                          ? openModal('daemon', da, { focusSection: 'runtime' })
                          : openModal('editAgent', da, { focusSection: 'runtime' })
                      }
                    >
                      <Icon name="plus" size={13} />
                      Add
                    </button>
                  ) : (
                    <span className="mono text-[12.5px]">{daemonLine}</span>
                  )}
                </div>
                {owningDaemon?.status === 'offline' && (
                  <div className="flex items-start gap-[9px] border-b border-(--amber-500) bg-(--status-paused-soft) px-4 py-3">
                    <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[1px] flex-none" />
                    <div className="min-w-0 flex-1">
                      <div className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
                        Safe move unavailable
                      </div>
                      <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-secondary)">
                        Bring <span className="font-semibold text-(--text-primary)">{owningDaemon.name}</span> online
                        before moving this agent safely.
                      </div>
                      {!da.name.startsWith(MOCK_PREFIX) && da.canEdit && (
                        <button
                          type="button"
                          className="mt-[6px] border-0 bg-transparent p-0 font-sans text-[11.5px] font-semibold leading-normal text-(--brand-soft-text) hover:underline"
                          onClick={() => openModal('editAgent', da, { focusSection: 'basics' })}
                        >
                          Open recovery options
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Runtime
                  </span>
                  <span className="inline-flex items-center gap-[7px] font-sans text-[12px] font-medium leading-normal desktop:text-[12.5px]">
                    {/* Mobile shows the bare mark; desktop the bordered imark chip. */}
                    <span className="inline-flex h-4 w-4 desktop:hidden">
                      <AgentMark model={da.runtime} />
                    </span>
                    <span className="imark hidden h-6 w-6 desktop:flex">
                      <AgentMark model={da.runtime} />
                    </span>
                    {runtimeLabel(da.runtime, runtimeMeta?.name)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Model
                  </span>
                  <span className="mono text-[12px] font-medium leading-normal text-(--text-primary) desktop:text-[12.5px] desktop:leading-[1.5] desktop:font-normal">
                    {modelText}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Created
                  </span>
                  <span className="font-sans text-[14px] font-medium leading-normal desktop:text-[12.5px]">
                    {creatorLabel(da.createdBy, me)}{' '}
                    <span className="mono text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[12.5px]">
                      · {da.createdAt}
                    </span>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Modified
                  </span>
                  <span className="font-sans text-[14px] font-medium leading-normal desktop:text-[12.5px]">
                    {creatorLabel(da.lastModifiedBy, me)}{' '}
                    <span className="mono text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[12.5px]">
                      · {da.lastModifiedAt}
                    </span>
                  </span>
                </div>
              </div>
            </div>
            {/* Runtime behavior card — how the agent runs (permission / effort /
                fast mode / output / footer / introduce / pause). Edit opens the
                Edit-agent modal at its Runtime behavior anchor. */}
            <div className="card order-2 overflow-hidden max-desktop:rounded-lg">
              <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
                <span className="font-sans text-[14px] font-semibold leading-normal">Runtime</span>
                {!da.name.startsWith(MOCK_PREFIX) && (
                  <>
                    <button
                      onClick={() => openModal('editAgent', da, { focusSection: 'runtime' })}
                      className="flex h-7 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 py-0 font-sans text-[14px] font-semibold leading-normal text-(--brand-soft-text) desktop:hidden"
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </button>
                    <Button
                      variant="secondary"
                      size="xs"
                      className="hidden desktop:inline-flex"
                      onClick={() => openModal('editAgent', da, { focusSection: 'runtime' })}
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </Button>
                  </>
                )}
              </div>
              <div className="desktop:py-[6px]">
                {supportsModes(da.runtime) && (
                  <>
                    <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                      <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                        Permission mode
                      </span>
                      <span className="badge bg-(--surface-active) text-(--text-secondary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]">
                        {agentPermissionDisplay(owningDaemon, da.runtime, da.permissionMode, da.approvalsReviewer)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                      <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                        {effortField(da.runtime).label}
                      </span>
                      <span className="badge bg-(--surface-active) text-(--text-secondary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]">
                        {agentEffortDisplay(owningDaemon, da.runtime, da.model, da.reasoning)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                      <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                        Fast mode
                      </span>
                      <span
                        className={
                          da.fastMode
                            ? 'badge bg-(--brand-soft) text-(--brand-soft-text) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                            : 'badge bg-(--surface-active) text-(--text-tertiary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                        }
                      >
                        {da.fastMode ? 'On' : 'Off'}
                      </span>
                    </div>
                  </>
                )}
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Change runtime in chat
                  </span>
                  <span
                    className={
                      da.allowRuntimeChangesInChat
                        ? 'badge bg-(--brand-soft) text-(--brand-soft-text) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                        : 'badge bg-(--surface-active) text-(--text-tertiary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                    }
                  >
                    {da.allowRuntimeChangesInChat ? 'Allowed' : 'Off'}
                  </span>
                </div>
                {/* Pause is a transient runtime action, not a config default — only
                    surface it when the agent is actually paused (hide the "Off" noise). */}
                {da.pause && (
                  <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                    <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                      Pause
                    </span>
                    <span className="badge bg-(--status-paused-soft) text-(--amber-500) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]">
                      Paused
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Output mode
                  </span>
                  <span className="badge bg-(--surface-active) text-(--text-secondary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]">
                    {outputModeLabel}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Show footer
                  </span>
                  <span
                    className={
                      da.showFooter
                        ? 'badge bg-(--brand-soft) text-(--brand-soft-text) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                        : 'badge bg-(--surface-active) text-(--text-tertiary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                    }
                  >
                    {da.showFooter ? 'On' : 'Off'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Show status bar
                  </span>
                  <span
                    className={
                      da.showStatusBar
                        ? 'badge bg-(--brand-soft) text-(--brand-soft-text) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                        : 'badge bg-(--surface-active) text-(--text-tertiary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                    }
                  >
                    {da.showStatusBar ? 'On' : 'Off'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Introduce on join
                  </span>
                  <span
                    className={
                      da.introduceOnJoin
                        ? 'badge bg-(--brand-soft) text-(--brand-soft-text) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                        : 'badge bg-(--surface-active) text-(--text-tertiary) max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]'
                    }
                  >
                    {da.introduceOnJoin ? 'On' : 'Off'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="contents desktop:flex desktop:min-w-0 desktop:flex-col desktop:gap-[18px]">
            {/* Description card (design): its own card at the top of the right column,
                and the ONE group edited on its own (EditDescriptionModal) rather than
                through the sectioned Edit-agent modal. Mobile order: Basics 1 → Runtime
                behavior 2 → Description 3 → Access 4 → Variables 5 → Secrets 6. */}
            <div className="card order-3 overflow-hidden max-desktop:rounded-lg">
              <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
                <span className="font-sans text-[14px] font-semibold leading-normal">Description</span>
                {!da.name.startsWith(MOCK_PREFIX) && (
                  <>
                    <button
                      onClick={() => openModal('editAgentDesc', da)}
                      className="flex h-7 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 py-0 font-sans text-[14px] font-semibold leading-normal text-(--brand-soft-text) desktop:hidden"
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </button>
                    <Button
                      variant="secondary"
                      size="xs"
                      className="hidden desktop:inline-flex"
                      onClick={() => openModal('editAgentDesc', da)}
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </Button>
                  </>
                )}
              </div>
              <div className="min-h-[39px] whitespace-pre-wrap px-4 py-3 font-sans text-[14px] font-normal leading-[1.5] text-(--text-secondary) desktop:text-[13px]">
                {da.desc}
              </div>
            </div>

            {/* Access card (design) — team visibility + agent-call visibility, read
                only. Edit opens the sectioned Edit-agent modal at its Access anchor. */}
            <div className="card order-4 overflow-hidden max-desktop:rounded-lg">
              <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
                <span className="font-sans text-[14px] font-semibold leading-normal">Access</span>
                {!da.name.startsWith(MOCK_PREFIX) && da.canEdit && (
                  <>
                    <button
                      onClick={() => openModal('editAgent', da, { focusSection: 'access' })}
                      className="flex h-7 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 py-0 font-sans text-[14px] font-semibold leading-normal text-(--brand-soft-text) desktop:hidden"
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </button>
                    <Button
                      variant="secondary"
                      size="xs"
                      className="hidden desktop:inline-flex"
                      onClick={() => openModal('editAgent', da, { focusSection: 'access' })}
                    >
                      <Icon name="pencil" size={14} />
                      Edit
                    </Button>
                  </>
                )}
              </div>
              <div className="px-4 py-[14px]">
                <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-(--text-tertiary)">
                  Team visibility
                </div>
                <div className="mt-[10px]">
                  <VisibilityValue visibility={da.visibility} sharedWith={da.sharedWith} />
                </div>
              </div>
              <div className="border-t border-(--border-subtle) px-4 py-[14px]">
                <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-(--text-tertiary)">
                  Agent visibility
                </div>
                {/* The SAME cards the Add/Edit modals render, in read-only mode —
                    one component, so the two surfaces can't drift apart. Only the
                    container differs: side by side here (the card is wide), stacked
                    in the modals (their form pane is narrow). */}
                <div className="mt-3 grid grid-cols-1 gap-3 desktop:grid-cols-2">
                  <AgentCallVisibility
                    variant="section"
                    direction="inbound"
                    mode={da.callPolicy}
                    selectedIds={da.allowedCallerAgentIds}
                    effectivePeerIds={inboundEffectiveIds}
                    peers={agentPeers}
                    daemons={daemons}
                    groups={memberSets}
                    target={<span className="font-mono text-[12.5px]">{agentLabel(da)}</span>}
                    editable={false}
                    onChange={() => {}}
                  />
                  <AgentCallVisibility
                    variant="section"
                    direction="outbound"
                    mode={da.outboundPolicy}
                    selectedIds={da.allowedTargetAgentIds}
                    effectivePeerIds={outboundEffectiveIds}
                    peers={agentPeers}
                    daemons={daemons}
                    groups={memberSets}
                    target={<span className="font-mono text-[12.5px]">{agentLabel(da)}</span>}
                    editable={false}
                    onChange={() => {}}
                  />
                </div>
              </div>
            </div>

            {/* Variables + Secrets (shared editable cards) — the design keeps these in
                the right column; each has its own inline add/edit affordances. */}
            <div className="order-5 min-w-0">
              <AgentEnvCard agent={da} />
            </div>
            <div className="order-6 min-w-0">
              <AgentSecretsCard agent={da} />
            </div>
          </div>
        </div>
      )}

      {/* Integrations tab — moved out of Configuration into its own tab. */}
      {tab === 'integrations' && (
        // Two-up on desktop (Home's dashboard split): integration cards left,
        // this agent's recent sessions right. Mobile keeps the single stack.
        <div className="grid grid-cols-1 gap-4 p-4 desktop:grid-cols-[1.5fr_1fr] desktop:items-start desktop:gap-[18px] desktop:p-0">
          <div className="card overflow-hidden max-desktop:rounded-lg">
            <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
              <span className="font-sans text-[14px] font-semibold leading-normal">Integrations</span>
              <button
                onClick={() => openModal('integration', da)}
                className="flex h-7 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 py-0 font-sans text-[14px] font-semibold leading-normal text-(--brand-soft-text) desktop:hidden"
              >
                <Icon name="plus" size={14} />
                Add
              </button>
              <Button
                variant="secondary"
                size="xs"
                className="hidden desktop:inline-flex"
                onClick={() => openModal('integration', da)}
              >
                <Icon name="plus" size={14} />
                Add integration
              </Button>
            </div>
            {hasInt ? (
              <>
                {/* Dual-rendered lists: mobile flat rows (no delete, padX 16) vs
                    desktop bordered sub-cards (delete iconbtn, padX 14). */}
                <div className="desktop:hidden">
                  {agentInts.map((g, i) => (
                    <div key={i} className={i > 0 ? 'border-t border-(--border-subtle)' : undefined}>
                      <div className="flex items-center gap-3 border-b border-(--border-subtle) px-4 py-3">
                        <Link href={botSettingsHref(g.botId)} className="group flex min-w-0 flex-1 items-center gap-3">
                          <span className="imark h-9 w-9 flex-none rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
                            <PlatformMark platform={g.platform} />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-sans text-[14px] font-semibold leading-normal group-hover:underline">
                                {g.name}
                              </span>
                              <FeishuRegionBadge integration={g} />
                            </span>
                            {g.channels[0] && (
                              <span className="font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                                {roomGlyph(g.channels[0].kind, g.platform)}
                                {rowLabel(g.channels[0])}
                              </span>
                            )}
                          </span>
                        </Link>
                        <span className="inline-flex flex-none items-center gap-[5px] rounded-full bg-(--brand-soft) px-[10px] py-[3px] font-sans text-[12px] font-semibold leading-normal text-(--brand-soft-text)">
                          <span className="h-[6px] w-[6px] rounded-full bg-(--status-online)" />
                          connected
                        </span>
                        {g.platform === 'discord' && g.discordAppId && (
                          <a
                            href={discordBotInviteUrl(g.discordAppId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Invite this bot to a Discord server — preset scopes &amp; permissions"
                            aria-label="Add this bot to a Discord server"
                            className="iconbtn h-7 w-7 flex-none"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Icon name="external-link" size={12} />
                          </a>
                        )}
                      </div>
                      <IntegrationChannelList
                        integrationId={g.id}
                        channels={g.channels}
                        botId={g.botId}
                        agentId={da.id}
                        platform={g.platform}
                        shareable={g.shareable}
                        gated={da.visibility === 'restricted'}
                        padX={16}
                      />
                    </div>
                  ))}
                  {webhookHooks.map((h, i) => (
                    <div
                      key={h.id}
                      className={`flex items-center gap-3 border-b border-(--border-subtle) px-4 py-3 ${
                        agentInts.length + i > 0 ? 'border-t' : ''
                      }`}
                    >
                      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-(--surface-inverse)">
                        <Icon name="webhook" size={18} color="#fff" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <span className="font-sans text-[14px] font-semibold leading-normal">{h.name}</span>
                        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                          {h.lastFiredAt ? `fired ${fmtHookAgo(h.lastFiredAt)}` : 'never fired'}
                        </span>
                      </span>
                      <span className="inline-flex flex-none items-center gap-[5px] rounded-full bg-(--surface-active) px-[10px] py-[3px] font-sans text-[12px] font-semibold leading-normal text-(--text-tertiary)">
                        webhook
                      </span>
                    </div>
                  ))}
                  {githubHooks.map((h, i) => (
                    <div
                      key={h.id}
                      className={`flex items-center gap-3 border-b border-(--border-subtle) px-4 py-3 ${
                        agentInts.length + webhookHooks.length + i > 0 ? 'border-t' : ''
                      }`}
                    >
                      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
                        <span className="flex h-[18px] w-[18px] items-center justify-center">
                          <PlatformMark platform="github" fillPct={100} />
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="mono min-w-0 truncate text-[13px] font-semibold">
                            {h.repoFullName ?? h.name}
                          </span>
                          {watchUnauthorized(h) && <UnauthorizedWatchBadge />}
                        </span>
                        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                          {GH_FAMILIES.filter((f) => famCovered(h.events, f.fam))
                            .map((f) => f.pill)
                            .join(' · ') || 'no events'}
                        </span>
                        {(h.reviewPolicy !== 'off' || h.reportingMode === 'check') && (
                          <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                            {reviewPolicyLabel(h.reviewPolicy)} review
                            {h.reportingMode === 'check' ? ' · informational Check' : ''}
                          </span>
                        )}
                      </span>
                      <button
                        className="iconbtn flex-none"
                        title="PR review and Checks settings"
                        onClick={() => openReviewSettings(h)}
                      >
                        <Icon name="settings-2" size={15} />
                      </button>
                    </div>
                  ))}
                  {gitlabHooks.map((h, i) => (
                    <div
                      key={h.id}
                      className={`flex items-center gap-3 border-b border-(--border-subtle) px-4 py-3 ${
                        agentInts.length + webhookHooks.length + githubHooks.length + i > 0 ? 'border-t' : ''
                      }`}
                    >
                      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
                        <span className="flex h-[18px] w-[18px] items-center justify-center">
                          <PlatformMark platform="gitlab" fillPct={100} />
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <span className="mono min-w-0 truncate text-[13px] font-semibold">
                          {h.repoFullName ?? h.name}
                        </span>
                        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                          {gitlabRowFamilies(h.events)
                            .filter((f) => gitlabFamCovered(h.events, f.fam))
                            .map((f) => f.pill)
                            .join(' · ') || 'no events'}
                          {` · ${GL_TRIGGER_PILL[gitlabTriggerModeOf(h)]}`}
                        </span>
                        {(h.reviewPolicy !== 'off' || h.reportingMode === 'check') && (
                          <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                            {reviewPolicyLabel(h.reviewPolicy)} review
                            {h.reportingMode === 'check' ? ' · run note' : ''}
                          </span>
                        )}
                      </span>
                      <button
                        className="iconbtn flex-none"
                        title="MR review and run note settings"
                        onClick={() => openReviewSettings(h)}
                      >
                        <Icon name="settings-2" size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="hidden flex-col gap-3 px-4 py-[14px] desktop:flex">
                  {agentInts.map((g, i) => (
                    <div key={i} className="overflow-hidden rounded-[9px] border border-(--border-subtle)">
                      <div className="flex items-center gap-3 px-[14px] py-3">
                        <Link href={botSettingsHref(g.botId)} className="group flex min-w-0 flex-1 items-center gap-3">
                          <span className="imark h-[34px] w-[34px] rounded-md">
                            <PlatformMark platform={g.platform} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-sans text-[13.5px] font-semibold leading-normal group-hover:underline">
                                {g.name}
                              </span>
                              <FeishuRegionBadge integration={g} />
                              <span className="badge bg-(--brand-soft) text-(--brand-soft-text)">
                                <span className="dot h-[6px] w-[6px] bg-(--status-online)" />
                                connected
                              </span>
                              {g.shareable && (
                                <span
                                  className="badge bg-(--surface-app) text-(--text-tertiary)"
                                  title="Shared bot — used by multiple agents, inbound via a relay. Each channel dispatches to one of them by default."
                                >
                                  <Icon name="users" size={11} />
                                  shared · {g.agentCount} {g.agentCount === '1' ? 'agent' : 'agents'}
                                </span>
                              )}
                            </div>
                          </div>
                        </Link>
                        {g.platform === 'discord' && g.discordAppId && (
                          <a
                            href={discordBotInviteUrl(g.discordAppId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Invite this bot to a Discord server — preset scopes &amp; permissions"
                            aria-label="Add this bot to a Discord server"
                            className="iconbtn flex-none"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Icon name="external-link" size={14} />
                          </a>
                        )}
                        <button
                          className="iconbtn"
                          title="Delete integration"
                          onClick={() => openModal('deleteIntegration', g)}
                        >
                          <Icon name="unplug" size={15} />
                        </button>
                      </div>
                      <IntegrationChannelList
                        integrationId={g.id}
                        channels={g.channels}
                        botId={g.botId}
                        agentId={da.id}
                        platform={g.platform}
                        shareable={g.shareable}
                        gated={da.visibility === 'restricted'}
                        padX={14}
                      />
                    </div>
                  ))}
                  {webhookHooks.map((h) => (
                    <div key={h.id} className="overflow-hidden rounded-[9px] border border-(--border-subtle)">
                      <div className="flex items-center gap-3 px-[14px] py-3">
                        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md bg-(--surface-inverse)">
                          <Icon name="webhook" size={17} color="#fff" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-sans text-[13.5px] font-semibold leading-normal">{h.name}</span>
                            <span className="badge bg-(--surface-active) text-(--text-tertiary)">webhook</span>
                          </div>
                          {h.url && (
                            <div className="mono mt-[2px] truncate text-[11.5px] font-normal text-(--text-tertiary)">
                              {h.url}
                            </div>
                          )}
                        </div>
                        <span className="flex-none font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                          {h.lastFiredAt ? `fired ${fmtHookAgo(h.lastFiredAt)}` : 'never fired'}
                        </span>
                        <button
                          className="iconbtn"
                          title="Recent deliveries"
                          onClick={() => setHookRunsFor(hookRunsFor === h.id ? null : h.id)}
                        >
                          <Icon name={hookRunsFor === h.id ? 'chevron-up' : 'history'} size={15} />
                        </button>
                        <button className="iconbtn" title="Delete webhook" onClick={() => openModal('deleteHook', h)}>
                          <Icon name="trash-2" size={15} />
                        </button>
                      </div>
                      {hookRunsFor === h.id && (
                        <HookRunsPanel hookId={h.id} sessionHref={(sid) => orgPath(`/sessions/${sid}`)} />
                      )}
                    </div>
                  ))}
                  {/* GitHub group (design): one card, a row per watched repo with
                        event toggle pills + a "when created/updated" cadence select;
                        hooks under the hood — one per repo. */}
                  {githubHooks.length > 0 && (
                    <div className="overflow-hidden rounded-[9px] border border-(--border-subtle)">
                      <div className="flex items-center gap-3 px-[14px] py-3">
                        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center">
                          <span className="flex h-[26px] w-[26px] items-center justify-center [&>svg]:h-full [&>svg]:w-full">
                            <GithubMark />
                          </span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-sans text-[13.5px] font-semibold leading-normal">{githubOwner}</span>
                            <span className="badge bg-(--brand-soft) text-(--brand-soft-text)">
                              <span className="dot h-[6px] w-[6px] bg-(--status-online)" />
                              connected
                            </span>
                          </div>
                          <div className="mono mt-[3px] text-[11.5px] font-normal text-(--text-tertiary)">GitHub</div>
                        </div>
                        <button
                          className="iconbtn"
                          title="Disconnect GitHub"
                          onClick={() => openModal('deleteHook', githubHooks)}
                        >
                          <Icon name="unplug" size={15} />
                        </button>
                      </div>
                      <div className="border-t border-(--border-subtle) bg-(--surface-app)">
                        {githubHooks.map((h) => (
                          <div key={h.id} className="border-b border-(--border-subtle)">
                            {/* Design row: wraps (gap 6×8) — the repo name keeps ≥90px and the
                                  control clusters flow to the next line instead of crushing it. */}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-[6px] px-[14px] py-[9px]">
                              <Icon name="folder-git-2" size={14} color="var(--text-tertiary)" className="flex-none" />
                              <span className="mono min-w-[90px] flex-1 truncate text-[12px] text-(--text-primary)">
                                {h.repoFullName ?? h.name}
                              </span>
                              {watchUnauthorized(h) && <UnauthorizedWatchBadge />}
                              <div className="ml-auto inline-flex flex-none gap-[2px] rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) p-[2px]">
                                {GH_FAMILIES.map((f) => {
                                  const on = famCovered(h.events, f.fam)
                                  return (
                                    <button
                                      key={f.fam}
                                      onClick={() => void toggleHookFam(h, f.fam)}
                                      disabled={hookBusy === h.id}
                                      title={on ? `Stop listening for ${f.pill}` : `Listen for ${f.pill}`}
                                      className={`cursor-pointer rounded-[7px] border-0 px-[9px] py-[3px] font-sans text-[11.5px] leading-normal ${
                                        on
                                          ? 'bg-(--surface-card) font-semibold text-(--text-primary) shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                                          : 'bg-transparent font-normal text-(--text-tertiary)'
                                      } ${hookBusy === h.id ? 'opacity-60' : ''}`}
                                    >
                                      {f.pill}
                                    </button>
                                  )
                                })}
                              </div>
                              {/* Trigger — the same ⚡ dropdown the IM channel rows carry, mention last. */}
                              <TriggerSelect
                                className="flex-none"
                                options={GH_TRIGGER_MODES.map((mode) => ({
                                  value: mode,
                                  label: GH_TRIGGER_PILL[mode],
                                  hint: githubTriggerTooltip(mode, da.name)
                                }))}
                                value={triggerModeOf(h)}
                                onChange={(mode) => void setHookCadence(h, mode)}
                                ariaLabel={`Trigger for ${h.repoFullName ?? h.name}`}
                                hint="Trigger — when this agent runs"
                                busy={hookBusy === h.id}
                              />
                              <span className="inline-flex flex-none gap-[2px]">
                                <button
                                  className="iconbtn h-[26px] w-[26px] flex-none"
                                  title="PR review and Checks settings"
                                  onClick={() => openReviewSettings(h)}
                                >
                                  <Icon name="settings-2" size={13} />
                                </button>
                                <button
                                  className="iconbtn h-[26px] w-[26px] flex-none"
                                  title="Recent deliveries"
                                  onClick={() => setHookRunsFor(hookRunsFor === h.id ? null : h.id)}
                                >
                                  <Icon name={hookRunsFor === h.id ? 'chevron-up' : 'history'} size={13} />
                                </button>
                                <button
                                  className="iconbtn h-[26px] w-[26px] flex-none"
                                  title="Remove repository"
                                  onClick={() => openModal('deleteHook', h)}
                                >
                                  <Icon name="x" size={13} />
                                </button>
                              </span>
                            </div>
                            {hookRunsFor === h.id && (
                              <HookRunsPanel hookId={h.id} sessionHref={(sid) => orgPath(`/sessions/${sid}`)} />
                            )}
                          </div>
                        ))}
                        <div className="px-[14px] py-2">
                          {/* Straight to the GitHub pane — this button adds a repo, not a bot. */}
                          <button
                            className="lnk text-[12px]"
                            onClick={() => openModal('integration', da, { platform: 'github' })}
                          >
                            <Icon name="plus" size={13} />
                            Add repository
                          </button>
                        </div>
                        <div className="flex items-center gap-[7px] px-[14px] pt-0 pb-2 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                          <Icon name="info" size={12} className="flex-none" />
                          Pick which repos to watch and which events run the agent — it replies on the same PR, issue or
                          commit thread.
                        </div>
                      </div>
                    </div>
                  )}
                  {/* GitLab group — the same one-card shape as GitHub, minus the
                      review and Check controls the M6 slice has not landed yet. */}
                  {gitlabHooks.length > 0 && (
                    <div className="overflow-hidden rounded-[9px] border border-(--border-subtle)">
                      <div className="flex items-center gap-3 px-[14px] py-3">
                        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center">
                          <span className="flex h-[26px] w-[26px] items-center justify-center">
                            <GitlabMark fillPct={100} />
                          </span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-sans text-[13.5px] font-semibold leading-normal">GitLab</span>
                            <span className="badge bg-(--brand-soft) text-(--brand-soft-text)">
                              <span className="dot h-[6px] w-[6px] bg-(--status-online)" />
                              connected
                            </span>
                          </div>
                          <div className="mono mt-[3px] text-[11.5px] font-normal text-(--text-tertiary)">
                            gitlab.com
                          </div>
                        </div>
                      </div>
                      <div className="border-t border-(--border-subtle) bg-(--surface-app)">
                        {gitlabHooks.map((h) => (
                          <div key={h.id} className="border-b border-(--border-subtle)">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-[6px] px-[14px] py-[9px]">
                              <Icon name="folder-git-2" size={14} color="var(--text-tertiary)" className="flex-none" />
                              <span className="mono min-w-[90px] flex-1 truncate text-[12px] text-(--text-primary)">
                                {h.repoFullName ?? h.name}
                              </span>
                              <GitlabBotChip bot={gitlabAgentBot(gitlabBindings, h.repoFullName, da.id)} />
                              {gitlabHookNeedsNormalization(h) && (
                                <span
                                  className="badge flex-none bg-(--surface-active) text-(--text-tertiary)"
                                  title="The stored subscription matches no trigger exactly — the nearest one is shown. Picking a trigger replaces it."
                                >
                                  custom rule
                                </span>
                              )}
                              <div className="ml-auto inline-flex flex-none gap-[2px] rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) p-[2px]">
                                {/* Pushes appear only on a hook that already listens to them — visible and removable, never addable. */}
                                {gitlabRowFamilies(h.events).map((f) => {
                                  const on = gitlabFamCovered(h.events, f.fam)
                                  return (
                                    <button
                                      key={f.fam}
                                      onClick={() => void toggleGitlabHookFam(h, f.fam)}
                                      disabled={hookBusy === h.id}
                                      title={on ? `Stop listening for ${f.label}` : `Listen for ${f.label}`}
                                      className={`cursor-pointer rounded-[7px] border-0 px-[9px] py-[3px] font-sans text-[11.5px] leading-normal ${
                                        on
                                          ? 'bg-(--surface-card) font-semibold text-(--text-primary) shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                                          : 'bg-transparent font-normal text-(--text-tertiary)'
                                      } ${hookBusy === h.id ? 'opacity-60' : ''}`}
                                    >
                                      {f.pill}
                                    </button>
                                  )
                                })}
                              </div>
                              {/* Trigger — the same ⚡ dropdown the GitHub rows carry. */}
                              <TriggerSelect
                                className="flex-none"
                                options={GL_TRIGGER_MODES.map((mode) => ({
                                  value: mode,
                                  label: GL_TRIGGER_PILL[mode],
                                  hint: gitlabTriggerTooltip(mode, da.name)
                                }))}
                                value={gitlabTriggerModeOf(h)}
                                onChange={(mode) => void setGitlabHookCadence(h, mode)}
                                ariaLabel={`Trigger for ${h.repoFullName ?? h.name}`}
                                hint="Trigger — when this agent runs"
                                busy={hookBusy === h.id}
                              />
                              <span className="inline-flex flex-none gap-[2px]">
                                <button
                                  className="iconbtn h-[26px] w-[26px] flex-none"
                                  title="MR review and run note settings"
                                  onClick={() => openReviewSettings(h)}
                                >
                                  <Icon name="settings-2" size={13} />
                                </button>
                                <button
                                  className="iconbtn h-[26px] w-[26px] flex-none"
                                  title="Recent deliveries"
                                  onClick={() => setHookRunsFor(hookRunsFor === h.id ? null : h.id)}
                                >
                                  <Icon name={hookRunsFor === h.id ? 'chevron-up' : 'history'} size={13} />
                                </button>
                                <button
                                  className="iconbtn h-[26px] w-[26px] flex-none"
                                  title="Remove project"
                                  onClick={() => openModal('deleteHook', h)}
                                >
                                  <Icon name="x" size={13} />
                                </button>
                              </span>
                            </div>
                            {hookRunsFor === h.id && (
                              <HookRunsPanel hookId={h.id} sessionHref={(sid) => orgPath(`/sessions/${sid}`)} />
                            )}
                          </div>
                        ))}
                        <div className="px-[14px] py-2">
                          {/* Straight to the GitLab pane — this button adds a project, not a bot. */}
                          <button
                            className="lnk text-[12px]"
                            onClick={() => openModal('integration', da, { platform: 'gitlab' })}
                          >
                            <Icon name="plus" size={13} />
                            Add project
                          </button>
                        </div>
                        <div className="flex items-center gap-[7px] px-[14px] pt-0 pb-2 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                          <Icon name="info" size={12} className="flex-none" />
                          Pick which projects to watch and which events run the agent — it replies on the same issue,
                          merge request thread.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : hooksLoadError ? (
              <div className="px-5 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
                Couldn’t load webhooks.
              </div>
            ) : hooksLoading ? (
              <LoadingState padding={42} />
            ) : (
              /* Empty: instead of a dead end, offer what this agent COULD connect
                 to — each tile opens the Add-integration modal on that platform. */
              <div className="px-4 py-5 desktop:px-5 desktop:py-6">
                <div className="text-center">
                  <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                    No integration yet
                  </div>
                  <div className="mx-auto mt-1 max-w-[380px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                    Connect <span className="mono text-[11.5px]">{da.name}</span>&#32;to a channel so it can read and
                    post. It can&apos;t receive messages until you do.
                  </div>
                </div>
                {/* Identical grid to the Add-integration modal's platform picker —
                    same list, order, tile size and disabled treatment. */}
                <div className="mt-4 grid grid-cols-2 gap-[10px] desktop:flex desktop:flex-wrap desktop:justify-center">
                  {PLATFORMS.map((p) => {
                    const available = integrationPlatformAvailable(p.key)
                    return (
                      <div
                        key={p.key}
                        className={`ptile desktop:w-[132px] desktop:flex-none desktop:flex-col desktop:justify-center desktop:gap-[6px] desktop:px-2 desktop:text-center ${
                          available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                        }`}
                        aria-disabled={!available}
                        title={available ? INTEGRATION_BLURB[p.key] : 'Not supported by this daemon'}
                        onClick={available ? () => openModal('integration', da, { platform: p.key }) : undefined}
                      >
                        {p.key === 'github' ? (
                          <span className="flex h-[26px] w-[26px] flex-none items-center justify-center [&>svg]:h-full [&>svg]:w-full">
                            <GithubMark />
                          </span>
                        ) : (
                          <span className="flex h-[26px] w-[26px] flex-none items-center justify-center">
                            <PlatformMark platform={p.key} fillPct={100} />
                          </span>
                        )}
                        {p.key === 'feishu' ? (
                          <LarkFeishuSwitcher
                            value="lark"
                            disabled={!available}
                            onSwitch={(feishuRegion) =>
                              openModal('integration', da, { platform: 'feishu', feishuRegion })
                            }
                          />
                        ) : (
                          <span className="font-sans text-[13px] font-semibold leading-normal">{p.label}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-4 desktop:gap-[18px]">
            {da.canEdit && !da.name.startsWith(MOCK_PREFIX) && (
              <ApprovalRequestsCard agentId={da.id} className="max-desktop:rounded-lg" />
            )}
            {/* This agent's recent sessions — same card as Home's Recent list. */}
            <RecentSessionsCard
              title="Recent sessions"
              sessions={recentSessions}
              limit={12}
              loading={agentSessionsLoading}
              allHref={orgPath(`/sessions?agent=${da.id}`)}
              emptyText="No sessions yet."
              showAgent={false}
              className="max-desktop:rounded-lg"
            />
          </div>
        </div>
      )}

      {/* Workspace tab — the workspace card (source + authorized repos + live git
          state) sits above the file browser, so the options and the files they
          configure read as one surface. Live agents get the self-contained
          GitHub-style browser, which supplies the card's live half; demo (mocked-)
          agents fill it from their static workspace fields. */}
      {tab === 'workspace' &&
        (!da.name.startsWith(MOCK_PREFIX) ? (
          <div className="flex flex-col gap-4 p-4 desktop:p-0">
            {/* Keyed by workspace identity: the editor now lives in the card
                this instance renders, so a replacement must remount the browser
                instead of leaving the previous tree/preview/git state beneath a
                refreshed source card. */}
            <WorkspaceFiles
              key={workspaceReadModelKey(da, selectedWorktreeSessionId ?? undefined, selectedRepo ?? undefined)}
              agentId={id}
              {...(selectedWorktreeSessionId ? { sessionId: selectedWorktreeSessionId } : {})}
              {...(selectedRepo ? { repo: selectedRepo } : {})}
              repoOptions={workspaceRepoOptions}
              {...(isGitWorkspace(da.workspace) ? { primaryRepoLabel: da.workspace.repo } : {})}
              onRepoChange={selectRepoScope}
              workdir={da.workdir}
              canEdit={selectedWorktreeSessionId === null && da.workspace.mode === 'scratch' && da.canEdit}
              sandboxed={isPoolPlacementKind(da.placementKind)}
              renderWorkspacePicker={(primaryBranch) =>
                isGitWorkspace(da.workspace) ? (
                  <WorkspaceScopePicker
                    primaryBranch={primaryBranch ?? da.workspace.branch}
                    sessions={workspaceSessions}
                    selectedSessionId={selectedWorktreeSessionId}
                    selectedSession={selectedWorktreeSession}
                    loading={workspaceSessionsLoading}
                    hasMore={workspaceSessionsNextCursor !== null}
                    loadingMore={workspaceSessionsLoadingMore}
                    onLoadMore={() => void loadMoreWorkspaceSessions()}
                    onChange={(sessionId) => {
                      const next = new URLSearchParams(params)
                      if (sessionId) next.set('worktree', sessionId)
                      else next.delete('worktree')
                      router.replace(`${orgPath(`/agents/${id}`)}?${next.toString()}`, { scroll: false })
                    }}
                    orgPath={orgPath}
                  />
                ) : undefined
              }
              renderHeader={(header) => <WorkspaceCard agent={da} header={header} />}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4 desktop:p-0">
            <WorkspaceCard agent={da} header={mockWorkspaceHeader} />

            <FileBrowserShell
              title="Files"
              headerEnd={
                isGitWorkspace(ws) ? (
                  <div className="flex w-1/4 min-w-0 flex-none items-center gap-2 max-desktop:w-[min(210px,56vw)]">
                    <WorkspaceScopePicker
                      primaryBranch={ws.branch}
                      sessions={[]}
                      selectedSessionId={null}
                      loading={false}
                      hasMore={false}
                      loadingMore={false}
                      onLoadMore={() => undefined}
                      onChange={() => undefined}
                      orgPath={orgPath}
                    />
                  </div>
                ) : (
                  <span className="mono text-[11px] text-(--text-tertiary)">{filesSummary}</span>
                )
              }
            >
              {ws.files.length > 0 ? (
                <WorkspaceFilesMock files={ws.files} />
              ) : (
                <div className="flex flex-col items-center gap-[6px] px-6 py-7 text-center">
                  <Icon name="folder" size={20} color="var(--text-tertiary)" />
                  <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                    No files reported yet — the daemon indexes the working tree on first run.
                  </div>
                </div>
              )}
            </FileBrowserShell>
          </div>
        ))}

      {/* Memory tab — the agent's persistent memory file (view + edit) + backend switch */}
      {tab === 'memory' && (
        <MemoryPanel
          agentId={id}
          canEdit={!da.name.startsWith(MOCK_PREFIX) && da.canEdit}
          memoryProvider={da.memoryProvider}
          autoDistill={da.memoryAutoDistill}
          memoryScope={da.memoryScope}
          memoryDreaming={da.memoryDreaming}
          memoryConnectionId={da.memoryConnectionId}
          memoryRecall={da.memoryRecall}
          memoryCaptureMode={da.memoryCaptureMode}
          sessionBasePath={orgPath('/sessions')}
          sandboxed={isPoolPlacementKind(da.placementKind)}
        />
      )}

      {/* Tools & Skills tab — leads with the daemon runtime's MCP servers (Tools),
          then the workspace-indexed knowledge below it. */}
      {tab === 'tools' && (
        <div className="flex flex-col gap-4 p-4 desktop:gap-[18px] desktop:p-0">
          <AgentToolsCard
            agentId={da.id}
            runtime={da.runtime}
            daemon={owningDaemon}
            canEdit={!da.name.startsWith(MOCK_PREFIX) && da.canEdit}
          />
          <AgentSkillsCard agentId={da.id} canEdit={!da.name.startsWith(MOCK_PREFIX) && da.canEdit} />
          <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
            <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal desktop:py-[13px]">
              Loaded from workspace
            </div>
            <div className="desktop:py-[6px]">
              {MOCK_MODE ? (
                <>
                  <div className="flex items-center gap-[11px] px-4 py-[11px] desktop:py-3">
                    <Icon name="file-text" size={16} color="var(--text-tertiary)" />
                    <span className="mono flex-1 text-[12.5px]">CLAUDE.md</span>
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      project guide · 2.1 KB
                    </span>
                  </div>
                  <div className="flex items-center gap-[11px] border-t border-(--border-subtle) px-4 py-[11px] desktop:py-3">
                    <Icon name="folder" size={16} color="var(--text-tertiary)" />
                    <span className="mono flex-1 text-[12.5px]">.agent/skills/</span>
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      4 skills
                    </span>
                  </div>
                  <div className="flex items-center gap-[11px] border-t border-(--border-subtle) px-4 py-[11px] desktop:py-3">
                    <Icon name="book-open" size={16} color="var(--text-tertiary)" />
                    <span className="mono flex-1 text-[12.5px]">docs/runbooks/</span>
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      12 files indexed
                    </span>
                  </div>
                </>
              ) : (
                <LocalSkillsList agentId={da.id} />
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-(--border-subtle) px-4 py-[13px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              <Icon name="info" size={14} />
              Plus everything in{' '}
              <Link className="lnk text-[12px]" href={orgPath('/tools')}>
                workspace knowledge &amp; skills
              </Link>
              , shared across all agents.
            </div>
          </div>
        </div>
      )}

      {/* One review/check settings surface, rendered as a bottom sheet on mobile
          and a centered dialog on desktop. The dense repository rows only open
          it; they do not duplicate policy controls. */}
      {reviewSettingsDraft && reviewSettingsHook && (
        <div
          onClick={closeReviewSettings}
          className="fixed inset-0 z-50 flex items-end bg-[rgba(17,22,29,.5)] backdrop-blur-[2px] desktop:items-center desktop:justify-center desktop:p-6"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="code-host-review-settings-title"
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[88vh] w-full flex-col rounded-t-xl bg-(--surface-card) shadow-[0_-8px_32px_rgba(0,0,0,.18)] desktop:max-w-[620px] desktop:rounded-xl desktop:shadow-(--shadow-xl)"
          >
            <div className="flex items-center gap-3 border-b border-(--border-subtle) px-4 py-[13px] desktop:px-5">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--surface-inverse)">
                <span className="flex h-[17px] w-[17px] items-center justify-center">
                  {isGitlabReviewDraft ? <GitlabMark fillPct={100} /> : <GithubMark color="#fff" />}
                </span>
              </span>
              <div className="min-w-0 flex-1">
                <div
                  id="code-host-review-settings-title"
                  className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)"
                >
                  {isGitlabReviewDraft ? 'MR review & run note' : 'PR review & Checks'}
                </div>
                <div className="mono mt-[2px] truncate text-[11.5px] text-(--text-tertiary)">
                  {reviewSettingsHook.repoFullName ?? reviewSettingsHook.name}
                </div>
              </div>
              <button className="iconbtn" title="Close" onClick={closeReviewSettings}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="overflow-y-auto px-4 py-4 desktop:px-5">
              {isGitlabReviewDraft ? (
                <GitlabReviewSettings
                  value={reviewSettingsDraft}
                  onReviewPolicyChange={(reviewPolicy) => {
                    setReviewSettingsError(null)
                    setReviewSettingsDraft((draft) => (draft ? { ...draft, reviewPolicy } : draft))
                  }}
                  onReportingModeChange={(reportingMode) => {
                    setReviewSettingsError(null)
                    setReviewSettingsDraft((draft) => (draft ? { ...draft, reportingMode } : draft))
                  }}
                  defaultExpanded
                />
              ) : (
                <GithubReviewSettings
                  value={reviewSettingsDraft}
                  onReviewPolicyChange={(reviewPolicy) => {
                    setReviewSettingsError(null)
                    setReviewSettingsDraft((draft) => (draft ? { ...draft, reviewPolicy } : draft))
                  }}
                  onReportingModeChange={(reportingMode) => {
                    setReviewSettingsError(null)
                    setReviewSettingsDraft((draft) => (draft ? { ...draft, reportingMode } : draft))
                  }}
                  repoAccess={reviewSettingsRepoAccess}
                  installation={reviewSettingsInstallation}
                  defaultExpanded
                />
              )}
              {reviewSettingsError && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                  <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
                  {reviewSettingsError}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-(--border-subtle) px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] desktop:px-5 desktop:py-3">
              <Button variant="ghost" onClick={closeReviewSettings}>
                Cancel
              </Button>
              <button
                type="button"
                disabled={reviewSettingsSaving || reviewSettingsBlocked}
                onClick={() => void saveReviewSettings()}
                className={`dsbtn dsbtn-primary ${
                  reviewSettingsSaving || reviewSettingsBlocked ? 'cursor-default opacity-50' : ''
                }`}
              >
                <Icon name="check" size={15} />
                {reviewSettingsSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile agent-actions bottom sheet (Pause/Unpause / Delete) — same open-state as the
          desktop kebab dropdown above; CSS decides which surface shows. */}
      {actionsOpen && (
        <div
          onClick={() => setActionsOpen(false)}
          className="fixed inset-0 z-40 flex items-end bg-[rgba(17,22,29,.5)] backdrop-blur-[2px] desktop:hidden"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded-t-xl bg-(--surface-card) px-3 pt-2 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-[0_-8px_32px_rgba(0,0,0,.18)]"
          >
            <div className="mx-auto mt-1 mb-[10px] h-1 w-10 rounded-full bg-(--border-default)" />
            <button
              onClick={() => void togglePause()}
              disabled={actionSaving}
              className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-3 py-[13px] text-left font-sans text-[15px] font-medium leading-normal text-(--text-primary)"
            >
              <Icon name={pauseActionIcon} size={18} color="var(--text-secondary)" />
              {actionSaving ? 'Saving...' : pauseActionLabel}
            </button>
            {actionErr && (
              <div className="px-3 pb-[10px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
                {actionErr}
              </div>
            )}
            {/* Built-in preset agents are permanent — no Delete (the CP refuses it too). */}
            {!da.builtin && (
              <button
                onClick={() => {
                  setActionsOpen(false)
                  openModal('deleteAgent', da)
                }}
                className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-3 py-[13px] text-left font-sans text-[15px] font-medium leading-normal text-(--red-600)"
              >
                <Icon name="trash-2" size={18} />
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Amber marker for a grandfathered github hook whose watch repo fell outside
// the agent's authorized set (workspace ∪ authorized-repo grants). Events still
// fire; only the agent's GitHub write-back on that repo is credential-less.
function UnauthorizedWatchBadge() {
  return (
    <span
      className="badge flex-none bg-(--status-paused-soft) text-(--amber-500)"
      title="This repo isn't authorized for the agent — events still trigger it, but replies and pushes back to GitHub have no credentials. Open Edit workspace to authorize it."
    >
      <Icon name="triangle-alert" size={11} />
      write-back unauthorized
    </span>
  )
}

// "3m ago" for a hook's last-fired stamp and its delivery rows.
function fmtHookAgo(iso: string): string {
  const min = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const HOOK_RUN_DOT: Record<HookRunDto['status'], string> = {
  running: 'bg-(--status-info)',
  success: 'bg-(--status-online)',
  failed: 'bg-(--status-error)'
}

// Recent deliveries for one webhook (GET /hooks/:id/runs), fetched on expand.
// Each row: delivery outcome + the session it opened (deep-link when reported).
function HookRunsPanel({ hookId, sessionHref }: { hookId: string; sessionHref: (sessionId: string) => string }) {
  const { activeOrg } = useOrgs()
  const runsKey = consoleKeys.hookRuns(activeOrg?.id, hookId)
  const { data: runsData, error } = useSWR(
    runsKey,
    ([, orgId, , requestedHookId]) => fetchHookRuns(requestedHookId, orgId),
    { refreshInterval: HOOK_RUN_REFRESH_MS }
  )
  const runs = runsData ?? null
  const err = runsData === undefined && error ? (error instanceof Error ? error.message : String(error)) : null

  return (
    <div className="border-t border-(--border-subtle) bg-(--surface-app)">
      {err ? (
        <div className="px-[14px] py-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {err}
        </div>
      ) : runs === null ? (
        <div className="px-[14px] py-3 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          Loading deliveries…
        </div>
      ) : runs.length === 0 ? (
        <div className="px-[14px] py-3 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          No deliveries yet — POST the endpoint URL to fire this agent.
        </div>
      ) : (
        runs.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-[10px] border-b border-(--border-subtle) px-[14px] py-[9px] last:border-b-0"
          >
            <span className={`h-[7px] w-[7px] flex-none rounded-full ${HOOK_RUN_DOT[r.status]}`} />
            <span className="mono min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)" title={r.deliveryKey}>
              {r.deliveryKey}
            </span>
            {r.status === 'failed' && r.reason && (
              <span className="flex-none font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">
                {r.reason}
              </span>
            )}
            {r.durationMs !== null && (
              <span className="flex-none font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                {(r.durationMs / 1000).toFixed(1)}s
              </span>
            )}
            <span className="flex-none font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {fmtHookAgo(r.startedAt)}
            </span>
            {r.sessionId && (
              <Link href={sessionHref(r.sessionId)} className="lnk flex-none text-[11.5px]">
                Open session
              </Link>
            )}
          </div>
        ))
      )}
    </div>
  )
}
