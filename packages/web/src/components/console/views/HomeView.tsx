'use client'

// The chat-first console landing. A composer ("Ask an agent") is the primary
// posture; sending hands off to a live session (openPlayground → pgSend →
// /sessions/{id}), which IS the design's "the same page becomes the
// conversation". Below it the page answers "what happened / what's next / who
// do I ask": Recent sessions, Agents you use (ranked by 24h session count),
// and Scheduled runs.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useOrgs } from '@/lib/org-context'
import { useOnboardingRedirect } from '@/lib/use-onboarding-redirect'
import { useConsoleData } from '@/lib/data-context'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { ComposerMenu } from '@/components/console/ComposerMenu'
import { Icon } from '@/components/ui'
import { AgentIconView, ModelMark, PlatformMark, LoadingState } from '@/components/marks'
import {
  agentLabel,
  modelLabel,
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
  sessionPlatform,
  type Agent
} from '@/lib/data'
import { cronNext, cronHuman, fmtNextRun } from '@/lib/cron'

// Design composer selectors: agent/model are "pills" (rounded, with a leading
// mark), effort/permission are plain "chips". Full literal strings so Tailwind's
// scanner sees them (STYLE.md §8).
const CHIP =
  'inline-flex h-7 items-center gap-[6px] rounded-md px-[9px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'

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

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="cardhead justify-between">
        <span className="cardtitle">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 font-sans text-[12px] font-medium leading-normal text-(--text-brand) hover:underline"
    >
      {children}
      <Icon name="arrow-right" size={12} color="var(--text-brand)" />
    </Link>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-5 text-center font-sans text-[12.5px] leading-normal text-(--text-tertiary)">
      {children}
    </div>
  )
}

export default function HomeView() {
  const router = useRouter()
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

  // Preferred default agent: the "agentconnect" preset if present, else the first
  // READY one, else the first (so the composer defaults to something startable).
  const preferred = useMemo(
    () => agents.find((a) => a.name === 'agentconnect') ?? agents.find(agentReady) ?? agents[0],
    [agents, daemons]
  )
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

  // Same readiness gate as the composer: starting a chat with a not-ready agent would
  // open a dead session, so select it in Home instead and let the banner explain why.
  const startChat = (a: Agent) => {
    if (!agentReady(a)) {
      setAgentId(a.id)
      return
    }
    const id = openPlayground(a)
    router.push(orgPath(`/sessions/${id}`))
  }

  const recent = allSessions.slice(0, 6)

  const sessionsByAgent = useMemo(
    () => new Map((usage24h?.agents ?? []).map((u) => [u.agentId, u.sessions])),
    [usage24h]
  )
  const rankedAgents = useMemo(
    () => [...agents].sort((a, b) => (sessionsByAgent.get(b.id) ?? 0) - (sessionsByAgent.get(a.id) ?? 0)).slice(0, 4),
    [agents, sessionsByAgent]
  )

  const scheduled = crons.slice(0, 3)

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
    <div className="wrap max-w-[1000px] max-desktop:px-4 max-desktop:pt-4 max-desktop:pb-24">
      <h1 className="ptitle mb-4">Ask an agent</h1>

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
          rows={2}
          placeholder="Ask agentconnect to connect a workspace, deploy an agent, or check on a run"
          className="block max-h-[160px] min-h-[56px] w-full resize-none border-0 bg-transparent px-4 pt-[14px] pb-2 font-sans text-[14px] leading-normal text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
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

      {/* Dashboard grid. */}
      <div className="grid grid-cols-1 gap-4 desktop:grid-cols-[1.5fr_1fr]">
        <Card title="Recent" action={<CardLink href={orgPath('/sessions')}>All sessions</CardLink>}>
          {recent.length === 0 ? (
            <EmptyRow>No sessions yet — ask an agent above to start one.</EmptyRow>
          ) : (
            recent.map((s) => {
              const owner = s.agentId ? getAgent(s.agentId) : undefined
              return (
                <Link key={s.id} href={orgPath(`/sessions/${s.id}`)} className="row click grid-cols-[1fr_auto] gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                      {s.title}
                    </span>
                    <span className="mt-[3px] flex items-center gap-[6px] text-(--text-tertiary)">
                      <span className="av h-[15px] w-[15px] rounded-xs">
                        <AgentIconView icon={owner?.icon} runtime={owner?.runtime ?? s.runtime ?? 'claude'} size={15} />
                      </span>
                      <span className="truncate font-sans text-[11.5px] leading-normal">{s.agentName || '—'}</span>
                      {s.channel && (
                        <>
                          <span className="imark h-[18px] w-[18px] rounded-xs">
                            <PlatformMark platform={sessionPlatform(s)} />
                          </span>
                          <span className="mono truncate text-[11px]">{s.channel}</span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="mono self-start whitespace-nowrap text-[11.5px] text-(--text-tertiary)">
                    {s.time}
                  </span>
                </Link>
              )
            })
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Agents you use" action={<CardLink href={orgPath('/agents')}>All agents</CardLink>}>
            {rankedAgents.length === 0 ? (
              <EmptyRow>No agents yet.</EmptyRow>
            ) : (
              rankedAgents.map((a) => {
                const ready = agentReady(a)
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => startChat(a)}
                    title={
                      ready
                        ? `Start a chat with ${agentLabel(a)}`
                        : `${agentLabel(a)} isn't ready — select it to see why`
                    }
                    className={`row click w-full grid-cols-[auto_1fr_auto] gap-3 text-left ${ready ? '' : 'opacity-60'}`}
                  >
                    <span className="av h-7 w-7 rounded-md">
                      <AgentIconView icon={a.icon} runtime={a.runtime} size={28} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                        {agentLabel(a)}
                      </span>
                      <span className="mono block truncate text-[11px] text-(--text-tertiary)">
                        {runtimeLabel(a.runtime)} · {modelLabel(a.model)}
                      </span>
                    </span>
                    <span className="mono whitespace-nowrap text-[12px] text-(--text-secondary)">
                      {sessionsByAgent.get(a.id) ?? 0}
                    </span>
                  </button>
                )
              })
            )}
          </Card>

          <Card title="Scheduled runs" action={<CardLink href={orgPath('/crons')}>All schedules</CardLink>}>
            {scheduled.length === 0 ? (
              <EmptyRow>No schedules yet.</EmptyRow>
            ) : (
              scheduled.map((c) => {
                const owner = c.agentId ? getAgent(c.agentId) : undefined
                return (
                  <Link key={c.id} href={orgPath(`/crons/${c.id}`)} className="row click grid-cols-[1fr_auto] gap-3">
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
