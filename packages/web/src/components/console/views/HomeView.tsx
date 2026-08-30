'use client'

// The chat-first console landing. A composer ("Ask an agent") is the primary
// posture; sending hands off to a live session (openPlayground → pgSend →
// /sessions/{id}), which IS the design's "the same page becomes the
// conversation". Below it the page answers "what happened / what's next / who
// do I ask": Recent sessions, Agents you use (ranked by 24h session count),
// and Scheduled runs.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useOrgs } from '@/lib/org-context'
import { useOnboardingRedirect } from '@/lib/use-onboarding-redirect'
import { useIsMobile } from '@/lib/use-is-mobile'
import { useConsoleData } from '@/lib/data-context'
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
import { AgentIconView, ModelMark, LoadingState, LogoMark, Spinner } from '@/components/marks'
import { clipboardImageFile, prepareWebchatImage } from '@/lib/webchat-image'
import { useProfile } from '@/lib/profile'
import { featureFlagEnabled, type FeatureFlagId } from '@/lib/feature-flags'
import {
  agentCapabilitySource,
  agentDaemonLabel,
  agentLabel,
  agentPlacementKind,
  modelLabel,
  agentModelDisplay,
  runtimeLabel,
  effectiveAgentStatus,
  preferredModelFor,
  modelCapability,
  effortChoicesFor,
  displayedEffort,
  isGitWorkspace,
  resolveEffortForModel,
  permissionModeChoicesFor,
  resolvedPermissionMode,
  supportsModes,
  type Agent,
  type SessionImage
} from '@/lib/data'
import { cronNext, cronHuman, fmtNextRun } from '@/lib/cron'
import { useDaemonDetail } from '@/lib/use-daemon-detail'

// Design composer selectors: agent/model are "pills" (rounded, with a leading
// mark), effort/permission are plain "chips". Full literal strings so Tailwind's
// scanner sees them (STYLE.md §8).
const CHIP =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'

// The literal Tailwind spelling of DASH_ROW_H (`.row` is a components-layer class, so
// these utilities win). `content-center` centres the row's single grid track inside the
// taller box instead of stretching it, which is what keeps a cell's `self-start` (the
// timestamp / next-run column) riding the title line rather than the row's top edge.
// Desktop only: the mobile layer stacks the cards, so there is nothing to align there
// and rows keep their natural height.
const DASH_ROW = 'desktop:h-[63px] desktop:content-center desktop:py-0'

// Leftover height under the composer, measured against the SCROLL CONTAINER — never
// against the dashboard's own box, so a taller grid can't feed back into the row
// count and oscillate. Returns null when it can't/shouldn't cap (mobile, no scroller).
function useAvailableHeight(ref: RefObject<HTMLElement | null>, enabled: boolean, reflow: unknown): number | null {
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
    return () => ro.disconnect()
  }, [ref, enabled, reflow])
  return height
}

// Relative "…ago" for a cron's last run. fmtNextRun covers the future side;
// this is the (missing) past side. Coarse buckets are all a dashboard needs.
function fmtAgo(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'never'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export default function HomeView() {
  const router = useRouter()
  const { user } = useProfile()
  const firstName = user.name.trim().split(/\s+/)[0] ?? ''
  const { orgPath } = useOrgs()
  const { agents, daemons, crons, allSessions, usage24h, getAgent, loading, memberSets } = useConsoleData()
  const { openPlayground, pgSend, pgSetModel, pgSetEffort, pgSetPermissionPreset } = usePlayground()
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
  const agentReady = (a: Agent) => isOnline(a) && !authRequiredFor(a)

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
          ? 'Add to this conversation'
          : !isOnline(a)
            ? `${agentLabel(a)} is offline — its daemon isn't serving`
            : `${agentLabel(a)} has no AI runtime signed in`
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
  // Which selector menu is open (only one at a time), and the run-runtime overrides.
  const [menu, setMenu] = useState<'agent' | 'model' | 'effort' | 'permission' | 'add' | 'attach' | null>(null)
  const [runtime, setRuntime] = useState<{ model?: string; effort?: string; permissionPreset?: string }>({})
  const [worktreeOverride, setWorktreeOverride] = useState<boolean>()
  const gitWorkspace = agent?.workspace && isGitWorkspace(agent.workspace) ? agent.workspace : undefined
  const defaultWorktree = gitWorkspace?.worktree === true
  const worktree = worktreeOverride ?? defaultWorktree

  // Overrides are per-agent; drop them when the agent changes so the new agent's
  // own defaults show through.
  useEffect(() => {
    setRuntime({})
    setWorktreeOverride(undefined)
  }, [agent?.id])

  // What the selected agent RUNS ON supplies the model catalog + defaults — resolved through the
  // placement, so a pool or group agent reads its set's real catalog instead of the static tables.
  // The model catalogs live on the single-daemon read; until it lands this is the fleet row.
  const owningDaemon = useDaemonDetail(agent ? agentCapabilitySource(agent, daemons, memberSets) : undefined)
  // What to CALL it, and where to send the reader: a set is named and opened as itself, never as
  // the member standing in for it — a pool member is a Pod that no longer exists after a roll.
  const placementKind = agent ? agentPlacementKind(agent, memberSets) : undefined
  const placementLabel = agent ? agentDaemonLabel(agent, daemons, memberSets) : '—'
  const placementName = placementLabel === '—' ? '' : placementLabel
  // A set target's own page exists only where the deployment offers that surface — both return
  // NotFound behind their flag, while a placement made before the flag went off is still named
  // here. Send those to the Infra list rather than to a dead end.
  const setHref = (flag: FeatureFlagId, path: string) => orgPath(featureFlagEnabled(flag) ? path : '/daemons')
  const placementHref =
    placementKind === 'pool'
      ? setHref('daemon-pool', '/daemons/cluster')
      : placementKind === 'group' && agent?.setId
        ? setHref('daemon-groups', `/daemons/groups/${agent.setId}`)
        : owningDaemon
          ? orgPath(`/daemons/${owningDaemon.daemonId}`)
          : null
  const runtimeProfile = owningDaemon?.runtimeModels.find((r) => r.runtime === agent?.runtime)
  const models = runtimeProfile?.models ?? []
  const modelCatalog = runtimeProfile?.modelCatalog ?? undefined

  // Effective model = explicit override, else the agent's stored model when the daemon
  // still advertises it, else the daemon's RESOLVED default (preferredModelFor). We stage
  // this on send, so the pill's label is exactly the model the turn runs — not a display
  // that silently differs from the daemon default for a blank/stale stored model.
  const defaultModel =
    agent && models.includes(agent.model)
      ? agent.model
      : preferredModelFor(owningDaemon, agent?.runtime ?? '') || agent?.model || ''
  const model = runtime.model ?? defaultModel
  const modelChoices = (models.length ? models : model ? [model] : []).map((m) => ({ value: m, label: modelLabel(m) }))

  // Effort + permission come from the SELECTED model's discovered capability / the
  // runtime catalog — the same catalog-aware helpers the session and add/edit controls
  // use — not the static tables. So a runtime with no such vocabulary (e.g. opencode)
  // shows no effort/permission control instead of Claude-style values it doesn't accept.
  const capability = agent ? modelCapability(owningDaemon, agent.runtime, model) : undefined
  const effortList = agent ? effortChoicesFor(agent.runtime, capability) : []
  const showEffort = capability?.efforts ? effortList.length > 0 : agent ? supportsModes(agent.runtime) : false
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
      ? resolveEffortForModel(agent.runtime, capability, rawEffort) ||
        displayedEffort('', effortList, capability?.defaultEffort) ||
        effortList[0]?.value ||
        ''
      : ''
  const effortChoices = effortList.map((o) => ({ value: o.value, label: o.label, description: o.description }))

  const permissionList = agent ? permissionModeChoicesFor(agent.runtime, modelCatalog) : []
  const showPermission = agent ? !!modelCatalog?.permissionModes?.length || supportsModes(agent.runtime) : false
  const permissionMode = showPermission
    ? resolvedPermissionMode(agent?.permissionMode ?? '', permissionList, modelCatalog)
    : ''
  const permissionPreset = runtime.permissionPreset ?? permissionMode
  const permissionChoices = permissionList.map((o) => ({
    value: o.v,
    label: o.l,
    description: o.description
  }))

  // Why the composer can't start a session for the selected agent (null ⇒ it can).
  const blocked: 'offline' | 'auth' | null = !agent
    ? null
    : !agentOnline
      ? 'offline'
      : authRequiredFor(agent)
        ? 'auth'
        : null
  // A multi-agent create needs every roster pick startable — the "+" menu only
  // OFFERS ready agents, but the @mention picker (unlike it) also lists unready
  // ones dimmed (so a typed name still resolves to a real candidate), and
  // readiness can change mid-compose regardless of how a member was added.
  const canSend = !!agent && blocked === null && members.every(agentReady)
  const notReadyMember = members.find((m) => !agentReady(m))

  const onImageFile = async (file: File | undefined): Promise<void> => {
    if (!file || imagePreparing) return
    setMenu(null)
    setImagePreparing(true)
    setImageError(null)
    try {
      setImage(await prepareWebchatImage(file))
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Couldn’t prepare that image.')
    } finally {
      setImagePreparing(false)
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  const send = () => {
    const text = input.trim()
    if ((!text && !image) || imagePreparing || mention.joining) return
    if (!agent || !canSend) return // offline / unsigned-in agents can't take a session
    const id = openPlayground(agent, members, !multi && gitWorkspace ? { worktree } : undefined)
    // Stage the EFFECTIVE (displayed) runtime before the turn — not just explicit
    // overrides — so the session runs exactly what the composer showed. stageRuntimeChange
    // is a synchronous ref write, so pgSend's payload picks it up (PlaygroundProvider).
    // Multi-agent conversations expose no runtime controls: every participant
    // runs its configured defaults (webchat-multi-agents.md §9.1).
    if (!multi) {
      if (model) pgSetModel(id, agent.id, model)
      if (effort) pgSetEffort(id, agent.id, effort)
      if (permissionPreset) pgSetPermissionPreset(id, agent.id, permissionPreset)
    }
    // The image rides as an explicit argument: the session id was just minted, so
    // a setPgImage(id) state write could not land before this same-tick send.
    pgSend(id, agent.id, text, undefined, undefined, image)
    setInput('')
    mention.close()
    setImage(undefined)
    setImageError(null)
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

  // How many rows each dashboard card draws — see `dashboard-rows.ts` for the identity
  // that makes the two columns end on the same line.
  const isMobile = useIsMobile()
  const gridRef = useRef<HTMLDivElement>(null)
  const availableHeight = useAvailableHeight(gridRef, !isMobile, blocked)
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
            sessions: allSessions.length,
            agents: rankedAgents.length,
            crons: crons.length
          }),
    [isMobile, availableHeight, allSessions.length, rankedAgents.length, crons.length]
  )

  const topAgents = rankedAgents.slice(0, agentRows)
  const scheduled = crons.slice(0, cronRows)

  if (loading && agents.length === 0 && allSessions.length === 0) return <LoadingState fill />

  const agentOptions = agents.map((a) => {
    const ready = agentReady(a)
    const reason = !isOnline(a)
      ? `${agentLabel(a)} is offline — its daemon isn't serving`
      : `${agentLabel(a)} has no AI runtime signed in`
    return {
      value: a.id,
      label: agentLabel(a),
      dimmed: !ready,
      description: ready ? 'Pick the agent to ask' : reason,
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
          ? 'Add to this conversation'
          : !isOnline(a)
            ? `${agentLabel(a)} is offline — its daemon isn't serving`
            : `${agentLabel(a)} has no AI runtime signed in`,
        leading: (
          <span className="av h-[18px] w-[18px] flex-none rounded-xs">
            <AgentIconView icon={a.icon} runtime={a.runtime} size={18} />
          </span>
        )
      }
    })

  // While the redirect to /onboarding is in flight (or the skip flag is still being
  // read), hold a spinner so the empty composer never flashes behind it.
  if (holdForOnboarding) return <LoadingState fill />

  return (
    // Every block here is content-sized: the dashboard picks a row count that fits the
    // leftover viewport (useAvailableHeight), so the page fills a roomy window without
    // stretching a card past its rows, and scrolls rather than squashing when it can't.
    // Mobile keeps normal flow + the bottom-nav padding.
    <div className="wrap max-w-[1000px] max-desktop:px-4 max-desktop:pt-4 max-desktop:pb-24">
      {/* Centered greeting above the composer (design: 32px mark, 27px title). */}
      <div className="mt-[22px] mb-[22px] flex items-center justify-center gap-[13px]">
        <LogoMark size={32} />
        {/* Server and client can sit in different timezones, and the display name
            only resolves after mount — both settle on the client. */}
        <h1 className="ptitle text-[27px]" suppressHydrationWarning>
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
      </div>

      {/* Composer — hands off to a live session on send. The footer selectors mirror
          the design: agent + model as pills (leading mark), effort + permission as
          chips. Each picks the run's runtime; the choice is applied on send. */}
      <div
        className="card mb-3 overflow-visible"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setMenu(null)
        }}
      >
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => void onImageFile(event.target.files?.[0])}
        />
        {image && (
          <div className="relative mx-[15px] mt-3 w-fit">
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={image.name}
              title={image.name}
              className="h-20 w-20 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) object-cover"
            />
            <button
              type="button"
              className="iconbtn absolute -right-2 -top-2 h-6 w-6 rounded-full shadow-(--shadow-xs)"
              title="Remove image"
              aria-label="Remove image"
              onClick={() => setImage(undefined)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
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
              const file = clipboardImageFile(event.clipboardData)
              if (!file) return
              event.preventDefault()
              void onImageFile(file)
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
            rows={5}
            placeholder="Ask agentconnect to connect a workspace, deploy an agent, or check on a run"
            className="block max-h-[280px] min-h-[140px] w-full resize-none border-0 bg-transparent px-[15px] pt-[14px] pb-1 font-sans text-[14px] leading-normal text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
          />
          <MentionMenu
            options={mention.matches}
            activeIndex={mention.activeIndex}
            coords={mention.coords}
            onHover={mention.setActiveIndex}
            onPick={mention.pick}
          />
        </div>
        {/* items-start + a wrapping selector group so the controls reflow onto a second
            row at phone widths instead of overflowing (mobile .content clips overflow-x);
            the send button stays pinned top-right. */}
        {imageError && (
          <div className="px-[15px] pb-2 font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">
            {imageError}
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-(--border-subtle) py-[7px] pr-[9px] pl-[10px]">
          <div className="relative flex-none">
            <button
              type="button"
              className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-secondary)"
              aria-label="Attach a file"
              aria-haspopup="menu"
              aria-expanded={menu === 'attach'}
              title="Attach a file"
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
                    <Icon name="image" size={16} color="var(--text-secondary)" />
                    Add photos
                  </button>
                </div>
              </>
            )}
          </div>
          {/* nowrap on mobile — pills shrink + truncate (ComposerMenu min-w-0)
            instead of wrapping into a second toolbar line. Except with a
            multi-agent roster: those chips are unbounded in count, so no amount
            of truncation bounds one line — let that case wrap. */}
          <div
            className={
              multi
                ? 'flex min-w-0 flex-1 flex-wrap items-center gap-2'
                : 'flex min-w-0 flex-1 items-center gap-2 desktop:flex-wrap'
            }
          >
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
                        aria-label={`Remove ${agentLabel(a)}`}
                        className="-mr-1 px-1 text-(--text-tertiary) hover:text-(--text-primary)"
                        onClick={() => (i === 0 ? removePrimary() : removeMember(a.id))}
                      >
                        ×
                      </button>
                    </span>
                  ))
                ) : (
                  <ComposerMenu
                    title="Agent"
                    value={agent.id}
                    options={agentOptions}
                    open={menu === 'agent'}
                    align="left"
                    placement="down"
                    triggerClassName="inline-flex h-7 items-center gap-[7px] rounded-full px-[10px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)"
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
                    title="Add agents"
                    value=""
                    options={addOptions}
                    iconOnly
                    open={menu === 'add'}
                    align="left"
                    placement="down"
                    triggerClassName="inline-flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-(--border-default) font-sans leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                    tooltips={false}
                    leading={<Icon name="plus" size={14} />}
                    onOpenChange={(o) => setMenu(o ? 'add' : null)}
                    onChange={(v) => setMemberIds((cur) => (cur.includes(v) ? cur : [...cur, v]))}
                  />
                )}
                {!multi && modelChoices.length > 0 && (
                  <ComposerMenu
                    title="Model"
                    value={model}
                    options={modelChoices}
                    open={menu === 'model'}
                    align="left"
                    placement="down"
                    triggerClassName="inline-flex h-7 items-center gap-[3px] rounded-full px-[10px] max-desktop:px-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)"
                    tooltips={false}
                    leading={
                      <span className="inline-flex h-4 w-4 flex-none items-center justify-center">
                        <ModelMark model={model} fallbackRuntime={agent.runtime} />
                      </span>
                    }
                    onOpenChange={(o) => setMenu(o ? 'model' : null)}
                    onChange={(m) => setRuntime((r) => ({ ...r, model: m }))}
                  />
                )}
                {!multi && showEffort && effortChoices.length > 0 && (
                  <ComposerMenu
                    title="Effort"
                    value={effort}
                    options={effortChoices}
                    open={menu === 'effort'}
                    align="left"
                    placement="down"
                    triggerClassName={CHIP}
                    tooltips={false}
                    onOpenChange={(o) => setMenu(o ? 'effort' : null)}
                    onChange={(v) => setRuntime((r) => ({ ...r, effort: v }))}
                  />
                )}
                {!multi && showPermission && permissionChoices.length > 0 && (
                  <ComposerMenu
                    title="Permission"
                    value={permissionPreset}
                    options={permissionChoices}
                    open={menu === 'permission'}
                    align="left"
                    placement="down"
                    triggerClassName={CHIP}
                    tooltips={false}
                    onOpenChange={(o) => setMenu(o ? 'permission' : null)}
                    onChange={(v) => setRuntime((r) => ({ ...r, permissionPreset: v }))}
                  />
                )}
                {!multi && gitWorkspace && (
                  <label className={`${CHIP} min-w-0 cursor-pointer`}>
                    <input
                      type="checkbox"
                      checked={worktree}
                      onChange={(event) => setWorktreeOverride(event.target.checked)}
                      className="h-4 w-4 flex-none accent-(--brand)"
                    />
                    <span className="truncate">Worktree</span>
                  </label>
                )}
              </>
            ) : (
              <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)">
                No agents yet
              </span>
            )}
          </div>
          <button
            type="button"
            className="sendbtn h-7 w-7 flex-none rounded-[7px]"
            disabled={(!input.trim() && !image) || !canSend || imagePreparing || mention.joining}
            onClick={send}
            title={
              blocked === 'offline'
                ? `${agentLabel(agent!)} is offline — can't start a session`
                : blocked === 'auth'
                  ? `No AI runtime is signed in on ${placementName || 'the daemon'} — can't start a session`
                  : notReadyMember
                    ? !isOnline(notReadyMember)
                      ? `${agentLabel(notReadyMember)} is offline — can't start a session`
                      : `${agentLabel(notReadyMember)} has no AI runtime signed in — can't start a session`
                    : 'Send'
            }
          >
            <Icon name="arrow-up" size={15} color="#fff" />
          </button>
        </div>
      </div>

      {/* Why the selected agent can't take a session (state-driven, per agent):
          offline ⇒ its daemon isn't serving; auth ⇒ online but the daemon's runtime
          reported "sign-in required" (no active AI subscription/login). */}
      {!loading && blocked && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-(--status-paused-soft) bg-(--status-paused-soft) px-4 py-[10px]">
          <Icon name="triangle-alert" size={16} color="var(--status-paused)" />
          <span className="min-w-0 flex-1 font-sans text-[13px] leading-normal text-(--text-secondary)">
            {blocked === 'offline' ? (
              <>
                <span className="font-semibold">{agentLabel(agent!)}</span>
                {' is offline — you can’t start a session until its daemon reconnects.'}
              </>
            ) : (
              <>
                {'No AI runtime is signed in'}
                {placementName ? (
                  <>
                    {' on '}
                    <span className="font-semibold">{placementName}</span>
                  </>
                ) : null}
                {', so agents can’t take a session.'}
              </>
            )}
          </span>
          {placementHref && (
            <button
              type="button"
              className="flex-none font-sans text-[13px] font-semibold leading-normal text-(--text-brand) hover:underline"
              onClick={() => router.push(placementHref)}
            >
              {blocked === 'auth' ? 'Fix' : placementKind === 'daemon' ? 'View daemon' : 'View infra'}
            </button>
          )}
        </div>
      )}

      {/* Dashboard grid. Both columns are content-sized and the row counts are chosen so
          they come out the same height — see the row-budget note at the top of the file.
          `gap-4` is the 16px the budget accounts for; changing it changes DASH_ROW_H. */}
      <div ref={gridRef} className="grid grid-cols-1 gap-4 desktop:grid-cols-[1.5fr_1fr]">
        {/* `self-start` is the sparse-state treatment. With enough sessions the card
            already measures exactly the row height, so it changes nothing; with fewer
            (a new or quiet org) it stops the grid stretching a two-row card down to
            the right column's floor, which would trade a shared bottom edge for a tall
            blank strip. A short card beside a taller column reads as "not much here
            yet" — the stretched one just reads as broken. */}
        <RecentSessionsCard
          sessions={allSessions}
          loading={loading}
          allHref={orgPath('/sessions')}
          emptyText="No sessions yet — ask an agent above to start one."
          limit={sessionRows}
          rowClassName={DASH_ROW}
          className={aligned ? undefined : 'desktop:self-start'}
        />

        <div className="flex flex-col gap-4">
          <Card title="Agents you use" action={<CardLink href={orgPath('/agents')}>All agents</CardLink>}>
            {topAgents.length === 0 ? (
              <EmptyRow className={DASH_ROW}>No agents yet.</EmptyRow>
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
                    <span className="av h-7 w-7 rounded-md">
                      <AgentIconView icon={a.icon} runtime={a.runtime} size={28} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                        {agentLabel(a)}
                      </span>
                      <span className="mono block truncate text-[11px] text-(--text-tertiary)">
                        {runtimeLabel(a.runtime)} ·{' '}
                        {agentModelDisplay(agentCapabilitySource(a, daemons, memberSets), a.runtime, a.model)}
                      </span>
                    </span>
                    <span className="mono whitespace-nowrap text-[12px] text-(--text-secondary)">
                      {sessionsByAgent.get(a.id) ?? 0}
                    </span>
                  </Link>
                )
              })
            )}
          </Card>

          <Card title="Scheduled runs" action={<CardLink href={orgPath('/crons')}>All schedules</CardLink>}>
            {scheduled.length === 0 ? (
              <EmptyRow className={DASH_ROW}>No schedules yet.</EmptyRow>
            ) : (
              scheduled.map((c) => {
                const owner = c.agentId ? getAgent(c.agentId) : undefined
                return (
                  <Link
                    key={c.id}
                    href={orgPath(`/crons/${c.id}`)}
                    className={`row click grid-cols-[1fr_auto] gap-3 ${DASH_ROW}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                        {c.name || cronHuman(c.schedule) || c.schedule}
                      </span>
                      <span className="mono mt-[3px] block truncate text-[11px] text-(--text-tertiary)">
                        {owner ? agentLabel(owner) : '—'} · ran {fmtAgo(c.lastRunAt)}
                      </span>
                    </span>
                    <span className="mono self-start whitespace-nowrap text-[11.5px] text-(--text-secondary)">
                      {c.enabled ? fmtNextRun(cronNext(c.schedule, c.timezone)) : 'paused'}
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
