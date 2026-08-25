'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { isAuthConfigured } from '@/lib/auth'
import { daemonCompletesOnboarding, firstReconnectableDaemonId, skipOnboarding } from '@/lib/onboarding'
import { daemonCommands } from '@/lib/daemon-commands'
import { computeGettingStarted } from '@/lib/getting-started'
import { featureFlagEnabled } from '@/lib/feature-flags'
import {
  AddToSlackRow,
  GsRows,
  MeetYourAgents,
  useGithubAppEnabled,
  useGithubProfileLinked,
  useGsActions,
  useSessionAccessCardAvailable,
  useSlackPlatformAppAvailable
} from '@/components/console/GettingStartedChecklist'
import { RuntimeSelect } from '@/components/console/RuntimeSelect'
import {
  FALLBACK_RUNTIME_IDS,
  agentIsPlaced,
  agentLabel,
  localDaemons,
  modelLabel,
  preferredModelFor,
  loginRequiredRuntimeIds
} from '@/lib/data'
import type { Agent, DaemonRow } from '@/lib/data'
import type { DaemonConnectDto } from '@/lib/api'

// Onboarding (design: "AgentConnect Onboarding"). Where the deployment offers the cloud
// pool (`daemon-pool`) there is nothing to connect NOR to pin the built-in agent to, so
// both the daemon and configure phases are skipped straight to the checklist. Self-hosted
// (flag off) keeps the flow below unchanged: connecting a daemon is the ONLY
// blocking step; when one comes online the screen transitions in place and reveals the
// SAME getting-started checklist the console shows (lib/getting-started.ts). No more
// 3-step wizard — the remaining steps live in the checklist and follow the user into
// the console (the corner pill in GettingStarted.tsx). Rendered full-screen (no rail)
// by the shell on the /onboarding route.
//
// The daemon step is inline and functional: it mints a real join command and polls for
// the daemon to come online (like AddDaemonModal). Not shipped yet, so not shown as
// "done for you": preset agents + the one-click built-in Bot connect (preset-agents.md
// §3/§5) — the revealed checklist derives from real state, so "Create your first agent"
// etc. appear as ordinary open steps until those land.

type DaemonCommand = Pick<DaemonConnectDto, 'daemonId' | 'command'>

export default function OnboardingView() {
  const router = useRouter()
  const params = useParams()
  const {
    agents,
    daemons,
    integrations,
    allSessions,
    orgHasSessions,
    members,
    agentsLoading,
    daemonsLoading,
    provisionDaemon,
    reconnectDaemon,
    deleteDaemon,
    updateAgent,
    moveAgent,
    refresh,
    refreshDaemons
  } = useConsoleData()
  const { orgPath } = useOrgs()
  const { runAction } = useGsActions()
  const githubLinked = useGithubProfileLinked()
  const githubEnabled = useGithubAppEnabled()
  const sessionAccessAvailable = useSessionAccessCardAvailable()
  // Local mode (no platform-published Slack app): the slack row falls back to the
  // default GsRow, whose CTA opens the Slack integration wizard.
  const slackOneClick = useSlackPlatformAppAvailable()
  const orgKey = typeof params.slug === 'string' ? params.slug : '-'
  const authOn = isAuthConfigured()

  // A live daemon or a planned relaunch reveals the checklist. Only an unexpected offline
  // row is eligible for a replacement connect token — it may be a provisioned daemon whose
  // one-time command was lost on reload; the mint below reconnects it.
  // Cloud pool on ⇒ agents run there, so onboarding never asks for a daemon: treat the
  // blocking step as already satisfied, which also latches off the mint/poll effects below.
  const cloudDaemon = featureFlagEnabled('daemon-pool')
  // Pool Pods are never a machine the user connected, so the connect step ignores them —
  // off the pool the console hides them entirely, and a reconnect token for one is nonsense.
  const machines = localDaemons(daemons)
  const daemonReady = cloudDaemon || machines.some(daemonCompletesOnboarding)
  const offlineDaemonId = firstReconnectableDaemonId(machines)
  const loading = (agentsLoading || daemonsLoading) && daemons.length === 0 && agents.length === 0

  // Once a daemon is serving, configure the org's built-in `agentconnect` preset before
  // the checklist reveal: auto-assign it to that daemon and let the user pick a runtime +
  // model (design: the built-in agent replaces "create your first agent"). The preset
  // ships unplaced (daemon '—', deferred runtime); it's ready once both are set. Older
  // orgs without the preset just skip straight to the reveal. Pool mode skips this phase
  // too — nothing "just connected" to pin to, and the checklist's agent row (expanded by
  // default on the pool) owns the setup instead.
  const builtinAgent = agents.find((a) => a.builtin)
  const servingDaemon = machines.find((d) => d.status === 'online') ?? machines.find(daemonCompletesOnboarding)
  const needsAgentSetup = !cloudDaemon && !!builtinAgent && !!servingDaemon && !agentIsPlaced(builtinAgent)
  const [skipSetup, setSkipSetup] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  // Runtime becomes mandatory at placement, so set it FIRST, then move onto the daemon
  // (the CP rejects a move on a runtime-less agent). A placed agent flips needsAgentSetup
  // off by itself; `skipSetup` covers the save-raced edge until the refresh lands.
  const saveAgentSetup = async (runtime: string, model: string) => {
    if (!builtinAgent || !servingDaemon) return
    setSaving(true)
    setSaveErr(null)
    try {
      await updateAgent(builtinAgent.id, { runtime, ...(model ? { model } : {}) })
      await moveAgent(builtinAgent.id, { kind: 'daemon', daemonId: servingDaemon.daemonId })
      await refresh()
      setSkipSetup(true)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // --- Daemon provisioning (mirrors AddDaemonModal / the old wizard step 0) ----------
  const [connect, setConnect] = useState<DaemonCommand | null>(null)
  const [mintErr, setMintErr] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  // Bumped by the error state's Retry — re-arms the mint effect after a failure.
  const [mintAttempt, setMintAttempt] = useState(0)
  const provisioned = useRef(false)
  const commandPending = useRef<Promise<DaemonCommand> | null>(null)
  const createdByWizard = useRef(false)
  const connectedOnce = useRef(false)

  // Mint only once BOTH lists have settled: agents can resolve first (every org ships
  // the builtin preset, so `loading` clears on partial data) while the pending fleet
  // response still contains a connected daemon — minting against the empty snapshot
  // would provision a duplicate. Duplicate-safe on retry too: a provision that
  // succeeded server-side surfaces as an offline row on the next refresh, which routes
  // the retry through reconnect instead of a second provision.
  useEffect(() => {
    if (agentsLoading || daemonsLoading || daemonReady || provisioned.current) return
    provisioned.current = true
    setMintErr(null)
    createdByWizard.current = !offlineDaemonId
    const command: Promise<DaemonCommand> = offlineDaemonId
      ? reconnectDaemon(offlineDaemonId).then((minted) => ({ daemonId: offlineDaemonId, command: minted.command }))
      : provisionDaemon()
    commandPending.current = command
    command.then(setConnect).catch((e) => setMintErr(e instanceof Error ? e.message : String(e)))
  }, [agentsLoading, daemonsLoading, daemonReady, offlineDaemonId, provisionDaemon, reconnectDaemon, mintAttempt])

  // A transient mint failure must not strand the single blocking step. AWAIT the fleet
  // refresh before re-arming: if the failed provision actually succeeded server-side
  // (response lost), the refreshed list contains that daemon as an offline row, so the
  // re-run reconnects it via `offlineDaemonId` instead of minting a duplicate. A FAILED
  // refresh must NOT re-arm — the stale snapshot is exactly what could duplicate an
  // ambiguously-successful provision; stay latched and keep the Retry on screen.
  const retryMint = async () => {
    setMintErr(null)
    try {
      await refreshDaemons()
    } catch {
      setMintErr('Could not refresh the daemon list — check your connection and retry.')
      return
    }
    provisioned.current = false
    commandPending.current = null
    setMintAttempt((n) => n + 1)
  }

  // Poll until the daemon connects; tick the elapsed timer while waiting.
  useEffect(() => {
    if (daemonReady) {
      connectedOnce.current = true
      return
    }
    if (!connect) return
    const poll = setInterval(refresh, 3000)
    const tick = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [connect, daemonReady, refresh])

  // Drop only a wizard-created row that was never claimed. Once it has connected or
  // hosts an agent, leaving onboarding must never turn into a deletion.
  const cleanupPending = async () => {
    const pending = connect ?? (await commandPending.current?.catch(() => null))
    const row = pending ? daemons.find((d) => d.daemonId === pending.daemonId) : undefined
    const hostsAgent = pending ? agents.some((a) => a.daemon === pending.daemonId) : false
    const shouldDelete =
      pending && createdByWizard.current && !connectedOnce.current && !hostsAgent && row?.status !== 'online'
    try {
      if (shouldDelete) await deleteDaemon(pending.daemonId)
    } catch {
      /* best-effort — an unclaimed provisioned row is harmless */
    }
  }
  const goConsole = () => {
    void cleanupPending()
    skipOnboarding(orgKey)
    router.push(orgPath('/home'))
  }

  const cmd = connect ? daemonCommands(connect.command).run : null
  const copy = async () => {
    if (!cmd) return
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1700)
    } catch {
      /* clipboard unavailable */
    }
  }
  const listeningId = connect?.daemonId ?? offlineDaemonId ?? ''
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  // The shell renders the full-screen frame + slim top bar (logo · theme · user menu)
  // for the /onboarding route; this is just the centered content.
  return (
    <div className="flex min-h-full items-center justify-center px-5 py-10">
      {loading ? (
        <LoadingState fill />
      ) : !daemonReady ? (
        <ConnectDaemon
          cmd={cmd}
          mintErr={mintErr}
          copied={copied}
          onCopy={copy}
          onRetry={() => void retryMint()}
          listeningId={listeningId}
          elapsedLabel={elapsedLabel}
          onExplore={goConsole}
        />
      ) : needsAgentSetup && !skipSetup ? (
        <ConfigureAgent
          agent={builtinAgent!}
          daemon={servingDaemon!}
          saving={saving}
          err={saveErr}
          onSave={saveAgentSetup}
          onSkip={() => setSkipSetup(true)}
        />
      ) : (
        <RevealChecklist
          gs={computeGettingStarted({
            agents,
            daemons,
            integrations,
            sessions: allSessions,
            members,
            authOn,
            orgHasSessions,
            githubLinked,
            githubEnabled,
            sessionAccessAvailable,
            poolEnabled: cloudDaemon
          })}
          slackOneClick={slackOneClick}
          runAction={runAction}
          cloudDaemon={cloudDaemon}
          onFinish={goConsole}
        />
      )}
    </div>
  )
}

// --- Phase 1: connect your daemon (the one blocking step) ----------------------------
function ConnectDaemon({
  cmd,
  mintErr,
  copied,
  onCopy,
  onRetry,
  listeningId,
  elapsedLabel,
  onExplore
}: {
  cmd: string | null
  mintErr: string | null
  copied: boolean
  onCopy: () => void
  onRetry: () => void
  listeningId: string
  elapsedLabel: string
  onExplore: () => void
}) {
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-[22px]">
      <div className="flex flex-col items-center gap-[11px] text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-[11px] border border-(--border-default) bg-(--surface-card) text-(--brand) shadow-(--shadow-xs)">
          <Icon name="server" size={21} />
        </span>
        <div className="font-mono text-[11px] font-semibold uppercase leading-none tracking-[.12em] text-(--brand)">
          Setup
        </div>
        <h1 className="font-sans text-[28px] font-semibold leading-[1.2] tracking-[-.02em] text-(--text-primary)">
          Connect your daemon
        </h1>
        <p className="max-w-[450px] font-sans text-[14.5px] font-normal leading-[1.55] text-(--text-secondary)">
          A daemon runs your agents on your own hardware. Run this one command wherever you want them to run — it
          connects to AgentConnect and keeps running.
        </p>
      </div>

      {/* Dark terminal block — the real minted join command */}
      <div className="overflow-hidden rounded-[10px] border border-(--gray-800) bg-(--gray-1000) shadow-(--shadow-xs)">
        <div className="flex items-center gap-2 border-b border-(--gray-800) py-[9px] pr-[10px] pl-[13px]">
          <Icon name="terminal" size={13} color="var(--text-inverse-dim)" />
          <span className="font-mono text-[11px] font-medium leading-normal tracking-[.02em] text-(--text-inverse-dim)">
            one command · macOS, Linux, WSL
          </span>
          <button
            type="button"
            onClick={onCopy}
            disabled={!cmd}
            className="ml-auto inline-flex h-[26px] cursor-pointer items-center gap-[6px] rounded-md border border-white/15 bg-white/5 px-[9px] font-mono text-[11px] font-medium text-[#e6ebf1] hover:border-white/25 hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex gap-[9px] break-all p-[15px] font-mono text-[13px] leading-[1.6] text-[#cdd6e0]">
          {cmd ? (
            <>
              <span className="text-(--magenta-300)">$</span>
              <span>{cmd}</span>
            </>
          ) : mintErr ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-(--status-error)">Could not provision a key — {mintErr}</span>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-[24px] cursor-pointer items-center gap-[5px] rounded-md border border-white/15 bg-white/5 px-2 font-mono text-[11px] font-medium text-[#e6ebf1] hover:border-white/25 hover:bg-white/10"
              >
                <Icon name="refresh-cw" size={11} />
                Retry
              </button>
            </span>
          ) : (
            <span className="text-(--text-inverse-dim)">Minting key…</span>
          )}
        </div>
      </div>

      {/* Waiting card — auto-continues when the daemon comes online */}
      <div className="flex items-center gap-[13px] rounded-[10px] border border-(--border-default) bg-(--surface-card) px-4 py-[14px] shadow-(--shadow-xs)">
        <span className="h-[18px] w-[18px] flex-none animate-spin rounded-full border-2 border-(--gray-200) border-t-(--brand)" />
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13.5px] font-medium leading-normal text-(--text-primary)">
            Waiting for your daemon to come online…
          </div>
          <div className="mt-[2px] font-mono text-[11.5px] leading-normal text-(--text-tertiary)">
            {listeningId ? `Listening for ${listeningId} · ` : ''}this page continues on its own
          </div>
        </div>
        <span className="flex-none font-mono text-[12px] tabular-nums text-(--text-tertiary)">{elapsedLabel}</span>
      </div>

      <div className="flex flex-col items-center gap-3">
        <a
          href="https://docs.agentconnect.md/docs/install-the-daemon"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-[6px] font-sans text-[12.5px] text-(--text-tertiary) no-underline hover:text-(--brand)"
        >
          Daemon not showing up? Read the setup guide
          <Icon name="arrow-up-right" size={13} />
        </a>
        <Button variant="secondary" size="sm" onClick={onExplore}>
          Explore the console first
          <Icon name="arrow-right" size={14} />
        </Button>
      </div>
    </div>
  )
}

// --- Phase 1.5: place + configure the built-in agent on the just-connected daemon ----
// Daemon is fixed (the one we just brought online); the user only picks runtime + model.
// Mirrors AddAgentModal's Daemon/Runtime/Model row: runtime ids come from the daemon's
// reported profiles (else the static fallback), models from the chosen runtime's profile.
function ConfigureAgent({
  agent,
  daemon,
  saving,
  err,
  onSave,
  onSkip
}: {
  agent: Agent
  /** The just-connected daemon: both the placement target and the picker seed. */
  daemon: DaemonRow
  saving: boolean
  err: string | null
  onSave: (runtime: string, model: string) => void
  onSkip: () => void
}) {
  const runtimeIds = daemon.runtimeModels.length ? daemon.runtimeModels.map((r) => r.runtime) : FALLBACK_RUNTIME_IDS
  // Logged-out runtimes are marked, not blocked; the default just prefers a signed-in
  // one so a first agent starts answerable where the daemon allows it.
  const runtimesNeedingLogin = loginRequiredRuntimeIds(daemon)
  const defaultRuntime = runtimeIds.find((id) => !runtimesNeedingLogin.includes(id)) ?? runtimeIds[0] ?? ''
  const [runtime, setRuntime] = useState('') // '' = untouched
  const effectiveRuntime = runtime && runtimeIds.includes(runtime) ? runtime : defaultRuntime
  const models = daemon.runtimeModels.find((r) => r.runtime === effectiveRuntime)?.models ?? []
  const [model, setModel] = useState('')
  // Keep the selection valid as the runtime (and so the model set) changes.
  const selectedModel = models.includes(model) ? model : preferredModelFor(daemon, effectiveRuntime)

  return (
    <div className="flex w-full max-w-[520px] flex-col gap-[22px]">
      <div className="flex flex-col items-center gap-[11px] text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-[11px] border border-(--border-default) bg-(--surface-card) text-(--brand) shadow-(--shadow-xs)">
          <Icon name="bot" size={21} />
        </span>
        <div className="font-mono text-[11px] font-semibold uppercase leading-none tracking-[.12em] text-(--brand)">
          Set up your agent
        </div>
        <h1 className="font-sans text-[28px] font-semibold leading-[1.2] tracking-[-.02em] text-(--text-primary)">
          Configure {agentLabel(agent)}
        </h1>
        <p className="max-w-[430px] font-sans text-[14.5px] font-normal leading-[1.55] text-(--text-secondary)">
          Your org’s built-in agent runs on the daemon you just connected. Pick a runtime and model, and it’s ready to
          work.
        </p>
      </div>

      <div className="flex flex-col gap-[14px] rounded-[10px] border border-(--border-default) bg-(--surface-card) p-4 shadow-(--shadow-xs)">
        <div className="fld">
          <span className="fldlbl">Runs on</span>
          <div className="inp cursor-not-allowed" title="Set to the daemon you just connected">
            <span className="truncate text-(--text-primary)">{daemon.name}</span>
            <span className="ml-auto flex-none font-sans text-[11.5px] leading-none text-(--text-tertiary)">
              just connected
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-[14px] desktop:grid-cols-2">
          <div className="fld">
            <span className="fldlbl">Runtime</span>
            <RuntimeSelect
              value={effectiveRuntime}
              options={runtimeIds}
              needsLogin={runtimesNeedingLogin}
              onChange={(next) => {
                setRuntime(next)
                setModel('')
              }}
            />
          </div>
          <div className="fld">
            <span className="fldlbl">Model</span>
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
                    onChange={(e) => setModel(e.target.value)}
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
        {err && (
          <div className="flex items-start gap-2 font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
            <Icon name="alert-triangle" size={15} className="mt-[1px] flex-none" />
            <span>{err}</span>
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-3">
        <div className="flex w-full flex-col items-stretch gap-[10px] desktop:w-auto desktop:flex-row desktop:items-center desktop:justify-center">
          <Button
            size="lg"
            disabled={saving || !effectiveRuntime}
            onClick={() => onSave(effectiveRuntime, selectedModel)}
          >
            {saving ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              <Icon name="check" size={16} />
            )}
            {saving ? 'Saving…' : 'Save and continue'}
          </Button>
          <Button size="lg" variant="ghost" disabled={saving} onClick={onSkip}>
            Skip for now
            <Icon name="arrow-right" size={15} />
          </Button>
        </div>
        <div className="text-center font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          You can change the runtime and model any time from the agent&rsquo;s settings.
        </div>
      </div>
    </div>
  )
}

// --- Phase 2: daemon online → the same checklist the console shows -------------------
function RevealChecklist({
  gs,
  slackOneClick,
  runAction,
  cloudDaemon,
  onFinish
}: {
  gs: ReturnType<typeof computeGettingStarted>
  slackOneClick: boolean
  runAction: (action: import('@/lib/getting-started').GsAction) => void
  /** Cloud pool: no daemon was connected, so the reveal cannot claim one came online. */
  cloudDaemon: boolean
  onFinish: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(cloudDaemon ? 'agent' : 'daemon')
  return (
    <div className="ac-rise flex w-full max-w-[580px] flex-col gap-4">
      <div className="flex flex-col items-center gap-[10px] text-center">
        <span className="ac-pop flex h-[46px] w-[46px] items-center justify-center rounded-full bg-(--green-50) text-(--green-500)">
          <Icon name="check" size={23} />
        </span>
        <h1 className="font-sans text-[24px] font-semibold leading-[1.2] tracking-[-.02em] text-(--text-primary)">
          {cloudDaemon ? 'Welcome to AgentConnect' : 'Your daemon is online'}
        </h1>
        <p className="max-w-[440px] font-sans text-[14px] font-normal leading-[1.55] text-(--text-secondary)">
          {cloudDaemon
            ? 'Here’s your getting-started checklist. Work through the rest any time; it follows you into the console.'
            : 'Connected and ready — here’s your getting-started checklist. Work through the rest any time; it follows you into the console.'}
        </p>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
        <div className="flex items-center gap-[10px] py-[14px] pr-[14px] pl-4">
          <Icon name="list-checks" size={16} color="var(--brand)" />
          <span className="min-w-0 flex-1 font-sans text-[14.5px] font-semibold leading-none tracking-[-.01em] text-(--text-primary)">
            Getting started
          </span>
          <span className="font-mono text-[12px] tabular-nums leading-none text-(--text-tertiary)">
            {gs.done} of {gs.total}
          </span>
          <span className="h-[5px] w-[120px] flex-none overflow-hidden rounded-[3px] bg-(--gray-150)">
            <span
              className="block h-full rounded-[3px] bg-(--brand) transition-[width] duration-300"
              style={{ width: `${Math.round(gs.fraction * 100)}%` }}
            />
          </span>
        </div>
        <div className="border-t border-(--border-subtle)">
          <GsRows
            items={gs.items}
            expanded={expanded}
            onToggle={(key) => setExpanded((cur) => (cur === key ? null : key))}
            runAction={runAction}
            renderItem={(it, ctx) =>
              it.key === 'agent' ? (
                <MeetYourAgents
                  done={it.done}
                  open={ctx.open}
                  toggle={ctx.toggle}
                  onConnect={() => runAction(it.action)}
                />
              ) : it.key === 'slack' && slackOneClick ? (
                <AddToSlackRow
                  done={it.done}
                  open={ctx.open}
                  toggle={ctx.toggle}
                  onManual={() => runAction(it.action)}
                />
              ) : null
            }
          />
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <div className="flex w-full flex-col items-stretch gap-[10px] desktop:w-auto desktop:flex-row desktop:items-center desktop:justify-center">
          <Button size="lg" disabled={!gs.allDone} onClick={onFinish}>
            <Icon name="check" size={16} />
            {gs.allDone ? 'Finish onboarding' : `Finish onboarding · ${gs.total - gs.done} left`}
          </Button>
          <Button size="lg" variant="ghost" onClick={onFinish}>
            Skip for now
            <Icon name="arrow-right" size={15} />
          </Button>
        </div>
        <div className="text-center font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          Finish the remaining steps to complete onboarding — or skip ahead; the checklist follows you into the console.
        </div>
      </div>
    </div>
  )
}
