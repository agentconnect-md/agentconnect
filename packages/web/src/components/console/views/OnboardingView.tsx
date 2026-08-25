'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { isAuthConfigured } from '@/lib/auth'
import { daemonCompletesOnboarding, firstReconnectableDaemonId, skipOnboarding } from '@/lib/onboarding'
import { daemonCommands } from '@/lib/daemon-commands'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { RuntimeSelect } from '@/components/console/RuntimeSelect'
import {
  FALLBACK_RUNTIME_IDS,
  agentIsPlaced,
  localDaemons,
  modelLabel,
  poolLabel,
  preferredModelFor,
  loginRequiredRuntimeIds
} from '@/lib/data'
import type { DaemonRow } from '@/lib/data'
import type { DaemonConnectDto } from '@/lib/api'

// Onboarding wizard (design: "AgentConnect Onboarding v2 (forked)") — owner-only, runs
// once per org. Creating/naming the org was step 1 (/welcome or the create-org entry),
// so this picks up at the ONE fork on where the first agent runs. The pool path (Cloud
// on the managed install, the operator's cluster elsewhere) configures the built-in
// agent's runtime and finishes; the Daemon path adds the copy-paste connect step (mint
// a real join command, poll until it comes online) with the runtime pickers inline.
// Finish AND skip both persist the org's `onboardingCompleted` flag — re-entering the
// org never bounces back here once either happened. Rendered full-screen (no rail) by
// the shell on the /onboarding route.

type DaemonCommand = Pick<DaemonConnectDto, 'daemonId' | 'command'>
type Step = 'where' | 'run'

export default function OnboardingView() {
  const router = useRouter()
  const params = useParams()
  const {
    agents,
    daemons,
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
  const { activeOrg, orgPath, updateOrg } = useOrgs()
  const orgKey = typeof params.slug === 'string' ? params.slug : '-'
  const authOn = isAuthConfigured()

  // Owner-only surface: collaborators/viewers never onboard an org — bounce them home.
  const notOwner = activeOrg != null && activeOrg.role !== 'owner'
  useEffect(() => {
    if (notOwner) router.replace(orgPath('/home'))
  }, [notOwner, router, orgPath])

  // The pool (managed Cloud / self-hosted cluster) is the no-install fork option.
  const poolOffered = featureFlagEnabled('daemon-pool')
  const [step, setStep] = useState<Step>(poolOffered ? 'where' : 'run')
  const [choice, setChoice] = useState<'pool' | 'daemon'>(poolOffered ? 'pool' : 'daemon')

  // The org's built-in preset agent: the pool path (and the daemon path once one is
  // online) configures its runtime/model here; already-placed presets skip that.
  const builtinAgent = agents.find((a) => a.builtin)
  const machines = localDaemons(daemons)
  const daemonReady = machines.some(daemonCompletesOnboarding)
  const servingDaemon = machines.find((d) => d.status === 'online') ?? machines.find(daemonCompletesOnboarding)
  const poolCapabilityDaemon = daemons.find((d) => d.pool && d.status === 'online') ?? daemons.find((d) => d.pool)
  const needsAgentSetup = !!builtinAgent && !agentIsPlaced(builtinAgent)
  // Pool path with a placed (or absent) preset finishes right at the fork (design 02).
  const poolRuntimeStep = poolOffered && needsAgentSetup

  // Auth mode counts org creation (/welcome, already behind us) as step 1.
  const orgStepsBefore = authOn ? 1 : 0
  const lastStepExists = choice === 'daemon' || (choice === 'pool' && poolRuntimeStep)
  const total = Math.max(orgStepsBefore + 1, orgStepsBefore + (poolOffered ? 1 : 0) + (lastStepExists ? 1 : 0))
  const stepNumbers: Record<Step, number> = { where: orgStepsBefore + 1, run: total }

  // ── finish / skip: persist the flag, then leave ─────────────────────────────────
  // Called only AFTER the step's own work (agent runtime + placement) succeeded, so the
  // flag never marks a half-finished org. A failed PATCH keeps the user here with the
  // error and a retryable Finish instead of silently navigating away.
  const [finishing, setFinishing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const finish = async () => {
    setFinishing(true)
    setSaveErr(null)
    try {
      if (activeOrg) await updateOrg(activeOrg.id, { onboardingCompleted: true })
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
      setFinishing(false)
      return
    }
    // Latch this tab so the redirect hook can't bounce back while navigation lands.
    skipOnboarding(orgKey)
    router.push(orgPath('/home'))
  }

  // ── built-in agent setup: runtime/model + placement, ordered by what the CP accepts ──
  const saveAgentSetup = async (runtime: string, model: string, target: DaemonRow | 'pool' | null) => {
    if (!builtinAgent || !runtime) return true
    setSaving(true)
    setSaveErr(null)
    try {
      const place = async () => {
        if (target === 'pool') {
          // Placing on the pool needs a pool that exists; without one the agent editor owns the choice.
          if (poolCapabilityDaemon) await moveAgent(builtinAgent.id, { kind: 'pool' })
        } else if (target) {
          await moveAgent(builtinAgent.id, { kind: 'daemon', daemonId: target.daemonId })
        }
      }
      const patch = () => updateAgent(builtinAgent.id, { runtime, ...(model ? { model } : {}) })
      // A deferred-runtime preset must set the runtime FIRST (the CP rejects a move on a
      // runtime-less agent). An already-configured one (e.g. born pool-placed) moves onto
      // the chosen home FIRST, so the spec PATCH runs against the daemon it will run on.
      if (builtinAgent.runtime) {
        await place()
        await patch()
      } else {
        await patch()
        await place()
      }
      await refresh()
      return true
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  // ── daemon provisioning (daemon path only; mirrors AddDaemonModal) ────────────────
  const [connect, setConnect] = useState<DaemonCommand | null>(null)
  const [mintErr, setMintErr] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  const [mintAttempt, setMintAttempt] = useState(0)
  const provisioned = useRef(false)
  const commandPending = useRef<Promise<DaemonCommand> | null>(null)
  const createdByWizard = useRef(false)
  const connectedOnce = useRef(false)
  const onDaemonStep = step === 'run' && choice === 'daemon'
  const offlineDaemonId = firstReconnectableDaemonId(machines)

  // Mint only on the daemon step and only once BOTH lists have settled: agents can
  // resolve first while the pending fleet response still contains a connected daemon —
  // minting against the empty snapshot would provision a duplicate. Duplicate-safe on
  // retry too: a provision that succeeded server-side surfaces as an offline row on the
  // next refresh, which routes the retry through reconnect instead of a second provision.
  useEffect(() => {
    if (!onDaemonStep || agentsLoading || daemonsLoading || daemonReady || provisioned.current) return
    provisioned.current = true
    setMintErr(null)
    createdByWizard.current = !offlineDaemonId
    const command: Promise<DaemonCommand> = offlineDaemonId
      ? reconnectDaemon(offlineDaemonId).then((minted) => ({ daemonId: offlineDaemonId, command: minted.command }))
      : provisionDaemon()
    commandPending.current = command
    command.then(setConnect).catch((e) => setMintErr(e instanceof Error ? e.message : String(e)))
  }, [
    onDaemonStep,
    agentsLoading,
    daemonsLoading,
    daemonReady,
    offlineDaemonId,
    provisionDaemon,
    reconnectDaemon,
    mintAttempt
  ])

  // A transient mint failure must not strand the step. AWAIT the fleet refresh before
  // re-arming: if the failed provision actually landed server-side, the refreshed list
  // contains it as an offline row and the re-run reconnects instead of duplicating. A
  // FAILED refresh must NOT re-arm — stay latched and keep the Retry on screen.
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
    if (!connect || !onDaemonStep) return
    const poll = setInterval(refresh, 3000)
    const tick = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [connect, daemonReady, refresh, onDaemonStep])

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

  if (!activeOrg || notOwner) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingState fill />
      </div>
    )
  }

  const backFrom = (from: Step): Step | null => (from === 'run' && poolOffered ? 'where' : null)

  return (
    <div className="flex min-h-full flex-col">
      {step === 'where' ? (
        <WhereStep
          stepLabel={`Step ${stepNumbers.where} of ${total}`}
          choice={choice}
          onChoice={setChoice}
          finishHere={!lastStepExists}
          finishing={finishing}
          err={saveErr}
          onNext={() => (lastStepExists ? setStep('run') : void finish())}
        />
      ) : choice === 'pool' ? (
        <PoolRuntimeStep
          stepLabel={`Step ${total} of ${total}`}
          capabilityDaemon={poolCapabilityDaemon}
          initial={builtinAgent ? { runtime: builtinAgent.runtime, model: builtinAgent.model } : undefined}
          saving={saving || finishing}
          err={saveErr}
          onBack={backFrom('run') ? () => setStep(backFrom('run')!) : undefined}
          onFinish={async (runtime, model) => {
            if (await saveAgentSetup(runtime, model, 'pool')) void finish()
          }}
        />
      ) : (
        <DaemonStep
          stepLabel={`Step ${total} of ${total}`}
          cmd={cmd}
          mintErr={mintErr}
          copied={copied}
          onCopy={() => void copy()}
          onRetry={() => void retryMint()}
          listeningId={listeningId}
          elapsedLabel={elapsedLabel}
          daemon={daemonReady ? servingDaemon : undefined}
          initial={builtinAgent ? { runtime: builtinAgent.runtime, model: builtinAgent.model } : undefined}
          // The user chose the Daemon path, so the built-in agent runs HERE — even a
          // preset born pool-placed gets its runtime/model picked and moves onto the
          // machine just connected.
          showPickers={!!builtinAgent}
          saving={saving || finishing}
          err={saveErr}
          onBack={backFrom('run') ? () => setStep(backFrom('run')!) : undefined}
          onSkip={() => {
            void cleanupPending()
            void finish()
          }}
          onFinish={async (runtime, model) => {
            if (!builtinAgent || (await saveAgentSetup(runtime, model, servingDaemon ?? null))) void finish()
          }}
        />
      )}
    </div>
  )
}

// ── shared frame (design .win): top-aligned centered 640px content + a full-width
// footer bar pinned to the bottom of the takeover, buttons at 34px (design footer).
function StepFrame({
  stepLabel,
  title,
  sub,
  children,
  footer
}: {
  stepLabel: string
  title: string
  sub: string
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <>
      <div className="flex flex-1 items-center justify-center px-5 py-8 desktop:px-10 desktop:py-11">
        <div className="flex w-full max-w-[640px] flex-col">
          <div className="font-mono text-[12px] font-semibold uppercase leading-none tracking-[.1em] text-(--brand)">
            {stepLabel}
          </div>
          <h1 className="mt-[10px] font-sans text-[26px] font-semibold leading-[1.15] tracking-[-.02em] text-(--text-primary)">
            {title}
          </h1>
          <p className="mt-2 font-sans text-[14px] font-normal leading-[1.5] text-(--text-secondary)">{sub}</p>
          {children}
        </div>
      </div>
      <div className="sticky bottom-0 flex flex-none items-center gap-[10px] border-t border-(--border-subtle) bg-(--surface-card) px-5 py-4 desktop:px-10">
        {footer}
      </div>
    </>
  )
}

// ── the fork: where to run ───────────────────────────────────────────────────
function WhereCard({
  name,
  desc,
  icon,
  selected,
  onSelect
}: {
  name: string
  desc: string
  icon: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex cursor-pointer flex-col gap-[11px] rounded-[10px] border-[1.5px] p-4 text-left ${
        selected ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-default) bg-(--surface-card)'
      }`}
    >
      <div className="flex items-center gap-[10px]">
        <span
          className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md ${
            selected ? 'border border-(--magenta-200) bg-(--surface-card)' : 'bg-(--surface-sunken)'
          }`}
        >
          <Icon name={icon} size={18} color={selected ? 'var(--brand)' : 'var(--text-tertiary)'} />
        </span>
        <span className="font-sans text-[15px] font-semibold leading-normal text-(--text-primary)">{name}</span>
        <span
          className={`ml-auto h-[18px] w-[18px] flex-none rounded-full bg-(--surface-card) ${
            selected ? 'border-[5px] border-(--brand)' : 'border-[1.5px] border-(--border-strong)'
          }`}
        />
      </div>
      <span className="font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">{desc}</span>
    </button>
  )
}

function WhereStep({
  stepLabel,
  choice,
  onChoice,
  finishHere,
  finishing,
  err,
  onNext
}: {
  stepLabel: string
  choice: 'pool' | 'daemon'
  onChoice: (choice: 'pool' | 'daemon') => void
  /** Pool selected with nothing left to configure — the fork is the last step. */
  finishHere: boolean
  finishing: boolean
  err: string | null
  onNext: () => void
}) {
  const managed = featureFlagEnabled('managed')
  return (
    <StepFrame
      stepLabel={stepLabel}
      title="Where to run"
      sub="Pick where your first agent runs."
      footer={
        <>
          <div className="flex-1" />
          <Button disabled={finishing} onClick={onNext}>
            {finishHere ? (
              <>
                <Icon name="check" size={15} />
                {finishing ? 'Finishing…' : 'Finish'}
              </>
            ) : (
              <>
                Continue
                <Icon name="arrow-right" size={15} />
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="mt-[26px] grid grid-cols-1 gap-3 desktop:grid-cols-2">
        <WhereCard
          name={managed ? 'Cloud' : 'Cluster'}
          desc={
            managed
              ? 'Easiest start. Free credits on signup, nothing to install.'
              : 'The daemon pool your org already runs. Nothing to install.'
          }
          icon={managed ? 'cloud' : 'boxes'}
          selected={choice === 'pool'}
          onSelect={() => onChoice('pool')}
        />
        <WhereCard
          name="Daemon"
          desc="Bring your own subscription or API key, and your own machine."
          icon="server"
          selected={choice === 'daemon'}
          onSelect={() => onChoice('daemon')}
        />
      </div>
      <SaveError err={err} />
    </StepFrame>
  )
}

// ── runtime + model pickers (shared by the pool and daemon last steps) ────────────────
// Mirrors AddAgentModal's Runtime/Model row: runtime ids come from the capability
// daemon's reported profiles (else the static fallback), models from the chosen
// runtime's profile.
function useRuntimeModel(daemon?: DaemonRow, initial?: { runtime?: string; model?: string }) {
  const runtimeIds = daemon?.runtimeModels.length ? daemon.runtimeModels.map((r) => r.runtime) : FALLBACK_RUNTIME_IDS
  // Logged-out runtimes are marked, not blocked; the default just prefers a signed-in one.
  const runtimesNeedingLogin = daemon ? loginRequiredRuntimeIds(daemon) : []
  const defaultRuntime = runtimeIds.find((id) => !runtimesNeedingLogin.includes(id)) ?? runtimeIds[0] ?? ''
  // Seeded from the agent's current config (a pool-born preset has one); '' = untouched.
  const [runtime, setRuntime] = useState(initial?.runtime ?? '')
  const effectiveRuntime = runtime && runtimeIds.includes(runtime) ? runtime : defaultRuntime
  const models = daemon?.runtimeModels.find((r) => r.runtime === effectiveRuntime)?.models ?? []
  const [model, setModel] = useState(initial?.model ?? '')
  const selectedModel = models.includes(model) ? model : daemon ? preferredModelFor(daemon, effectiveRuntime) : ''
  return { runtimeIds, runtimesNeedingLogin, effectiveRuntime, models, selectedModel, setRuntime, setModel }
}

function RuntimeModelFields({ rm }: { rm: ReturnType<typeof useRuntimeModel> }) {
  return (
    <div className="grid grid-cols-1 gap-[14px] desktop:grid-cols-2">
      <div className="fld">
        <span className="fldlbl">Runtime</span>
        <RuntimeSelect
          value={rm.effectiveRuntime}
          options={rm.runtimeIds}
          needsLogin={rm.runtimesNeedingLogin}
          onChange={(next) => {
            rm.setRuntime(next)
            rm.setModel('')
          }}
        />
      </div>
      <div className="fld">
        <span className="fldlbl">Model</span>
        <div
          className={rm.models.length ? 'inp relative' : 'inp cursor-not-allowed'}
          title={rm.models.length ? undefined : 'This runtime reports no selectable models'}
        >
          <span className={`truncate ${rm.models.length ? '' : 'text-(--text-tertiary)'}`}>
            {rm.models.length ? modelLabel(rm.selectedModel) : '—'}
          </span>
          {rm.models.length > 0 && (
            <>
              <Icon name="chevron-down" size={15} color="var(--text-tertiary)" className="flex-none" />
              <select
                value={rm.selectedModel}
                onChange={(e) => rm.setModel(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Model"
              >
                {rm.models.map((m) => (
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
  )
}

function SaveError({ err }: { err: string | null }) {
  if (!err) return null
  return (
    <div className="mt-3 flex items-start gap-2 font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
      <Icon name="alert-triangle" size={15} className="mt-[1px] flex-none" />
      <span>{err}</span>
    </div>
  )
}

// ── last step, pool path: choose what the pool should run ─────────────────────────────
function PoolRuntimeStep({
  stepLabel,
  capabilityDaemon,
  initial,
  saving,
  err,
  onBack,
  onFinish
}: {
  stepLabel: string
  /** A pool member whose REPORTED runtimes/models seed the pickers; never a placement. */
  capabilityDaemon?: DaemonRow
  initial?: { runtime?: string; model?: string }
  saving: boolean
  err: string | null
  onBack?: () => void
  onFinish: (runtime: string, model: string) => void
}) {
  const rm = useRuntimeModel(capabilityDaemon, initial)
  return (
    <StepFrame
      stepLabel={stepLabel}
      title="Choose runtime"
      sub={`What the agent runs on ${poolLabel()}.`}
      footer={
        <>
          {onBack && (
            <Button variant="ghost" disabled={saving} onClick={onBack}>
              Back
            </Button>
          )}
          <div className="flex-1" />
          <Button
            disabled={saving || !rm.effectiveRuntime}
            onClick={() => onFinish(rm.effectiveRuntime, rm.selectedModel)}
          >
            <Icon name="check" size={15} />
            {saving ? 'Finishing…' : 'Finish'}
          </Button>
        </>
      }
    >
      <div className="mt-[26px]">
        <RuntimeModelFields rm={rm} />
      </div>
      <div className="mt-4 flex items-center gap-[10px] rounded-md bg-(--surface-sunken) px-[14px] py-3">
        <Icon name="boxes" size={15} color="var(--text-tertiary)" />
        <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
          Runs on <span className="text-(--text-primary)">{poolLabel()}</span> — nothing to install.
        </span>
      </div>
      <SaveError err={err} />
    </StepFrame>
  )
}

// ── last step, daemon path: connect + configure in one screen ─────────────────────────
function DaemonStep({
  stepLabel,
  cmd,
  mintErr,
  copied,
  onCopy,
  onRetry,
  listeningId,
  elapsedLabel,
  daemon,
  initial,
  showPickers,
  saving,
  err,
  onBack,
  onSkip,
  onFinish
}: {
  stepLabel: string
  cmd: string | null
  mintErr: string | null
  copied: boolean
  onCopy: () => void
  onRetry: () => void
  listeningId: string
  elapsedLabel: string
  /** The serving daemon once one is online; undefined while still waiting. */
  daemon?: DaemonRow
  initial?: { runtime?: string; model?: string }
  /** Whether the built-in agent still needs a runtime — hides the pickers otherwise. */
  showPickers: boolean
  saving: boolean
  err: string | null
  onBack?: () => void
  onSkip: () => void
  onFinish: (runtime: string, model: string) => void
}) {
  const rm = useRuntimeModel(daemon, initial)
  const ready = !!daemon

  return (
    <StepFrame
      stepLabel={stepLabel}
      title="Run the daemon"
      sub="Bring your own subscription or API key, and your own machine. Run this on the machine your agents should work on."
      footer={
        <>
          {onBack && (
            <Button variant="ghost" disabled={saving} onClick={onBack}>
              Back
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" disabled={saving} onClick={onSkip}>
            Skip
          </Button>
          <Button
            disabled={saving || !ready || (showPickers && !rm.effectiveRuntime)}
            onClick={() => onFinish(rm.effectiveRuntime, rm.selectedModel)}
          >
            <Icon name="check" size={15} />
            {saving ? 'Finishing…' : 'Finish'}
          </Button>
        </>
      }
    >
      {/* Dark terminal block — the real minted join command. A daemon that was already
          online when the step opened never minted one, so there is nothing to show. */}
      {(cmd || mintErr || !daemon) && (
        <div className="mt-6 overflow-hidden rounded-[10px] border border-(--gray-800) bg-(--gray-1000) shadow-(--shadow-xs)">
          <div className="flex items-center gap-2 border-b border-(--gray-800) py-[9px] pr-[10px] pl-[13px]">
            <Icon name="terminal" size={13} color="var(--text-inverse-dim)" />
            <span className="font-mono text-[11px] font-medium leading-normal tracking-[.02em] text-(--text-inverse-dim)">
              your machine · macOS, Linux, WSL
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
      )}

      {/* Waiting ↔ online card — flips in place when the daemon connects */}
      {daemon ? (
        <div className="mt-4 flex items-center gap-3 rounded-[10px] border border-(--magenta-200) bg-(--brand-soft) px-4 py-[14px]">
          <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md border border-(--magenta-200) bg-(--surface-card)">
            <Icon name="server" size={18} color="var(--brand)" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
              {daemon.name}
            </div>
            <div className="mt-[1px] font-mono text-[12px] leading-normal text-(--text-secondary)">
              {[daemon.host, daemon.version ? `v${daemon.version.replace(/^v/, '')}` : '']
                .filter(Boolean)
                .join(' · ') || 'connected'}
            </div>
          </div>
          <span className="inline-flex flex-none items-center gap-[6px] font-sans text-[12px] font-medium text-(--green-500)">
            <span className="h-[7px] w-[7px] rounded-full bg-(--green-500)" />
            online
          </span>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-[13px] rounded-[10px] border border-(--border-default) bg-(--surface-card) px-4 py-[14px] shadow-(--shadow-xs)">
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
      )}

      {showPickers && (
        <>
          <div className="mt-7 mb-3 font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            What should the agent run on?
          </div>
          <RuntimeModelFields rm={rm} />
        </>
      )}
      <SaveError err={err} />

      <a
        href="https://docs.agentconnect.md/docs/install-the-daemon"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-5 inline-flex items-center gap-[6px] self-start font-sans text-[12.5px] text-(--text-tertiary) no-underline hover:text-(--brand)"
      >
        Daemon not showing up? Read the setup guide
        <Icon name="arrow-up-right" size={13} />
      </a>
    </StepFrame>
  )
}
