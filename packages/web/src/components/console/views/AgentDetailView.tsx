'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  agentEffortDisplay,
  agentLabel,
  agentModelDisplay,
  agentPermissionDisplay,
  effectiveAgentStatus,
  effortField,
  flattenFiles,
  MOCK_MODE,
  MOCK_PREFIX,
  runtimeLabel,
  status,
  supportsModes,
  workspaceStatus,
  type Agent,
  type AgentCallPolicy
} from '@/lib/data'
import {
  creatorLabel,
  decideAgentPermissionRequest,
  fetchAgentHooks,
  fetchAgentPermissionRequests,
  fetchAgentRepos,
  fetchGithubInstallations,
  fetchHookRuns,
  updateGithubHook,
  uploadAgentIcon,
  type GithubInstallationDto,
  type AgentPermissionRequestDto,
  type HookDto,
  type HookRunDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { useModal } from '@/components/console/ModalProvider'
import { AgentEnvCard } from '@/components/console/AgentEnvCard'
import { IntegrationMarks } from '@/components/console/IntegrationMarks'
import { AgentApiPanel } from '@/components/console/AgentApiPanel'
import { AgentSecretsCard } from '@/components/console/AgentSecretsCard'
import { AgentToolsCard } from '@/components/console/AgentToolsCard'
import { AgentSkillsCard } from '@/components/console/AgentSkillsCard'
import { IntegrationChannelList } from '@/components/console/IntegrationChannelList'
import { discordBotInviteUrl } from '@/lib/discord-invite'
import { WorkspaceCard } from '@/components/console/WorkspaceCard'
import { WorkspaceFiles } from '@/components/console/WorkspaceFiles'
import { WorkspaceFilesMock } from '@/components/console/WorkspaceFilesMock'
import { FileBrowserShell } from '@/components/console/FileBrowser'
import { MemoryPanel } from '@/components/console/MemoryPanel'
import { GithubReviewSettings } from '@/components/console/GithubReviewSettings'
import { VisibilityValue } from '@/components/console/VisibilityField'
import { AgentIconView, AgentMark, GithubMark, LoadingState, PlatformMark } from '@/components/marks'
import { buildAgentReachabilityGraph } from '@/lib/agent-reachability'
import { BOT_PLATFORMS, type Platform } from '@/components/console/modals/AddIntegrationModal'
import { AgentIconPicker } from '@/components/console/AgentIconPicker'
import { NotFound } from '@/components/console/NotFound'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import {
  GH_FAMILIES,
  GH_TRIGGER_LABEL,
  GH_TRIGGER_MODES,
  commentFamiliesForFamilies,
  eventsForFamilies,
  famCovered,
  githubHookNeedsNormalization,
  githubMentionUsage,
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

type DetailTab = 'config' | 'integrations' | 'workspace' | 'memory' | 'api' | 'knowledge'
const HOOK_REFRESH_MS = 30_000

// One-liners for the empty-integrations tiles. The tile SET is derived from the
// owning daemon's advertised adapters (below) — never hard-coded — so a tile
// can't promise a platform the Add-integration modal would swap out from under
// the click. webhook/github are relay/CP-backed triggers: always offered.
const INTEGRATION_BLURB: Record<Platform, string> = {
  slack: 'Reply in channels & DMs',
  telegram: 'Reply in groups & chats',
  discord: 'Reply in servers',
  feishu: 'Reply in groups & chats',
  github: 'React to issues & PRs',
  webhook: 'Trigger by posting a URL'
}
const HOOK_RUN_REFRESH_MS = 10_000

interface GithubReviewSettingsDraft {
  hookId: string
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
  const { agents, getAgent, getSessions, daemons, daemonsLoading, integrations, agentsLoading, updateAgent, refresh } =
    useConsoleData()
  const { openPlayground } = usePlayground()
  const { openModal } = useModal()
  const approvalAgent = getAgent(id)
  const approvalRequestsKey =
    !MOCK_MODE && approvalAgent?.canManageSharing && !approvalAgent.name.startsWith(MOCK_PREFIX)
      ? consoleKeys.agentPermissionRequests(activeOrg?.id, id)
      : null
  const {
    data: approvalRequests,
    error: approvalRequestsError,
    isLoading: approvalRequestsLoading,
    mutate: mutateApprovalRequests
  } = useSWR<AgentPermissionRequestDto[]>(
    approvalRequestsKey,
    ([, , , agentId]) => fetchAgentPermissionRequests(agentId as string),
    { refreshInterval: 3_000, shouldRetryOnError: false }
  )
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)

  const decideApproval = async (request: AgentPermissionRequestDto, decision: 'allow' | 'deny') => {
    if (approvalBusy || request.status !== 'pending') return
    setApprovalBusy(`${request.id}:${decision}`)
    setApprovalError(null)
    try {
      await decideAgentPermissionRequest(id, request.id, decision)
      void mutateApprovalRequests(
        (rows) =>
          rows?.map((row) =>
            row.id === request.id
              ? {
                  ...row,
                  status: decision === 'allow' ? ('allowed' as const) : ('denied' as const),
                  resolvedAt: new Date().toISOString()
                }
              : row
          ),
        { revalidate: false }
      )
    } catch {
      setApprovalError('This approval request could not be updated. Try again.')
      void mutateApprovalRequests()
    } finally {
      setApprovalBusy(null)
    }
  }
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
  // GitHub subscriptions render as ONE "GitHub" group with a row per watched
  // repo (design); webhooks stay flat rows.
  const webhookHooks = agentHooks.filter((h) => h.kind !== 'github')
  const githubHooks = agentHooks.filter((h) => h.kind === 'github')
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

  const [reviewSettingsDraft, setReviewSettingsDraft] = useState<GithubReviewSettingsDraft | null>(null)
  const [reviewSettingsSaving, setReviewSettingsSaving] = useState(false)
  const [reviewSettingsError, setReviewSettingsError] = useState<string | null>(null)
  const reviewSettingsHook = reviewSettingsDraft
    ? githubHooks.find((hook) => hook.id === reviewSettingsDraft.hookId)
    : undefined
  const reviewSettingsRepoAccess = effectiveRepoAccess({
    repoId: reviewSettingsHook?.repoId,
    repoFullName: reviewSettingsHook?.repoFullName,
    workspace: wsForRepos ?? { mode: 'scratch' },
    authorizations: agentReposData ?? []
  })
  const reviewSettingsInstallation = installationForRepo(reviewSettingsHook?.repoFullName, githubInstallations)
  const reviewSettingsNeededAccess = reviewSettingsDraft ? requiredRepoAccess(reviewSettingsDraft) : 'none'
  const reviewSettingsBlocked =
    !repoAccessSatisfies(reviewSettingsRepoAccess, reviewSettingsNeededAccess) ||
    (reviewSettingsDraft?.reviewPolicy !== undefined &&
      reviewSettingsDraft.reviewPolicy !== 'off' &&
      !hasPullRequestsWritePermission(reviewSettingsInstallation)) ||
    (reviewSettingsDraft?.reportingMode === 'check' &&
      (!hasChecksWritePermission(reviewSettingsInstallation) ||
        !hasPullRequestsReadPermission(reviewSettingsInstallation)))

  const openReviewSettings = (hook: HookDto) => {
    setReviewSettingsError(null)
    setReviewSettingsDraft({
      hookId: hook.id,
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
    if (
      reviewSettingsSaving ||
      reviewSettingsBlocked ||
      !reviewSettingsDraft ||
      !reviewSettingsHook?.agentId ||
      !reviewSettingsHook.repoFullName
    ) {
      return
    }
    setReviewSettingsSaving(true)
    setReviewSettingsError(null)
    try {
      const updated = await updateGithubHook(reviewSettingsHook.id, {
        agentId: reviewSettingsHook.agentId,
        name: reviewSettingsHook.name,
        enabled: reviewSettingsHook.enabled,
        repoFullName: reviewSettingsHook.repoFullName,
        events: reviewSettingsHook.events,
        commentFamilies: reviewSettingsHook.commentFamilies,
        labelFilter: reviewSettingsHook.labelFilter,
        mentionOnly: reviewSettingsHook.mentionOnly,
        reviewPolicy: reviewSettingsDraft.reviewPolicy,
        reportingMode: reviewSettingsDraft.reportingMode,
        gateMode: 'informational'
      })
      void mutateHooks((rows) => rows?.map((row) => (row.id === reviewSettingsHook.id ? updated : row)), {
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
  // SWR row is patched — no full revalidation. Families and the "when
  // created/updated" cadence both ride the stored event patterns.
  const [hookBusy, setHookBusy] = useState<string | null>(null)
  const [hookCadenceFor, setHookCadenceFor] = useState<string | null>(null)
  // Viewport anchor for the cadence menu: it renders position:fixed so no
  // ancestor overflow-hidden (the group card, the Integrations card) clips it.
  const [cadenceAnchor, setCadenceAnchor] = useState<{ top: number; right: number } | null>(null)
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
  const toggleHookFam = async (h: HookDto, fam: GhFamily) => {
    const fams = GH_FAMILIES.map((f) => f.fam).filter((f) =>
      f === fam ? !famCovered(h.events, f) : famCovered(h.events, f)
    )
    if (fams.length === 0) return // at least one family must stay subscribed
    const mode = triggerModeOf(h)
    await saveHookEvents(h, fams, mode)
  }
  const setHookCadence = async (h: HookDto, mode: GhTriggerMode) => {
    setHookCadenceFor(null)
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

  const rawTab = params.get('tab')
  // Integrations is the default landing tab (first, no `?tab=`); everything else
  // is `?tab=<id>`.
  const tab: DetailTab =
    rawTab === 'config' || rawTab === 'workspace' || rawTab === 'memory' || rawTab === 'api' || rawTab === 'knowledge'
      ? rawTab
      : 'integrations'

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
  const ds = status(effectiveAgentStatus(da.status, owningDaemon?.status))
  const ws = da.workspace
  const wss = workspaceStatus(ws)
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
  // Tiles for the empty Integrations tab. Bot platforms are gated on the owning
  // daemon's advertised adapters — exactly what AddIntegrationModal enforces — so
  // a tile can never advertise a platform the modal would silently swap out. While
  // the daemon list is still loading, offer them all rather than flash a short list.
  // webhook/github are relay/CP-backed triggers: always offered.
  const offerableIntegrations: { key: Platform; label: string }[] = [
    ...(daemonsLoading ? BOT_PLATFORMS : BOT_PLATFORMS.filter((p) => owningDaemon?.caps.platforms.includes(p.key))),
    { key: 'webhook', label: 'Webhook' },
    { key: 'github', label: 'GitHub' }
  ]
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
  const sessionCount = getSessions(da.id).length
  // Icon upload is available only when the object store is configured (org flag) — the
  // picker hides Upload otherwise. On success the CP has persisted the new icon; refetch.
  const onUploadIcon = activeOrg?.iconUploadEnabled
    ? async (blob: Blob) => {
        await uploadAgentIcon(da.id, blob)
        refresh()
      }
    : undefined
  // `da.daemon` is the owning daemonId — resolve it to the daemon's display name
  // (never the raw UUID/host). Short id if the daemon isn't in the fleet; '—' if unplaced.
  const daemonLabel = owningDaemon?.name ?? (da.daemon.length > 12 ? da.daemon.slice(0, 8) : da.daemon)
  // Header + config Daemon row show "name · region"; region is a placeholder for
  // live agents, so only append it when we actually have one.
  const daemonLine = da.region && da.region !== '—' ? `${daemonLabel} · ${da.region}` : daemonLabel
  // Link the daemon references (header meta + General card) to the daemon's detail
  // page — but only when it's actually in the fleet, else the link would 404.
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
  const tabHref = (t: DetailTab) => (t === 'integrations' ? `/agents/${da.id}` : `/agents/${da.id}?tab=${t}`)

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
          size={48}
          radiusClass="rounded-[12px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-sans text-[20px] font-semibold leading-normal tracking-[-.02em]">
              {agentLabel(da)}
            </span>
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
            ['api', 'API'],
            ['knowledge', 'Knowledge & Tools']
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

      {/* Config tab — one grid: mobile stacks General → Workspace → Description →
          Visibility → Integrations → Env → Secrets → Approval requests (flex order).
          Desktop puts General + Workspace + Env + Secrets in the 340px left column
          and Approval requests at the bottom of the right column (the wrapper is
          display:contents on mobile so all the cards sit in the same flex column). */}
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
                      Daemon
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
                      Daemon
                    </span>
                    <span className="font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
                      {daemonLine}
                    </span>
                  </div>
                )}
                <div className="hidden items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3 desktop:flex">
                  <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                    Daemon
                  </span>
                  {owningDaemon ? (
                    <Link className="lnk font-mono text-[12.5px] font-medium leading-normal" href={daemonHref}>
                      {daemonLine}
                    </Link>
                  ) : (
                    <span className="mono text-[12.5px]">{daemonLine}</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
                  <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary) desktop:text-[13px]">
                    Runtime
                  </span>
                  <span className="inline-flex items-center gap-[7px] font-sans text-[12px] font-medium leading-normal desktop:text-[12.5px]">
                    {/* Mobile shows the bare mark; desktop the bordered imark chip. */}
                    <span className="inline-flex h-4 w-4 desktop:hidden">
                      <AgentMark model={da.runtime} />
                    </span>
                    <span className="imark hidden h-4 w-4 desktop:flex">
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
                        {agentPermissionDisplay(owningDaemon, da.runtime, da.permissionMode)}
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
            {/* Workspace card — the workspace-tab link row (both modes) plus the
                additional authorized repos for github-app workspaces; last card in the
                desktop left column, right after Runtime behavior on mobile. */}
            <WorkspaceCard agent={da} workspaceHref={tabHref('workspace')} className="order-3" />
          </div>

          <div className="contents desktop:flex desktop:min-w-0 desktop:flex-col desktop:gap-[18px]">
            {/* Description card (design): its own card at the top of the right column,
                and the ONE group edited on its own (EditDescriptionModal) rather than
                through the sectioned Edit-agent modal. Mobile order: Basics 1 → Runtime
                behavior 2 → Workspace 3 → Description 4 → Access 5 → Variables 6 →
                Secrets 7 → Approval requests 8. */}
            <div className="card order-4 overflow-hidden max-desktop:rounded-lg">
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
            <div className="card order-5 overflow-hidden max-desktop:rounded-lg">
              <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
                <span className="font-sans text-[14px] font-semibold leading-normal">Access</span>
                {!da.name.startsWith(MOCK_PREFIX) && da.canManageSharing && (
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
                  <VisibilityValue visibility={da.visibility} sharedWith={da.sharedWith} createdBy={da.createdBy} />
                </div>
              </div>
              <div className="border-t border-(--border-subtle) px-4 py-[14px]">
                <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-(--text-tertiary)">
                  Agent visibility
                </div>
                <div className="mt-3 grid grid-cols-1 gap-[18px] min-[440px]:grid-cols-2">
                  <AgentVisibilitySummary
                    direction="inbound"
                    mode={da.callPolicy}
                    effectiveIds={inboundEffectiveIds}
                    peers={agentPeers}
                  />
                  <AgentVisibilitySummary
                    direction="outbound"
                    mode={da.outboundPolicy}
                    effectiveIds={outboundEffectiveIds}
                    peers={agentPeers}
                  />
                </div>
              </div>
            </div>

            {/* Variables + Secrets (shared editable cards) — the design keeps these in
                the right column; each has its own inline add/edit affordances. */}
            <div className="order-6 min-w-0">
              <AgentEnvCard agent={da} />
            </div>
            <div className="order-7 min-w-0">
              <AgentSecretsCard agent={da} />
            </div>

            {da.canManageSharing && !da.name.startsWith(MOCK_PREFIX) && (
              <div className="card order-8 overflow-hidden max-desktop:rounded-lg">
                <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
                  <span className="font-sans text-[14px] font-semibold leading-normal">Approval requests</span>
                  {!!approvalRequests?.filter((request) => request.status === 'pending').length && (
                    <span className="badge bg-(--amber-50) text-(--amber-600)">
                      {approvalRequests.filter((request) => request.status === 'pending').length} pending
                    </span>
                  )}
                </div>
                {approvalRequestsLoading ? (
                  <div className="px-4 py-5 font-sans text-[13px] text-(--text-tertiary)">Loading requests…</div>
                ) : approvalRequestsError && approvalRequests === undefined ? (
                  <div className="px-4 py-5 font-sans text-[13px] text-(--text-tertiary)">
                    Approval requests are temporarily unavailable.
                  </div>
                ) : approvalRequests?.length ? (
                  <div>
                    {approvalRequests.map((request, index) => {
                      const allowBusy = approvalBusy === `${request.id}:allow`
                      const denyBusy = approvalBusy === `${request.id}:deny`
                      return (
                        <div
                          key={request.id}
                          className={`flex flex-col gap-3 px-4 py-3 desktop:flex-row desktop:items-center ${
                            index > 0 ? 'border-t border-(--border-subtle)' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                                {request.requesterName ?? request.requesterId ?? 'Unknown user'}
                              </span>
                              <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                                {formatApprovalTime(request.createdAt)}
                              </span>
                              {request.status !== 'pending' && (
                                <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                                  {request.status}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 break-words font-mono text-[12px] leading-[1.5] text-(--text-secondary)">
                              {request.command}
                            </div>
                          </div>
                          {request.status === 'pending' && (
                            <div className="flex flex-none items-center gap-2">
                              <Button
                                variant="secondary"
                                size="xs"
                                disabled={approvalBusy !== null}
                                onClick={() => void decideApproval(request, 'deny')}
                              >
                                {denyBusy ? 'Denying…' : 'Deny'}
                              </Button>
                              <Button
                                size="xs"
                                disabled={approvalBusy !== null}
                                onClick={() => void decideApproval(request, 'allow')}
                              >
                                {allowBusy ? 'Allowing…' : 'Allow'}
                              </Button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="px-4 py-5 font-sans text-[13px] text-(--text-tertiary)">
                    No approval requests yet.
                  </div>
                )}
                {approvalError && (
                  <div className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] text-(--red-600)">
                    {approvalError}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Integrations tab — moved out of Configuration into its own tab. */}
      {tab === 'integrations' && (
        <div className="flex flex-col gap-4 p-4 desktop:gap-[18px] desktop:p-0">
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
                        <span className="imark h-9 w-9 flex-none rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
                          <PlatformMark platform={g.platform} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                          <span className="font-sans text-[14px] font-semibold leading-normal">{g.name}</span>
                          {g.channels[0] && (
                            <span className="font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                              #{g.channels[0].name}
                            </span>
                          )}
                        </span>
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
                        shareable={g.shareable}
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
                </div>
                <div className="hidden flex-col gap-3 px-4 py-[14px] desktop:flex">
                  {agentInts.map((g, i) => (
                    <div key={i} className="overflow-hidden rounded-[9px] border border-(--border-subtle)">
                      <div className="flex items-center gap-3 px-[14px] py-3">
                        <span className="imark h-[34px] w-[34px] rounded-md">
                          <PlatformMark platform={g.platform} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-sans text-[13.5px] font-semibold leading-normal">{g.name}</span>
                            <span className="badge bg-(--brand-soft) text-(--brand-soft-text)">
                              <span className="dot h-[6px] w-[6px] bg-(--status-online)" />
                              connected
                            </span>
                            {g.shareable && (
                              <span
                                className="badge bg-(--surface-app) text-(--text-tertiary)"
                                title="Shared bot — used by multiple agents, inbound via a relay"
                              >
                                <Icon name="users" size={11} />
                                shared
                              </span>
                            )}
                          </div>
                        </div>
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
                        shareable={g.shareable}
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
                              <span className="inline-flex flex-none items-center gap-[5px]">
                                <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                                  when
                                </span>
                                <div className="relative">
                                  <button
                                    title={
                                      triggerModeOf(h) === 'mention'
                                        ? githubMentionUsage(da.name)
                                        : `Choose when this agent runs: when created (plus later @${da.name} mentions), on updates, or only when @${da.name} is mentioned.`
                                    }
                                    className={`flex h-[26px] cursor-pointer items-center gap-[5px] rounded-[7px] border bg-(--surface-card) px-[9px] font-sans text-[11.5px] font-medium leading-normal text-(--text-primary) transition-[background-color,border-color] hover:bg-(--surface-hover) ${
                                      hookCadenceFor === h.id
                                        ? 'border-(--brand)'
                                        : 'border-(--border-default) hover:border-(--border-strong)'
                                    } ${hookBusy === h.id ? 'pointer-events-none opacity-60' : ''}`}
                                    onClick={(e) => {
                                      if (hookCadenceFor === h.id) {
                                        setHookCadenceFor(null)
                                        return
                                      }
                                      const r = e.currentTarget.getBoundingClientRect()
                                      setCadenceAnchor({ top: r.bottom + 5, right: window.innerWidth - r.right })
                                      setHookCadenceFor(h.id)
                                    }}
                                  >
                                    {GH_TRIGGER_LABEL[triggerModeOf(h)]}
                                    <Icon name="chevron-down" size={12} color="var(--text-tertiary)" />
                                  </button>
                                  {hookCadenceFor === h.id && (
                                    <>
                                      <div className="fscrim" onClick={() => setHookCadenceFor(null)} />
                                      <div
                                        className="fmenu z-40 min-w-[130px] rounded-lg p-1 shadow-(--shadow-xl)"
                                        style={{
                                          position: 'fixed',
                                          left: 'auto',
                                          top: cadenceAnchor?.top,
                                          right: cadenceAnchor?.right
                                        }}
                                      >
                                        {GH_TRIGGER_MODES.map((mode) => (
                                          <button
                                            key={mode}
                                            title={mode === 'mention' ? githubMentionUsage(da.name) : undefined}
                                            className="fopt items-center gap-2 px-2 py-[7px]"
                                            onClick={() => void setHookCadence(h, mode)}
                                          >
                                            <span className="flex-1 text-left font-sans text-[12.5px] font-medium leading-normal">
                                              {GH_TRIGGER_LABEL[mode]}
                                            </span>
                                            {triggerModeOf(h) === mode && (
                                              <Icon name="check" size={14} color="var(--brand)" />
                                            )}
                                          </button>
                                        ))}
                                      </div>
                                    </>
                                  )}
                                </div>
                              </span>
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
                {/* Same tile anatomy as the Add-integration modal's platform grid
                    (ptile + 26px mark, stacked on desktop) so the two read as one
                    surface — one row across desktop. */}
                {/* Grid while narrow; one flex row on desktop — the tile count is
                    daemon-dependent, so equal flex beats a fixed column count. */}
                <div className="mt-4 grid grid-cols-2 gap-[10px] min-[440px]:grid-cols-3 desktop:flex desktop:flex-row">
                  {offerableIntegrations.map((p) => (
                    <div
                      key={p.key}
                      className="ptile cursor-pointer desktop:min-w-0 desktop:flex-1 desktop:flex-col desktop:justify-center desktop:gap-[6px] desktop:px-2 desktop:text-center"
                      title={INTEGRATION_BLURB[p.key]}
                      onClick={() => openModal('integration', da, { platform: p.key })}
                    >
                      {p.key === 'github' ? (
                        <span className="flex h-[26px] w-[26px] flex-none items-center justify-center [&>svg]:h-full [&>svg]:w-full">
                          <GithubMark />
                        </span>
                      ) : (
                        <span className="imark h-[26px] w-[26px] border-0 bg-transparent">
                          <PlatformMark platform={p.key} fillPct={100} />
                        </span>
                      )}
                      <span className="font-sans text-[13px] font-semibold leading-normal">{p.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Workspace tab. Live agents get the self-contained GitHub-style browser (its
          own repo card + tree + preview); demo (mocked-) agents keep the static
          two-card mock. Desktop-only pieces of the mock repo card (branch chip,
          commit line, actions footer) are CSS-gated. */}
      {tab === 'workspace' &&
        (!da.name.startsWith(MOCK_PREFIX) ? (
          <div className="p-4 desktop:p-0">
            <WorkspaceFiles agentId={id} workdir={da.workdir} />
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4 desktop:p-0">
            <div className="card overflow-hidden max-desktop:rounded-lg">
              <div className="flex flex-wrap items-center gap-[11px] px-4 py-[13px]">
                <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
                  {ws.mode === 'github' ? (
                    <span className="imark h-4 w-4 border-0 bg-transparent">
                      <GithubMark color="var(--text-secondary)" />
                    </span>
                  ) : (
                    <Icon name="folder" size={16} color="var(--text-tertiary)" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mono text-[13.5px] font-semibold text-(--text-primary)">
                      {ws.mode === 'github' ? ws.repo : 'Scratch workspace'}
                    </span>
                    {ws.mode === 'github' && (
                      <span className="mono hidden items-center gap-1 rounded-[5px] border border-(--border-subtle) bg-(--surface-sunken) px-[7px] py-px text-[11.5px] text-(--text-secondary) desktop:inline-flex">
                        <Icon name="git-branch" size={12} />
                        {ws.branch}
                      </span>
                    )}
                    <span className="mono text-[11.5px] text-(--text-tertiary)">{da.workdir}</span>
                  </div>
                  <div className="mono mt-1 hidden truncate text-[11.5px] text-(--text-tertiary) desktop:block">
                    {ws.mode === 'github' ? (
                      ws.commitMsg ? (
                        <>
                          pulled {ws.lastPull} · <span className="text-(--brand-soft-text)">{ws.commit}</span>{' '}
                          {ws.commitMsg} · {ws.commitTime}
                        </>
                      ) : (
                        <>pulled {ws.lastPull}</>
                      )
                    ) : (
                      <>
                        created {ws.created} · {ws.size} on disk
                      </>
                    )}
                  </div>
                </div>
                <span className="badge flex-none self-start" style={{ background: wss.bg, color: wss.text }}>
                  <span className="dot h-[6px] w-[6px]" style={{ background: wss.dot }} />
                  {wss.label}
                </span>
              </div>
              <div className="hidden items-center gap-2 border-t border-(--border-subtle) px-4 py-3 desktop:flex">
                {ws.mode === 'github' ? (
                  <>
                    <Button variant="secondary" size="sm">
                      <Icon name="refresh-cw" size={14} />
                      Pull latest
                    </Button>
                    <a
                      className="lnk text-[12px] text-(--text-tertiary)"
                      href={ws.repoUrl ?? `https://github.com/${ws.repo}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="external-link" size={13} />
                      View on GitHub
                    </a>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-[7px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                    <Icon name="info" size={14} />
                    Files here are created by the agent and live only on this machine — not version-controlled.
                  </span>
                )}
              </div>
            </div>

            <FileBrowserShell
              title="Files"
              headerEnd={<span className="mono text-[11px] text-(--text-tertiary)">{filesSummary}</span>}
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
          canEdit={!da.name.startsWith(MOCK_PREFIX)}
          memoryProvider={da.memoryProvider}
          autoDistill={da.memoryAutoDistill}
          memoryConnectionId={da.memoryConnectionId}
          memoryRecall={da.memoryRecall}
          memoryCaptureMode={da.memoryCaptureMode}
        />
      )}

      {/* API tab */}
      {tab === 'api' && <AgentApiPanel agentId={da.id} agentName={da.name} />}

      {/* Knowledge & Tools tab — leads with the daemon runtime's MCP servers (Tools),
          then the workspace-indexed knowledge below it. */}
      {tab === 'knowledge' && (
        <div className="flex flex-col gap-4 p-4 desktop:gap-[18px] desktop:p-0">
          <AgentToolsCard
            agentId={da.id}
            runtime={da.runtime}
            daemon={owningDaemon}
            canEdit={!da.name.startsWith(MOCK_PREFIX)}
          />
          <AgentSkillsCard agentId={da.id} canEdit={!da.name.startsWith(MOCK_PREFIX)} />
          <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
            <div className="flex items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:py-[13px]">
              <span className="font-sans text-[14px] font-semibold leading-normal">Loaded from workspace</span>
              <span className="mono text-[11px] text-(--text-tertiary)">on first clone &amp; each pull</span>
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
                <div className="px-4 py-[13px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:py-3">
                  Nothing indexed from the workspace yet.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-(--border-subtle) px-4 py-[13px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              <Icon name="info" size={14} />
              Plus everything in{' '}
              <Link className="lnk text-[12px]" href={orgPath('/knowledge')}>
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
            aria-labelledby="github-review-settings-title"
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[88vh] w-full flex-col rounded-t-xl bg-(--surface-card) shadow-[0_-8px_32px_rgba(0,0,0,.18)] desktop:max-w-[620px] desktop:rounded-xl desktop:shadow-(--shadow-xl)"
          >
            <div className="flex items-center gap-3 border-b border-(--border-subtle) px-4 py-[13px] desktop:px-5">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--surface-inverse)">
                <span className="flex h-[17px] w-[17px] items-center justify-center">
                  <GithubMark color="#fff" />
                </span>
              </span>
              <div className="min-w-0 flex-1">
                <div
                  id="github-review-settings-title"
                  className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)"
                >
                  PR review &amp; Checks
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
          </div>
        </div>
      )}
    </div>
  )
}

// Read-only per-direction agent-call summary for the Access card (design): the
// direction eyebrow + this agent's configured "All agents" / "Selected agents"
// state + an overlapping avatar stack of the peers that EFFECTIVELY have the
// edge. The stack is the reachability intersection (both directions' policies
// agree), NOT this agent's one-sided policy — so it never lists a peer as
// callable when the peer's own policy blocks the edge. Editing happens in the
// Edit-agent modal's Access section, so this never mutates.
function AgentVisibilitySummary({
  direction,
  mode,
  effectiveIds,
  peers
}: {
  direction: 'inbound' | 'outbound'
  mode: AgentCallPolicy
  effectiveIds: string[]
  peers: Agent[]
}) {
  const stack = effectiveIds.flatMap((id) => peers.find((p) => p.id === id) ?? [])
  const shown = stack.slice(0, 4)
  const extra = stack.length - shown.length
  return (
    <div className="min-w-0">
      <div className="mb-[6px] flex items-center gap-[6px]">
        <Icon
          name={direction === 'inbound' ? 'arrow-down-left' : 'arrow-up-right'}
          size={11}
          color="var(--text-tertiary)"
          className="flex-none"
        />
        <span className="font-sans text-[10.5px] font-semibold uppercase tracking-[.04em] text-(--text-tertiary)">
          {direction === 'inbound' ? 'Can call this agent' : 'This agent can call'}
        </span>
      </div>
      <div className="mb-2 flex items-center gap-2">
        <Icon name={mode === 'all' ? 'globe' : 'lock'} size={13} color="var(--text-tertiary)" className="flex-none" />
        <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
          {mode === 'all' ? 'All agents' : 'Selected agents'}
        </span>
      </div>
      {shown.length > 0 ? (
        <div className="inline-flex">
          {shown.map((p, i) => (
            <span
              key={p.id}
              title={agentLabel(p)}
              className={`flex h-6 w-6 items-center justify-center rounded-[6px] border-[1.5px] border-(--surface-card) bg-(--surface-sunken) shadow-(--shadow-xs) [&>svg]:h-full [&>svg]:w-full ${
                i > 0 ? '-ml-[6px]' : ''
              }`}
            >
              <AgentIconView icon={p.icon} runtime={p.runtime} size={24} />
            </span>
          ))}
          {extra > 0 && (
            <span className="-ml-[6px] flex h-6 w-6 items-center justify-center rounded-[6px] border-[1.5px] border-(--surface-card) bg-(--surface-active) font-sans text-[9px] font-semibold leading-normal text-(--text-secondary)">
              +{extra}
            </span>
          )}
        </div>
      ) : (
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {peers.length === 0
            ? 'No other agents'
            : direction === 'inbound'
              ? 'No agents can call it'
              : 'Can’t call any agent'}
        </span>
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
      title="This repo isn't authorized for the agent — events still trigger it, but replies and pushes back to GitHub have no credentials. Authorize the repo in the Workspace card."
    >
      <Icon name="triangle-alert" size={11} />
      write-back unauthorized
    </span>
  )
}

function formatApprovalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
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
