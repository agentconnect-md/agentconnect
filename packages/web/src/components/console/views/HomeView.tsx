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
import { Card, CardLink, EmptyRow, RecentSessionsCard } from '@/components/console/RecentSessionsCard'
import { Icon } from '@/components/ui'
import { AgentIconView, ModelMark, LoadingState, LogoMark } from '@/components/marks'
import { useProfile } from '@/lib/profile'
import {
  agentLabel,
  modelLabel,
  agentModelDisplay,
  runtimeLabel,
  effectiveAgentStatus,
  preferredModelFor,
  modelCapability,
  effortChoicesFor,
  displayedEffort,
  resolveEffortForModel,
  permissionModeChoicesFor,
  resolvedPermissionMode,
  supportsModes,
  type Agent
} from '@/lib/data'
import { cronNext, cronHuman, fmtNextRun } from '@/lib/cron'

// Design composer selectors: agent/model are "pills" (rounded, with a leading
// mark), effort/permission are plain "chips". Full literal strings so Tailwind's
// scanner sees them (STYLE.md §8).
const CHIP =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'

// ── Dashboard row budget ────────────────────────────────────────────────────
// The dashboard is one left card (Recent) beside a stack of two (Agents you use,
// Scheduled runs), and all three have to end on the same line with no half-drawn
// row and no dead strip inside a card. That falls out of one identity: every row
// is pinned to DASH_ROW_H and every card costs the same fixed chrome — its own two
// borders plus the head (2 + 45) — so the right column's SECOND card, gutter
// included, costs 2 + 45 + 16 = 63px, i.e. EXACTLY one row. The columns therefore
// match when the left card shows one row MORE than the right column shows in total:
//
//     47 + (n+1)·63  ==  (47 + a·63) + 16 + (47 + c·63)   for a + c == n
//
// (Hence 63 as the row height, not a rounder number — it is what the second card's
// chrome measures. Changing `gap-4` on the grid, the card border, or `.cardhead`
// padding changes it.) All the sizing below does is spend that budget: take as many
// whole rows as the leftover viewport height allows, then trim the right column —
// schedules first, then the agent list — until the left card can cover it.
const DASH_ROW_H = 63
const CARD_CHROME_H = 47
// The literal Tailwind spelling of DASH_ROW_H (`.row` is a components-layer class, so
// these utilities win). `content-center` centres the row's single grid track inside the
// taller box instead of stretching it, which is what keeps a cell's `self-start` (the
// timestamp / next-run column) riding the title line rather than the row's top edge.
// Desktop only: the mobile layer stacks the cards, so there is nothing to align there
// and rows keep their natural height.
const DASH_ROW = 'desktop:h-[63px] desktop:content-center desktop:py-0'
const MAX_AGENT_ROWS = 4
const MAX_CRON_ROWS = 3
const MOBILE_SESSION_ROWS = 6

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
  const { agents, daemons, crons, allSessions, usage24h, getAgent, loading } = useConsoleData()
  const { openPlayground, pgSend, pgSetModel, pgSetEffort, pgSetPermissionMode } = usePlayground()
  // Home is the default landing, so it owns the fresh-org bounce to /onboarding.
  const holdForOnboarding = useOnboardingRedirect()

  // An agent can take a session only when its owning daemon is serving AND that
  // runtime is signed in (its last probe wasn't rejected with ACP auth-required).
  const isOnline = (a: Agent) =>
    effectiveAgentStatus(
      a.status,
      daemons.find((d) => d.daemonId === a.daemon)
    ) === 'online'
  const authRequiredFor = (a: Agent) =>
    !!daemons.find((d) => d.daemonId === a.daemon)?.runtimeModels.find((r) => r.runtime === a.runtime)?.authRequired
  const agentReady = (a: Agent) => isOnline(a) && !authRequiredFor(a)

  // Preferred default agent: the "agentconnect" preset when it's READY, else the
  // first READY one, else the preset, else the first. Readiness outranks the preset:
  // if the preset's daemon is offline/unsigned-in while another daemon serves ready
  // agents, defaulting to the preset would flash the blocked banner for a daemon the
  // user isn't even using (composer must default to something startable).
  const preferred = useMemo(() => {
    const preset = agents.find((a) => a.name === 'agentconnect')
    return preset && agentReady(preset) ? preset : (agents.find(agentReady) ?? preset ?? agents[0])
  }, [agents, daemons])
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const agent = agents.find((a) => a.id === agentId) ?? preferred
  const agentOnline = agent ? isOnline(agent) : false

  const [input, setInput] = useState('')
  // Which selector menu is open (only one at a time), and the run-runtime overrides.
  const [menu, setMenu] = useState<'agent' | 'model' | 'effort' | 'permission' | null>(null)
  const [runtime, setRuntime] = useState<{ model?: string; effort?: string; permission?: string }>({})

  // Overrides are per-agent; drop them when the agent changes so the new agent's
  // own defaults show through.
  useEffect(() => setRuntime({}), [agent?.id])

  // The selected agent's owning daemon supplies the model catalog + defaults.
  const owningDaemon = agent ? daemons.find((d) => d.daemonId === agent.daemon) : undefined
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
  const permission = showPermission
    ? resolvedPermissionMode(runtime.permission ?? agent?.permissionMode ?? '', permissionList, modelCatalog)
    : ''
  const permissionChoices = permissionList.map((o) => ({ value: o.v, label: o.l, description: o.description }))

  // Why the composer can't start a session for the selected agent (null ⇒ it can).
  const blocked: 'offline' | 'auth' | null = !agent
    ? null
    : !agentOnline
      ? 'offline'
      : authRequiredFor(agent)
        ? 'auth'
        : null
  const canSend = !!agent && blocked === null
  const daemonHref = owningDaemon ? orgPath(`/daemons/${owningDaemon.daemonId}`) : null

  const send = () => {
    const text = input.trim()
    if (!text || !agent || !canSend) return // offline / unsigned-in agents can't take a session
    const id = openPlayground(agent) // pg_ session; pgSend awaits the socket, so no race
    // Stage the EFFECTIVE (displayed) runtime before the turn — not just explicit
    // overrides — so the session runs exactly what the composer showed. stageRuntimeChange
    // is a synchronous ref write, so pgSend's payload picks it up (PlaygroundProvider).
    if (model) pgSetModel(id, agent.id, model)
    if (effort) pgSetEffort(id, agent.id, effort)
    if (permission) pgSetPermissionMode(id, agent.id, permission)
    pgSend(id, agent.id, text)
    setInput('')
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

  // How many rows each dashboard card draws — see the row-budget note above.
  const isMobile = useIsMobile()
  const gridRef = useRef<HTMLDivElement>(null)
  const availableHeight = useAvailableHeight(gridRef, !isMobile, blocked)
  const { sessionRows, agentRows, cronRows } = useMemo(() => {
    // Mobile stacks the three cards, so there is nothing to align — keep the plain
    // content caps.
    if (isMobile) return { sessionRows: MOBILE_SESSION_ROWS, agentRows: MAX_AGENT_ROWS, cronRows: MAX_CRON_ROWS }
    // An empty card still draws its placeholder row, so it costs a row either way.
    let a = Math.min(MAX_AGENT_ROWS, Math.max(1, rankedAgents.length))
    let c = Math.min(MAX_CRON_ROWS, Math.max(1, crons.length))
    // Whole rows the leftover viewport can hold — unmeasured (mobile / first paint)
    // means no cap, so the cards start at their content-driven maximum.
    const capacity = availableHeight
      ? Math.max(3, Math.floor((availableHeight - CARD_CHROME_H) / DASH_ROW_H))
      : Number.POSITIVE_INFINITY
    // Trim the right column until the matching left card fits the viewport. Schedules
    // give way first, but in two passes down to a 2-row floor before either list is
    // taken to a single row — so a cramped window thins both cards instead of gutting
    // one. Only the VIEWPORT trims here: a thin session list must not shrink the other
    // two cards, because the left card can't grow to match them anyway (below).
    for (const floor of [2, 1]) {
      while (a + c + 1 > capacity && c > floor) c--
      while (a + c + 1 > capacity && a > floor) a--
    }
    // The left card always asks for one row more than the right column shows — that IS
    // the identity. An org with fewer sessions than that is the one case it can't hold
    // up: the right column's floor is two cards (two heads + a row each = three left
    // rows), which no shorter card can reach. There the card renders what it has and
    // stretches to the row height, so the bottoms still meet.
    return { sessionRows: a + c + 1, agentRows: a, cronRows: c }
  }, [isMobile, availableHeight, rankedAgents.length, crons.length])

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
      <div className="card mb-3 overflow-visible">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
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
        {/* items-start + a wrapping selector group so the controls reflow onto a second
            row at phone widths instead of overflowing (mobile .content clips overflow-x);
            the send button stays pinned top-right. */}
        <div className="flex items-start gap-2 border-t border-(--border-subtle) py-[7px] pr-[9px] pl-[10px]">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {agent ? (
              <>
                <ComposerMenu
                  title="Agent"
                  value={agent.id}
                  options={agentOptions}
                  open={menu === 'agent'}
                  align="left"
                  placement="down"
                  triggerClassName="inline-flex h-7 items-center gap-[7px] rounded-full px-[10px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)"
                  leading={
                    <span className="av h-4 w-4 rounded-xs">
                      <AgentIconView icon={agent.icon} runtime={agent.runtime} size={16} />
                    </span>
                  }
                  onOpenChange={(o) => setMenu(o ? 'agent' : null)}
                  onChange={setAgentId}
                />
                {modelChoices.length > 0 && (
                  <ComposerMenu
                    title="Model"
                    value={model}
                    options={modelChoices}
                    open={menu === 'model'}
                    align="left"
                    placement="down"
                    triggerClassName="inline-flex h-7 items-center gap-[3px] rounded-full px-[10px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) hover:bg-(--surface-hover)"
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
                {showEffort && effortChoices.length > 0 && (
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
                {showPermission && permissionChoices.length > 0 && (
                  <ComposerMenu
                    title="Permission"
                    value={permission}
                    options={permissionChoices}
                    open={menu === 'permission'}
                    align="left"
                    placement="down"
                    triggerClassName={CHIP}
                    tooltips={false}
                    onOpenChange={(o) => setMenu(o ? 'permission' : null)}
                    onChange={(v) => setRuntime((r) => ({ ...r, permission: v }))}
                  />
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
            disabled={!input.trim() || !canSend}
            onClick={send}
            title={
              blocked === 'offline'
                ? `${agentLabel(agent!)} is offline — can't start a session`
                : blocked === 'auth'
                  ? `No AI runtime is signed in on ${owningDaemon?.name ?? 'the daemon'} — can't start a session`
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
                {owningDaemon ? (
                  <>
                    {' on '}
                    <span className="font-semibold">{owningDaemon.name}</span>
                  </>
                ) : null}
                {', so agents can’t take a session.'}
              </>
            )}
          </span>
          {daemonHref && (
            <button
              type="button"
              className="flex-none font-sans text-[13px] font-semibold leading-normal text-(--text-brand) hover:underline"
              onClick={() => router.push(daemonHref)}
            >
              {blocked === 'auth' ? 'Fix' : 'View daemon'}
            </button>
          )}
        </div>
      )}

      {/* Dashboard grid. Both columns are content-sized and the row counts are chosen so
          they come out the same height — see the row-budget note at the top of the file.
          `gap-4` is the 16px the budget accounts for; changing it changes DASH_ROW_H. */}
      <div ref={gridRef} className="grid grid-cols-1 gap-4 desktop:grid-cols-[1.5fr_1fr]">
        <RecentSessionsCard
          sessions={allSessions}
          loading={loading}
          allHref={orgPath('/sessions')}
          emptyText="No sessions yet — ask an agent above to start one."
          limit={sessionRows}
          rowClassName={DASH_ROW}
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
                        {agentModelDisplay(
                          daemons.find((d) => d.daemonId === a.daemon),
                          a.runtime,
                          a.model
                        )}
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
