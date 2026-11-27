'use client'

import { SendButton } from '@/components/console/SendButton'
import { RuntimeModelSelect } from '@/components/console/RuntimeModelSelect'
import { modelEvaluationsTarget } from '@/components/console/decisions/ModelSelectionEvaluations'
import { useDecisionsPrototype } from '@/lib/decisions/provider'

// The chat-first console landing. A composer ("Ask an agent") is the primary
// posture; sending hands off to a live session (openPlayground → pgSend →
// /sessions/{id}), which IS the design's "the same page becomes the
// conversation". Below it the page answers "what happened / what's next / who
// do I ask": Recent sessions, Agents you use (ranked by 24h session count),
// and Scheduled runs.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useOrgs } from '@/lib/org-context'
import { useOnboardingRedirect } from '@/lib/use-onboarding-redirect'
import { useIsMobile } from '@/lib/use-is-mobile'
import { useConsoleData } from '@/lib/data-context'
import { useSessionList } from '@/lib/use-session-list'
import { unreadFirst } from '@/lib/use-mark-sessions-read'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { ComposerMenu } from '@/components/console/ComposerMenu'
import { MentionMenu, type MentionOption } from '@/components/console/MentionMenu'
import { useMentionAutocomplete } from '@/components/console/useMentionAutocomplete'
import { Card, CardLink, EmptyRow, RecentSessionsCard } from '@/components/console/RecentSessionsCard'
import {
  dashboardRowBudget,
  MAX_AGENT_ROWS,
  MAX_CRON_ROWS,
  MOBILE_SESSION_ROWS
} from '@/components/console/dashboard-rows'
import { Icon } from '@/components/ui'
import { AgentIconView, LoadingState, LogoMark, Spinner } from '@/components/marks'
import { clipboardFiles, prepareWebchatImage } from '@/lib/webchat-image'
import type { ComposerFile } from '@/lib/webchat-file'
import { uploadPreviewsCapable } from '@/lib/shared-file'
import {
  AttachmentCards,
  FileDropOverlay,
  INLINE_IMAGE_KEY,
  composerCards,
  stageComposerFiles,
  useFileDrop
} from '@/components/console/ComposerFiles'
import { useProfile } from '@/lib/profile'
import { featureFlagEnabled } from '@/lib/feature-flags'
import {
  agentCapabilitySource,
  agentDaemonLabel,
  agentLabel,
  agentPlacementKind,
  modelLabel,
  modelTooltip,
  agentModelDisplay,
  runtimeLabel,
  effectiveAgentStatus,
  preferredModelFor,
  modelCapability,
  effortChoicesFor,
  fastModeAvailableFor,
  displayedEffort,
  enrichSessionWithAgent,
  isGitWorkspace,
  MOCK_MODE,
  resolveEffortForModel,
  permissionModeChoicesFor,
  preselectedPermissionMode,
  resolvedPermissionMode,
  supportsModes,
  type Agent,
  type SessionImage
} from '@/lib/data'
import { agentSessionIsolationLabel } from '@/lib/session-isolation'
import { chatSettingsAllowed } from '@/lib/session-runtime-controls'
import { localizedPermissionChoices } from '@/lib/permission-mode-i18n'
import { cronNext, cronHuman, fmtNextRun } from '@/lib/cron'
import { useScheduleTimeZone } from '@/lib/schedule-timezone'
import { useDaemonDetail } from '@/lib/use-daemon-detail'
import { agentStrategyValue, HOST_STRATEGY, strategyModelSource, strategyUsesImage } from '@/lib/execution-strategy'
import { openCoordinatorConversation } from '@/lib/api'
import { opensCoordinator, prewarmAgentOnOpen, prewarmsOnOpen } from '@/components/console/playground/coordinator'

// Design composer selectors: agent/model are "pills" (rounded, with a leading
// mark), effort/permission are plain "chips". Full literal strings so Tailwind's
// scanner sees them (STYLE.md §8).
const CHIP =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'

// The fixed desktop heights and gutter match dashboard-rows.ts.
const DASH_CARD =
  'rounded-lg shadow-none [&>.cardhead]:min-h-[42px] [&>.cardhead]:border-(--surface-active) [&>.cardhead]:px-[14px] [&>.cardhead]:py-2 desktop:[&>.cardhead]:h-[42px] desktop:[&>.cardhead]:py-0'
const DASH_ROW =
  'relative min-h-14 border-b-0 px-[14px] py-2 after:pointer-events-none after:absolute after:inset-x-[14px] after:bottom-0 after:h-px after:bg-(--surface-active) last:after:hidden desktop:h-14 desktop:content-center desktop:py-0'
const RECENT_SCOPE_BUTTON = 'pill rounded-sm px-2 py-1 text-[12px]'
const SELECTED_RECENT_SCOPE_BUTTON = `${RECENT_SCOPE_BUTTON} on bg-(--surface-active) shadow-none`

type RecentScope = 'mine' | 'all'
const RECENT_SCOPE_KEY = 'ac.home.recent-scope'

// Observe the scroller and composer so the row budget follows the available height without feeding back into itself.
function useAvailableHeight(
  ref: RefObject<HTMLElement | null>,
  composerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  reflow: unknown
): number | null {
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) {
      setHeight(null)
      return
    }
    const el = ref.current
    const scroller = el?.closest<HTMLElement>('.content')
    if (!el || !scroller) return
    const measure = () => {
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const padBottom = parseFloat(getComputedStyle(scroller).paddingBottom) || 0
      setHeight(Math.max(0, scroller.clientHeight - top - padBottom))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scroller)
    if (composerRef.current) ro.observe(composerRef.current)
    return () => ro.disconnect()
  }, [ref, composerRef, enabled, reflow])
  return height
}

export default function HomeView() {
  const router = useRouter()
  const t = useTranslations('Home')
  const permissionT = useTranslations('Common.permissionModes')
  const locale = useLocale()
  const clock = useScheduleTimeZone()
  const { user, me } = useProfile()
  const firstName = user.name.trim().split(/\s+/)[0] ?? ''
  const { orgPath, activeOrg } = useOrgs()
  const { agents, daemons, crons, allSessions, usage24h, getAgent, loading, memberSets, orgSetIds } = useConsoleData()
  const { openPlayground, pgSend, pgSetModel, pgSetEffort, pgSetPermissionPreset, pgStageRuntime } = usePlayground()
  const formatAgo = (iso: string | null): string => {
    if (!iso) return t('time.never')
    const timestamp = Date.parse(iso)
    if (Number.isNaN(timestamp)) return t('time.never')
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
    if (seconds < 60) return t('time.justNow')
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return t('time.minutesAgo', { count: minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 24) return t('time.hoursAgo', { count: hours })
    return t('time.daysAgo', { count: Math.round(hours / 24) })
  }
  const hour = new Date().getHours()
  const greeting = hour < 12 ? t('greeting.morning') : hour < 18 ? t('greeting.afternoon') : t('greeting.evening')
  // Home is the default landing, so it owns the fresh-org bounce to /onboarding.
  const holdForOnboarding = useOnboardingRedirect()

  // An agent can take a session only when its owning daemon is serving AND that
  // runtime is signed in (its last probe wasn't rejected with ACP auth-required).
  const isOnline = (a: Agent) =>
    effectiveAgentStatus(
      a,
      daemons.find((d) => d.daemonId === a.daemon)
    ) === 'online'
  // Resolved through the PLACEMENT, not by daemon id: a pool or group agent names no member, so
  // looking one up found nothing and every such agent read as signed in (never blocked, never fixed).
  const authRequiredFor = (a: Agent) =>
    !!agentCapabilitySource(a, daemons, memberSets)?.runtimeModels.find((r) => r.runtime === a.runtime)?.authRequired
  // Only a strategy that starts the image's install can miss its binary: its own entry says so, else an older daemon's single reading.
  const imageBinaryMissingFor = (a: Agent) => {
    if (!strategyUsesImage(a.execution)) return false
    const rt = agentCapabilitySource(a, daemons, memberSets)?.runtimeModels.find((r) => r.runtime === a.runtime)
    const entry = rt?.strategies?.[a.execution]
    return entry ? !entry.available : rt?.unavailableReason === 'image-binary-missing'
  }
  const agentReady = (a: Agent) => isOnline(a) && !authRequiredFor(a) && !imageBinaryMissingFor(a)

  // Preferred default agent: the "agentconnect" preset when it's READY, else the
  // first READY one, else the preset, else the first. Readiness outranks the preset:
  // if the preset's daemon is offline/unsigned-in while another daemon serves ready
  // agents, defaulting to the preset would flash the blocked banner for a daemon the
  // user isn't even using (composer must default to something startable).
  // `memberSets` is an input because readiness reads it: agents, daemons and member sets are
  // independent reads, and until the last lands a group placement is deliberately read as the pool
  // — so a group agent can look ready here and settle as auth-blocked without a recompute.
  const preferred = useMemo(() => {
    const preset = agents.find((a) => a.name === 'agentconnect')
    return preset && agentReady(preset) ? preset : (agents.find(agentReady) ?? preset ?? agents[0])
  }, [agents, daemons, memberSets])
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const agent = agents.find((a) => a.id === agentId) ?? preferred
  const agentOnline = agent ? isOnline(agent) : false

  // Additional participants staged before the first send (webchat-multi-agents.md
  // §9.1): the composer is the assembly area, and the roster freezes at creation.
  // The primary is simply the first agent of the final list — no visible marker.
  const [memberIds, setMemberIds] = useState<string[]>([])
  const members = useMemo(
    () => memberIds.flatMap((mid) => (mid === agent?.id ? [] : (agents.filter((a) => a.id === mid) as Agent[]))),
    [memberIds, agents, agent?.id]
  )
  const multi = members.length > 0
  const removeMember = (mid: string) => setMemberIds((cur) => cur.filter((x) => x !== mid))
  // Removing the first chip promotes the next pick to primary — silently.
  const removePrimary = () => {
    const next = members[0]
    if (!next) return
    setAgentId(next.id)
    setMemberIds((cur) => cur.filter((x) => x !== next.id))
  }

  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // @mention picker (webchat-multi-agents.md §9.1): typing "@Name" and picking
  // it also stages that agent as a participant — the same effect as "+ add
  // agents" — and typedMentionIds() resolves the inserted text back into a
  // structural mention on send, so no extra state travels with the message.
  // Not memoized: cheap over a handful of agents, and it depends on
  // `agentReady`/`isOnline` closures that aren't worth tracking as deps —
  // matches `addOptions` below, which computes the same way.
  const mentionCandidates: MentionOption[] = agents.map((a) => {
    const inRoster = a.id === agent?.id || memberIds.includes(a.id)
    const ready = agentReady(a)
    return {
      id: a.id,
      name: agentLabel(a),
      icon: a.icon,
      runtime: a.runtime,
      inRoster,
      dimmed: !inRoster && !ready,
      description: inRoster
        ? undefined
        : ready
          ? t('composer.addToConversation')
          : !isOnline(a)
            ? t('composer.offlineDescription', { agent: agentLabel(a) })
            : t('composer.authDescription', { agent: agentLabel(a) })
    }
  })
  const mention = useMentionAutocomplete({
    ref: textareaRef,
    value: input,
    setValue: setInput,
    candidates: mentionCandidates,
    onPick: (candidate) => {
      if (candidate.inRoster) return
      setMemberIds((cur) => (cur.includes(candidate.id) ? cur : [...cur, candidate.id]))
    }
  })
  // One prepared image staged for the first turn (mirrors the session composer:
  // prepareWebchatImage bounds it to the wire's 160 KiB WebP budget).
  const [image, setImage] = useState<SessionImage | undefined>(undefined)
  const [imagePreparing, setImagePreparing] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  // Non-image files upload before the session exists: the presigned PUT needs only the agent.
  const [files, setFiles] = useState<ComposerFile[]>([])
  const filesUploading = files.some((f) => f.status !== 'ready')
  const readyFiles = files.flatMap((f) => (f.status === 'ready' && f.attachment ? [f.attachment] : []))
  // Which selector menu is open (only one at a time), and the run-runtime overrides.
  const [menu, setMenu] = useState<'agent' | 'model' | 'add' | 'attach' | null>(null)
  const [runtime, setRuntime] = useState<{
    runtime?: string
    model?: string
    effort?: string
    permissionPreset?: string
    fastMode?: boolean
  }>({})
  const [worktreeOverride, setWorktreeOverride] = useState<boolean>()
  const gitWorkspace = agent?.workspace && isGitWorkspace(agent.workspace) ? agent.workspace : undefined
  const defaultWorktree = gitWorkspace?.worktree === true
  const worktree = worktreeOverride ?? defaultWorktree
  // What that toggle is CALLED follows the agent's effective boundary, not its stored sandbox flag (git-workspace-model.md §11).
  const isolationLabel = agentSessionIsolationLabel(agent ?? { execution: HOST_STRATEGY }, orgSetIds)
  const isolationMode =
    isolationLabel.mode === 'Session isolation' ? t('composer.sessionIsolation') : t('composer.worktree')

  // Overrides are per-agent; drop them when the agent changes so the new agent's
  // own defaults show through.
  useEffect(() => {
    setRuntime({})
    setWorktreeOverride(undefined)
    // Uploads were reserved through the previous agent's daemon, which the new one may not share.
    setFiles([])
  }, [agent?.id])

  // What the selected agent RUNS ON supplies the model catalog + defaults — resolved through the
  // placement, so a pool or group agent reads its set's real catalog instead of the static tables.
  // The model catalogs live on the single-daemon read; until it lands this is the fleet row.
  const owningDaemon = useDaemonDetail(agent ? agentCapabilitySource(agent, daemons, memberSets) : undefined)
  // What to CALL it, and where to send the reader: a set is named and opened as itself, never as
  // the member standing in for it — a pool member is a Pod that no longer exists after a roll.
  const placementKind = agent ? agentPlacementKind(agent, memberSets) : undefined
  // Models come from the catalog of the agent's strategy: the host install's for host and srt, the image's for a VM.
  const modelSource =
    owningDaemon &&
    strategyModelSource(owningDaemon, agent && placementKind !== 'pool' ? agentStrategyValue(agent) : undefined)
  const placementLabel = agent ? agentDaemonLabel(agent, daemons, memberSets) : '—'
  const placementName = placementLabel === '—' ? '' : placementLabel
  // Existing pool placements fall back to the Infra list when the pool page is hidden.
  const placementHref =
    placementKind === 'pool'
      ? orgPath(featureFlagEnabled('daemon-pool') ? '/daemons/cluster' : '/daemons')
      : placementKind === 'group' && agent?.setId
        ? orgPath(`/daemons/groups/${agent.setId}`)
        : owningDaemon
          ? orgPath(`/daemons/${owningDaemon.daemonId}`)
          : null
  const { decisions } = useDecisionsPrototype()
  const selectedRuntime = runtime.runtime ?? agent?.runtime ?? ''
  const runtimeChangesAllowed = chatSettingsAllowed(agent)
  const byDecision = !!agent?.modelSelection && !runtime.model && !runtime.runtime
  const selectedDecision = decisions.find((item) => item.id === agent?.modelSelection?.decisionId)
  const runtimeProfile = modelSource?.runtimeModels.find((r) => r.runtime === selectedRuntime)
  const models = runtimeProfile?.models ?? []
  const modelCatalog = runtimeProfile?.modelCatalog ?? undefined

  // Effective model = explicit override, else the agent's stored model when the daemon
  // still advertises it, else the daemon's RESOLVED default (preferredModelFor). We stage
  // this on send, so the pill's label is exactly the model the turn runs — not a display
  // that silently differs from the daemon default for a blank/stale stored model.
  const defaultModel =
    agent && selectedRuntime === agent.runtime && models.includes(agent.model)
      ? agent.model
      : preferredModelFor(modelSource, selectedRuntime) || agent?.model || ''
  const model = runtime.model ?? defaultModel
  const modelChoices = (models.length ? models : model ? [model] : []).map((m) => {
    const description = agent ? modelTooltip(owningDaemon, selectedRuntime, m) : undefined
    return { value: m, label: modelLabel(m), ...(description ? { description } : {}) }
  })

  // Effort + permission come from the SELECTED model's discovered capability / the
  // runtime catalog — the same catalog-aware helpers the session and add/edit controls
  // use — not the static tables. So a runtime with no such vocabulary (e.g. opencode)
  // shows no effort/permission control instead of Claude-style values it doesn't accept.
  const capability = agent ? modelCapability(owningDaemon, selectedRuntime, model) : undefined
  const effortList = agent ? effortChoicesFor(selectedRuntime, capability) : []
  const showEffort = capability?.efforts ? effortList.length > 0 : agent ? supportsModes(selectedRuntime) : false
  // Resolve the raw effort (override → agent default) against the SELECTED model's
  // offered levels, so the shown value is always one send can stage — never a phantom
  // the new model doesn't offer (e.g. keeping `xhigh` after switching to a low/medium
  // model), and never a blank that displays as `options[0]` while send skips staging.
  // Precedence: resolved raw value → the vocabulary's Default sentinel / model default
  // → the first offered level. So the pill's level is ALWAYS exactly what send stages,
  // even for phase-2 catalog entries that carry efforts but no `defaultEffort`. Also
  // makes a model change auto-correct effort without a special reset.
  const rawEffort = runtime.effort ?? agent?.reasoning ?? ''
  const effort =
    agent && showEffort
      ? resolveEffortForModel(selectedRuntime, capability, rawEffort) ||
        displayedEffort('', effortList, capability?.defaultEffort) ||
        effortList[0]?.value ||
        ''
      : ''
  const effortChoices = effortList.map((o) => ({ value: o.value, label: o.label, description: o.description }))

  const permissionList = agent ? permissionModeChoicesFor(selectedRuntime, modelCatalog) : []
  const showPermission = agent ? !!modelCatalog?.permissionModes?.length || supportsModes(selectedRuntime) : false
  // Another runtime than the agent's preselects its auto mode, else full access, else its default.
  const permissionMode = !showPermission
    ? ''
    : selectedRuntime !== agent?.runtime
      ? preselectedPermissionMode(selectedRuntime, permissionList, modelCatalog)
      : resolvedPermissionMode(agent?.permissionMode ?? '', permissionList, modelCatalog)
  const permissionPreset = runtime.permissionPreset ?? permissionMode
  const permissionChoices = localizedPermissionChoices(permissionList, permissionT)

  // Why the composer can't start a session for the selected agent (null ⇒ it can).
  const executionAgent = agent && runtime.runtime ? { ...agent, runtime: runtime.runtime, model } : agent
  const blocked: 'offline' | 'auth' | 'image' | null = !agent
    ? null
    : !agentOnline
      ? 'offline'
      : imageBinaryMissingFor(executionAgent!)
        ? 'image'
        : authRequiredFor(executionAgent!)
          ? 'auth'
          : null
  // A multi-agent create needs every roster pick startable — the "+" menu only
  // OFFERS ready agents, but the @mention picker (unlike it) also lists unready
  // ones dimmed (so a typed name still resolves to a real candidate), and
  // readiness can change mid-compose regardless of how a member was added.
  const canSend = !!agent && blocked === null && members.every(agentReady)
  const notReadyMember = members.find((m) => !agentReady(m))
  // auto-session-mode.md §10: one agent opens the member's private coordinator with it, which follows the agent's own settings.
  const coordinated = !multi && !!agent && !MOCK_MODE && opensCoordinator(agent, daemons, memberSets)
  // auto-session-mode.md §4.9: the agent's pod and the member's coordinator start while they compose.
  // Keyed on the id alone, so a refetch that only renews the agent row asks nothing again.
  const prewarmAgentId = coordinated && agent && prewarmsOnOpen(agent, orgSetIds) ? agent.id : undefined
  useEffect(() => {
    if (prewarmAgentId) prewarmAgentOnOpen(prewarmAgentId)
  }, [prewarmAgentId])

  const onImageFile = async (file: File | undefined): Promise<void> => {
    if (!file || imagePreparing) return
    setMenu(null)
    setImagePreparing(true)
    setImageError(null)
    try {
      setImage(await prepareWebchatImage(file))
    } catch (error) {
      setImageError(error instanceof Error ? error.message : t('composer.imageError'))
    } finally {
      setImagePreparing(false)
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  const onAttachFiles = (selected: File[]): void => {
    if (imageInputRef.current) imageInputRef.current.value = ''
    if (!selected.length || !agent) return
    const transfer = uploadPreviewsCapable(agentCapabilitySource(agent, daemons, memberSets)?.caps?.features)
    if (!transfer) {
      if (selected.length === 1 && selected[0]!.type.startsWith('image/')) return void onImageFile(selected[0])
      setImageError(
        'This conversation accepts one image attachment. Documents and multiple attachments aren’t supported here.'
      )
      return
    }
    if (image) {
      setImageError('Remove the inline image before adding uploaded files.')
      return
    }
    setMenu(null)
    stageComposerFiles(
      {
        sessionId: '',
        agentId: agent.id,
        transfer,
        getPgFiles: () => files,
        setPgFiles: (_id, update) => setFiles(update),
        onError: setImageError
      },
      selected
    )
    if (imageInputRef.current) imageInputRef.current.value = ''
  }
  const fileDrop = useFileDrop(onAttachFiles)

  const clearComposer = (): void => {
    setInput('')
    mention.close()
    setImage(undefined)
    setFiles([])
    setImageError(null)
  }

  /** The message goes to the member's coordinator conversation, opened on its session once it has one; a refused mint falls back to a session of its own. */
  const sendToCoordinator = async (
    target: Agent,
    orgId: string,
    text: string,
    attached: SessionImage | undefined,
    uploaded: typeof readyFiles
  ): Promise<void> => {
    const entry = await openCoordinatorConversation(orgId, target.id).catch(() => undefined)
    const id =
      entry?.sessionId ??
      openPlayground(target, undefined, entry ? { conversationId: entry.conversationId, coordinator: true } : undefined)
    pgSend(id, target.id, text, entry?.conversationId, undefined, attached, undefined, uploaded)
    router.push(orgPath(`/sessions/${id}`))
  }

  const send = () => {
    const text = input.trim()
    if ((!text && !image && !readyFiles.length) || imagePreparing || filesUploading || mention.joining) return
    if (!agent || !canSend) return // offline / unsigned-in agents can't take a session
    if (coordinated && activeOrg) {
      void sendToCoordinator(agent, activeOrg.id, text, image, readyFiles)
      clearComposer()
      return
    }
    const id = openPlayground(agent, members, !multi && gitWorkspace ? { worktree } : undefined)
    // Stage the EFFECTIVE (displayed) runtime before the turn — not just explicit
    // overrides — so the session runs exactly what the composer showed. stageRuntimeChange
    // is a synchronous ref write, so pgSend's payload picks it up (PlaygroundProvider).
    // Multi-agent conversations expose no runtime controls: every participant
    // runs its configured defaults (webchat-multi-agents.md §9.1).
    if (!multi && runtimeChangesAllowed) {
      if (!byDecision && model) {
        if (runtime.runtime && runtime.runtime !== agent.runtime)
          pgStageRuntime(id, { runtime: runtime.runtime, model })
        else pgSetModel(id, agent.id, model)
      }
      if (runtime.fastMode !== undefined) pgStageRuntime(id, { fastMode: runtime.fastMode })
      if (effort && (!byDecision || runtime.effort)) pgSetEffort(id, agent.id, effort)
      if (permissionPreset && (!byDecision || runtime.permissionPreset))
        pgSetPermissionPreset(id, agent.id, permissionPreset)
    }
    // The image rides as an explicit argument: the session id was just minted, so
    // a setPgImage(id) state write could not land before this same-tick send.
    pgSend(id, agent.id, text, undefined, undefined, image, undefined, readyFiles)
    clearComposer()
    router.push(orgPath(`/sessions/${id}`))
  }

  const sessionsByAgent = useMemo(
    () => new Map((usage24h?.agents ?? []).map((u) => [u.agentId, u.sessions])),
    [usage24h]
  )
  const rankedAgents = useMemo(
    () => [...agents].sort((a, b) => (sessionsByAgent.get(b.id) ?? 0) - (sessionsByAgent.get(a.id) ?? 0)),
    [agents, sessionsByAgent]
  )
  // Recent opens on the member's own web chats: a channel session is already read where it happened.
  const [recentScope, setRecentScope] = useState<RecentScope>('mine')
  useEffect(() => {
    try {
      if (localStorage.getItem(RECENT_SCOPE_KEY) === 'all') setRecentScope('all')
    } catch {}
  }, [])
  const pickRecentScope = (scope: RecentScope) => {
    setRecentScope(scope)
    try {
      localStorage.setItem(RECENT_SCOPE_KEY, scope)
    } catch {}
  }
  const mine = recentScope === 'mine'
  // Recent leaves tasks and memory dream sessions out, as All sessions does; the shared window keeps them for lookups by id and search.
  const { sessions: recentRows, isLoading: recentRowsLoading } = useSessionList(MOCK_MODE ? null : activeOrg?.id, {
    excludeTasks: true,
    excludeDreams: true,
    ...(mine ? { platform: 'webchat', ...(me?.userId ? { triggeredBy: me.userId } : {}) } : {})
  })
  // ponytail: unread floats within the loaded page only; an `unread` list filter on the CP if one ever hides past row 50.
  const recentSessions = useMemo(
    () =>
      unreadFirst(
        MOCK_MODE
          ? allSessions.filter((s) => !s.subsession && s.platform !== 'dream' && (!mine || s.platform === 'webchat'))
          : recentRows.map((s) => enrichSessionWithAgent(s, s.agentId ? getAgent(s.agentId) : undefined))
      ),
    [allSessions, getAgent, mine, recentRows]
  )

  // How many rows each dashboard card draws — see `dashboard-rows.ts` for the identity
  // that makes the two columns end on the same line.
  const isMobile = useIsMobile()
  const gridRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  // Hold the dashboard while onboarding decides whether to redirect or the first load is empty.
  const dashboardHidden = holdForOnboarding || (loading && agents.length === 0 && recentSessions.length === 0)
  const availableHeight = useAvailableHeight(gridRef, composerRef, !isMobile && !dashboardHidden, blocked)
  const { sessionRows, agentRows, cronRows, aligned } = useMemo(
    () =>
      isMobile
        ? // Mobile stacks the three cards: nothing to align, plain content caps.
          {
            sessionRows: MOBILE_SESSION_ROWS,
            agentRows: MAX_AGENT_ROWS,
            cronRows: MAX_CRON_ROWS,
            aligned: false
          }
        : dashboardRowBudget({
            availableHeight,
            sessions: recentSessions.length,
            agents: rankedAgents.length,
            crons: crons.length
          }),
    [isMobile, availableHeight, recentSessions.length, rankedAgents.length, crons.length]
  )

  const topAgents = rankedAgents.slice(0, agentRows)
  const scheduled = crons.slice(0, cronRows)

  if (dashboardHidden) return <LoadingState fill />

  const agentOptions = agents.map((a) => {
    const ready = agentReady(a)
    const reason = !isOnline(a)
      ? t('composer.offlineDescription', { agent: agentLabel(a) })
      : t('composer.authDescription', { agent: agentLabel(a) })
    return {
      value: a.id,
      label: agentLabel(a),
      dimmed: !ready,
      description: ready ? t('composer.pickAgent') : reason,
      leading: (
        <span className="relative flex-none">
          <span className="av h-[18px] w-[18px] rounded-xs">
            <AgentIconView icon={a.icon} runtime={a.runtime} size={18} />
          </span>
          {!ready && (
            <span
              className="dot absolute -right-[2px] -bottom-[2px] h-[7px] w-[7px] ring-2 ring-(--surface-card)"
              style={{ background: 'var(--status-error)' }}
            />
          )}
        </span>
      )
    }
  })

  // Agents addable as extra participants: everyone not already in the roster.
  // Only ready agents are selectable — a multi-agent create requires every
  // pick startable (and its daemon multi-agent capable; the CP enforces that).
  const rosterIds = new Set([agent?.id, ...memberIds])
  const addOptions = agents
    .filter((a) => !rosterIds.has(a.id))
    .map((a) => {
      const ready = agentReady(a)
      return {
        value: a.id,
        label: agentLabel(a),
        dimmed: !ready,
        description: ready
          ? t('composer.addToConversation')
          : !isOnline(a)
            ? t('composer.offlineDescription', { agent: agentLabel(a) })
            : imageBinaryMissingFor(a)
              ? t('composer.imageBinaryMissing')
              : t('composer.authDescription', { agent: agentLabel(a) }),
        leading: (
          <span className="av h-[18px] w-[18px] flex-none rounded-xs">
            <AgentIconView icon={a.icon} runtime={a.runtime} size={18} />
          </span>
        )
      }
    })

  return (
    <div
      {...(agent ? fileDrop.handlers : {})}
      className="wrap relative max-w-[1000px] max-desktop:px-4 max-desktop:pt-4 max-desktop:pb-6"
    >
      {agent && fileDrop.over ? <FileDropOverlay /> : null}
      <div className="mb-[18px] flex items-center justify-center gap-3 desktop:mb-[22px]">
        <span className="shrink-0">
          <LogoMark size={27} />
        </span>
        {/* The local greeting and name settle on the client. */}
        <h1
          className="ptitle min-w-0 text-center text-[23px] wrap-break-word desktop:text-[28px]"
          suppressHydrationWarning
        >
          {greeting}
          {firstName ? `, ${firstName}` : ''}
        </h1>
      </div>

      <div
        ref={composerRef}
        className="card mb-[18px] rounded-[14px] border-(--border-default) shadow-none transition-colors focus-within:border-(--brand)"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setMenu(null)
        }}
      >
        <input
          ref={imageInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => onAttachFiles(Array.from(event.target.files ?? []))}
        />
        <AttachmentCards
          className="px-[15px] pt-3"
          cards={composerCards(files, image)}
          onRemove={(key) =>
            key === INLINE_IMAGE_KEY ? setImage(undefined) : setFiles((cur) => cur.filter((f) => f.key !== key))
          }
        />
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              mention.sync(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={(e) => {
              // Re-derives the anchor on every caret move, not just typing —
              // arrow keys/Home/End/a click can shift the caret without an
              // onChange, and a stale anchor would make the next pick replace
              // the wrong range (or stay open after the caret left the token).
              const el = e.currentTarget
              mention.sync(el.value, el.selectionStart ?? el.value.length)
            }}
            onPaste={(event) => {
              const selected = clipboardFiles(event.clipboardData)
              if (!selected.length) return
              event.preventDefault()
              onAttachFiles(selected)
            }}
            onKeyDown={(e) => {
              if (mention.handleKeyDown(e)) return
              // Enter sends, except during IME composition (candidate-confirming Enter)
              // or with Shift (newline).
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            rows={3}
            aria-label={t('composer.placeholder')}
            placeholder={t('composer.placeholder')}
            className="block field-sizing-content max-h-[220px] min-h-[82px] w-full resize-none border-0 bg-transparent px-4 pt-[14px] pb-1 font-sans text-[16px] leading-normal text-(--text-primary) outline-none placeholder:text-(--text-tertiary) desktop:text-[14px]"
          />
          <MentionMenu
            options={mention.matches}
            activeIndex={mention.activeIndex}
            coords={mention.coords}
            onHover={mention.setActiveIndex}
            onPick={mention.pick}
          />
        </div>
        {imageError && (
          <div className="px-[15px] pb-2 font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">
            {imageError}
          </div>
        )}
        <div className="relative flex items-end gap-[6px] px-[10px] pb-[9px]">
          <div className="relative flex-none self-start">
            <button
              type="button"
              className="flex size-[30px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-secondary)"
              aria-label={t('composer.attachFile')}
              aria-haspopup="menu"
              aria-expanded={menu === 'attach'}
              title={t('composer.attachFile')}
              disabled={imagePreparing}
              onClick={() => setMenu((cur) => (cur === 'attach' ? null : 'attach'))}
            >
              {imagePreparing ? <Spinner size={14} /> : <Icon name="paperclip" size={15} />}
            </button>
            {menu === 'attach' && (
              <>
                <div aria-hidden="true" className="fixed inset-0 z-40" onClick={() => setMenu(null)}></div>
                <div
                  role="menu"
                  className="absolute top-[calc(100%+8px)] left-0 z-50 w-[166px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="fopt"
                    onClick={() => {
                      setMenu(null)
                      imageInputRef.current?.click()
                    }}
                  >
                    <Icon name="paperclip" size={16} color="var(--text-secondary)" />
                    {t('composer.addFiles')}
                  </button>
                </div>
              </>
            )}
          </div>
          {/* Let the toolbar wrap and truncate a chip that is wider than the available space. */}
          <div className="flex min-h-[30px] min-w-0 flex-1 flex-wrap items-center gap-[6px]">
            {agent ? (
              <>
                {multi ? (
                  // Roster chips (webchat-multi-agents.md §9.1): every chip —
                  // including the first — is removable until the first send; the
                  // primary is silently re-derived as the first of the final list.
                  [agent, ...members].map((a, i) => (
                    <span
                      key={a.id}
                      className="inline-flex h-7 min-w-0 items-center gap-[7px] rounded-full bg-(--surface-hover) px-[10px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)"
                    >
                      <span className="av h-4 w-4 flex-none rounded-xs">
                        <AgentIconView icon={a.icon} runtime={a.runtime} size={16} />
                      </span>
                      <span className="truncate">{agentLabel(a)}</span>
                      <button
                        type="button"
                        aria-label={t('composer.removeAgent', { agent: agentLabel(a) })}
                        className="-mr-1 px-1 text-(--text-tertiary) hover:text-(--text-primary)"
                        onClick={() => (i === 0 ? removePrimary() : removeMember(a.id))}
                      >
                        ×
                      </button>
                    </span>
                  ))
                ) : (
                  <ComposerMenu
                    title={t('composer.agent')}
                    value={agent.id}
                    options={agentOptions}
                    searchable
                    searchPlaceholder={t('composer.searchAgents')}
                    open={menu === 'agent'}
                    align="left"
                    placement="down"
                    className="max-desktop:static"
                    triggerClassName="inline-flex h-[30px] items-center gap-[7px] rounded-sm px-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)"
                    leading={
                      <span className="av h-4 w-4 rounded-xs">
                        <AgentIconView icon={agent.icon} runtime={agent.runtime} size={16} />
                      </span>
                    }
                    onOpenChange={(o) => setMenu(o ? 'agent' : null)}
                    onChange={setAgentId}
                  />
                )}
                {addOptions.length > 0 && (
                  <ComposerMenu
                    title={t('composer.addAgents')}
                    value=""
                    options={addOptions}
                    searchable
                    searchPlaceholder={t('composer.searchAgents')}
                    iconOnly
                    open={menu === 'add'}
                    align="left"
                    placement="down"
                    className="max-desktop:static"
                    triggerClassName="inline-flex size-[30px] items-center justify-center rounded-sm font-sans leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                    tooltips={false}
                    leading={<Icon name="plus" size={14} />}
                    onOpenChange={(o) => setMenu(o ? 'add' : null)}
                    onChange={(v) => setMemberIds((cur) => (cur.includes(v) ? cur : [...cur, v]))}
                  />
                )}
                {!multi && !coordinated && (modelChoices.length > 0 || byDecision) && (
                  <RuntimeModelSelect
                    compact
                    readOnly={!runtimeChangesAllowed}
                    readsImage={strategyUsesImage(agent.execution)}
                    value={{ runtime: selectedRuntime, model }}
                    source={modelSource}
                    decision={
                      agent.modelSelection
                        ? {
                            name: selectedDecision?.name ?? t('composer.byDecision'),
                            selected: byDecision,
                            onSelect: () => setRuntime((current) => ({ fastMode: current.fastMode })),
                            selection: agent.modelSelection,
                            question: selectedDecision?.question,
                            fallback: { runtime: agent.runtime, model: defaultModel },
                            decisionHref:
                              selectedDecision && orgPath(`/decisions/${encodeURIComponent(selectedDecision.id)}`),
                            evaluations: modelEvaluationsTarget(agent)
                          }
                        : undefined
                    }
                    settings={{
                      effort:
                        showEffort && effortChoices.length > 0
                          ? {
                              value: effort,
                              options: effortChoices,
                              onChange: (v) => setRuntime((r) => ({ ...r, effort: v }))
                            }
                          : undefined,
                      approval:
                        showPermission && permissionChoices.length > 0
                          ? {
                              value: permissionPreset,
                              options: permissionChoices,
                              onChange: (v) => setRuntime((r) => ({ ...r, permissionPreset: v }))
                            }
                          : undefined,
                      fast: fastModeAvailableFor(selectedRuntime, capability)
                        ? {
                            value: runtime.fastMode ?? agent.fastMode,
                            onChange: (fastMode) => setRuntime((current) => ({ ...current, fastMode }))
                          }
                        : undefined
                    }}
                    onChange={(target) => setRuntime({ ...target, fastMode: runtime.fastMode })}
                  />
                )}
                {!multi && !coordinated && gitWorkspace && (
                  <label className={`${CHIP} min-w-0 cursor-pointer`}>
                    <input
                      type="checkbox"
                      checked={worktree}
                      onChange={(event) => setWorktreeOverride(event.target.checked)}
                      className="h-4 w-4 flex-none accent-(--brand)"
                    />
                    <span className="truncate">{isolationMode}</span>
                  </label>
                )}
              </>
            ) : (
              <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)">
                {t('composer.noAgents')}
              </span>
            )}
          </div>
          <SendButton
            className="h-[30px] w-[30px] [&>span]:size-[30px] [&>span]:rounded-sm disabled:[&>span]:bg-(--surface-active) disabled:[&>span]:text-(--text-tertiary) [&_svg]:size-[14px]"
            label={t('composer.send')}
            disabled={
              (!input.trim() && !image && !readyFiles.length) ||
              !canSend ||
              imagePreparing ||
              filesUploading ||
              mention.joining
            }
            onClick={send}
            title={
              blocked === 'offline'
                ? t('composer.offlineSend', { agent: agentLabel(agent!) })
                : blocked === 'image'
                  ? t('composer.imageBinaryMissing')
                  : blocked === 'auth'
                    ? t('composer.authSend', { placement: placementName || t('composer.theDaemon') })
                    : notReadyMember
                      ? !isOnline(notReadyMember)
                        ? t('composer.offlineSend', { agent: agentLabel(notReadyMember) })
                        : imageBinaryMissingFor(notReadyMember)
                          ? t('composer.imageBinaryMissing')
                          : t('composer.authMemberSend', { agent: agentLabel(notReadyMember) })
                      : t('composer.send')
            }
          />
        </div>
      </div>

      {/* Why the selected agent can't take a session (state-driven, per agent):
          offline ⇒ its daemon isn't serving; auth ⇒ online but the daemon's runtime
          reported "sign-in required" (no active AI subscription/login). */}
      {!loading && blocked && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-(--status-paused-soft) bg-(--status-paused-soft) px-4 py-[10px]">
          <Icon name="triangle-exclamation-point" size={16} color="var(--status-paused)" />
          <span className="min-w-0 flex-1 font-sans text-[13px] leading-normal text-(--text-secondary)">
            {blocked === 'offline' ? (
              <>
                <span className="font-semibold">{agentLabel(agent!)}</span>
                {t('blocked.offlineSuffix')}
              </>
            ) : blocked === 'image' ? (
              t('composer.imageBinaryMissing')
            ) : (
              <>
                {t('blocked.authPrefix')}
                {placementName ? (
                  <>
                    {t('blocked.on')}
                    <span className="font-semibold">{placementName}</span>
                  </>
                ) : null}
                {t('blocked.authSuffix')}
              </>
            )}
          </span>
          {placementHref && (
            <button
              type="button"
              className="flex-none font-sans text-[13px] font-semibold leading-normal text-(--text-brand) hover:underline"
              onClick={() => router.push(placementHref)}
            >
              {blocked === 'auth'
                ? t('blocked.fix')
                : placementKind === 'daemon'
                  ? t('blocked.viewDaemon')
                  : t('blocked.viewInfra')}
            </button>
          )}
        </div>
      )}

      <div ref={gridRef} className="grid grid-cols-1 gap-3 desktop:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <RecentSessionsCard
          sessions={recentSessions}
          loading={loading || recentRowsLoading}
          allHref={orgPath('/sessions')}
          emptyText={t('dashboard.noSessions')}
          limit={sessionRows}
          rowClassName={DASH_ROW}
          className={`${DASH_CARD} ${aligned ? '' : 'desktop:self-start'}`}
          replyPreview
          tabs={
            <span className="pillbar flex-none border-0 bg-transparent p-0">
              <button
                type="button"
                aria-pressed={mine}
                className={mine ? SELECTED_RECENT_SCOPE_BUTTON : RECENT_SCOPE_BUTTON}
                onClick={() => pickRecentScope('mine')}
              >
                {t('dashboard.scopeMine')}
              </button>
              <button
                type="button"
                aria-pressed={!mine}
                className={mine ? RECENT_SCOPE_BUTTON : SELECTED_RECENT_SCOPE_BUTTON}
                onClick={() => pickRecentScope('all')}
              >
                {t('dashboard.scopeAll')}
              </button>
            </span>
          }
        />

        <div className="flex min-w-0 flex-col gap-3">
          <Card
            title={t('dashboard.agentsTitle')}
            action={<CardLink href={orgPath('/agents')}>{t('dashboard.allAgents')}</CardLink>}
            className={DASH_CARD}
          >
            {topAgents.length === 0 ? (
              <EmptyRow className={DASH_ROW}>{t('dashboard.noAgents')}</EmptyRow>
            ) : (
              topAgents.map((a) => {
                const ready = agentReady(a)
                return (
                  <Link
                    key={a.id}
                    href={orgPath(`/agents/${a.id}`)}
                    title={agentLabel(a)}
                    className={`row click grid-cols-[auto_1fr_auto] gap-3 ${DASH_ROW} ${ready ? '' : 'opacity-60'}`}
                  >
                    <span className="av size-[26px] rounded-md">
                      <AgentIconView icon={a.icon} runtime={a.runtime} size={26} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                        {agentLabel(a)}
                      </span>
                      <span className="mt-[3px] block truncate text-[12px] leading-normal text-(--text-tertiary)">
                        {runtimeLabel(a.runtime)} ·{' '}
                        {agentModelDisplay(agentCapabilitySource(a, daemons, memberSets), a.runtime, a.model)}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-[12px] text-(--text-tertiary) tabular-nums">
                      {sessionsByAgent.get(a.id) ?? 0}
                    </span>
                  </Link>
                )
              })
            )}
          </Card>

          <Card
            title={t('dashboard.schedulesTitle')}
            action={<CardLink href={orgPath('/crons')}>{t('dashboard.allSchedules')}</CardLink>}
            className={DASH_CARD}
          >
            {scheduled.length === 0 ? (
              <EmptyRow className={DASH_ROW}>{t('dashboard.noSchedules')}</EmptyRow>
            ) : (
              scheduled.map((c) => {
                const owner = c.agentId ? getAgent(c.agentId) : undefined
                const nextRun =
                  c.enabled && clock.ready
                    ? fmtNextRun(cronNext(c.schedule, c.timezone), clock.zoneFor(c.timezone))
                    : '—'
                return (
                  <Link
                    key={c.id}
                    href={orgPath(`/crons/${c.id}`)}
                    className={`row click grid-cols-[1fr_auto] gap-3 ${DASH_ROW}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                        {c.name || cronHuman(c.schedule, locale) || c.schedule}
                      </span>
                      <span className="mono mt-[3px] block truncate text-[11px] text-(--text-tertiary)">
                        {owner ? agentLabel(owner) : '—'} · {t('dashboard.ran')}{' '}
                        {clock.ready ? formatAgo(c.lastRunAt) : '—'}
                      </span>
                    </span>
                    <span className="mono self-start whitespace-nowrap text-[11.5px] text-(--text-secondary)">
                      {c.enabled ? nextRun : t('dashboard.paused')}
                    </span>
                  </Link>
                )
              })
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
