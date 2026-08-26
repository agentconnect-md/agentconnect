'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { KubernetesMark, LoadingState } from '@/components/marks'
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
  isPoolPlacementKind,
  localDaemons,
  modelLabel,
  poolLabel,
  preferredModelFor,
  loginRequiredRuntimeIds
} from '@/lib/data'
import type { DaemonRow } from '@/lib/data'
import type { AgentPlacementTarget, DaemonConnectDto } from '@/lib/api'

// Onboarding wizard (design: "AgentConnect Onboarding v2 (forked)") — owner-only, runs
// once per org. Creating/naming the org was step 1 (/welcome or the create-org entry),
// so this picks up at the ONE fork on where the first agent runs. Both paths then choose the
// runtime: the pool path (Cloud on the managed install, the operator's cluster elsewhere) has
// nothing to install, so its last step is the pickers alone; the Daemon path puts the same
// pickers under a copy-paste connect step (mint a real join command, poll until it's online).
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

  // The org's built-in preset agent: both paths configure its runtime/model — the daemon path
  // once a machine is online, the pool path against what the cluster's members advertise.
  const builtinAgent = agents.find((a) => a.builtin)
  const machines = localDaemons(daemons)
  // The cluster's runtimes come from one live member standing in for the pool (the placement
  // names the SET — a Pod is a replaceable identity, never the target).
  const poolMembers = daemons.filter((d) => d.pool)
  const poolSource = poolMembers.find((d) => d.status === 'online') ?? poolMembers[0]
  const daemonReady = machines.some(daemonCompletesOnboarding)
  const servingDaemon = machines.find((d) => d.status === 'online') ?? machines.find(daemonCompletesOnboarding)

  // Auth mode counts org creation (/welcome, already behind us) as step 1.
  const orgStepsBefore = authOn ? 1 : 0
  // Both paths end on a step of their own: connect+configure for a daemon, pickers for the pool.
  const total = orgStepsBefore + (poolOffered ? 1 : 0) + 1
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
    // Every successful exit — Finish on any path AND Skip — drops a wizard-minted daemon
    // that never connected (Back → pool → Finish would otherwise strand it). Only after
    // the PATCH: a failed completion must keep the row its on-screen command points at.
    await cleanupPending()
    // Latch this tab so the redirect hook can't bounce back while navigation lands.
    skipOnboarding(orgKey)
    router.push(orgPath('/home'))
  }

  // ── built-in agent setup: runtime/model + placement, ordered by what the CP accepts ──
  const saveAgentSetup = async (runtime: string, model: string, target: AgentPlacementTarget | null) => {
    if (!builtinAgent || !runtime) return true
    setSaving(true)
    setSaveErr(null)
    try {
      // PATCH first, always: the move validates the agent's CURRENT runtime/model against
      // the target daemon, so moving a pool-born preset (e.g. runtime dsh-acp) before the
      // spec update is rejected with "target daemon does not support runtime …". The picker
      // sources runtime/model from the target's own profiles, so patch-then-move admits.
      // model || null: an empty selection (target's model probe not settled yet) must CLEAR
      // the pool preset's old model pin, not silently keep it across the runtime change.
      await updateAgent(builtinAgent.id, { runtime, model: model || null })
      if (target) await moveAgent(builtinAgent.id, target)
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

  // Cluster step with nothing advertised yet: poll like the daemon step does while it waits, so a
  // member that finishes probing lands here without a reload.
  const clusterWaiting = step === 'run' && choice === 'pool' && (poolSource?.runtimeModels.length ?? 0) === 0
  useEffect(() => {
    if (!clusterWaiting) return
    const poll = setInterval(refreshDaemons, 3000)
    return () => clearInterval(poll)
  }, [clusterWaiting, refreshDaemons])

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

  // Hold the wizard until BOTH snapshots settle: an empty not-yet-loaded agents list must
  // not read as "no preset to configure" and expose a Finish that marks the org complete.
  if (!activeOrg || notOwner || agentsLoading || daemonsLoading) {
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
          onNext={() => setStep('run')}
        />
      ) : choice === 'pool' ? (
        <ClusterStep
          stepLabel={`Step ${total} of ${total}`}
          source={poolSource}
          serving={poolMembers.filter((d) => d.status === 'online').length}
          initial={builtinAgent ? { runtime: builtinAgent.runtime, model: builtinAgent.model } : undefined}
          // Nothing to place — no preset at all, or one already on the pool — so a cluster with no
          // runtimes to report yet costs this step nothing. An UNPLACED preset has to wait.
          placed={!builtinAgent || isPoolPlacementKind(builtinAgent.placementKind)}
          showPickers={!!builtinAgent}
          saving={saving || finishing}
          err={saveErr}
          onBack={poolOffered ? () => setStep('where') : undefined}
          onFinish={async (runtime, model) => {
            // A pool-born preset is already placed there, so the runtime PATCH is the whole change.
            const target: AgentPlacementTarget | null = isPoolPlacementKind(builtinAgent?.placementKind)
              ? null
              : { kind: 'pool' }
            if (!builtinAgent || (await saveAgentSetup(runtime, model, target))) void finish()
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
          onSkip={() => void finish()}
          onFinish={async (runtime, model) => {
            const target: AgentPlacementTarget | null = servingDaemon
              ? { kind: 'daemon', daemonId: servingDaemon.daemonId }
              : null
            if (!builtinAgent || (await saveAgentSetup(runtime, model, target))) void finish()
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
  mark,
  selected,
  onSelect
}: {
  name: string
  desc: string
  icon: string
  /** A brand mark to draw instead of the lucide glyph — it carries its own colours. */
  mark?: ReactNode
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
          {mark ? (
            <span className="flex h-[18px] w-[18px]">{mark}</span>
          ) : (
            <Icon name={icon} size={18} color={selected ? 'var(--brand)' : 'var(--text-tertiary)'} />
          )}
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
  onNext
}: {
  stepLabel: string
  choice: 'pool' | 'daemon'
  onChoice: (choice: 'pool' | 'daemon') => void
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
          <Button onClick={onNext}>
            Continue
            <Icon name="arrow-right" size={15} />
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
          icon="cloud"
          // A self-hosted pool IS a Kubernetes cluster, so it is named by the thing the
          // operator actually runs rather than by a generic box glyph.
          mark={managed ? undefined : <KubernetesMark />}
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

// ── last step, pool path: nothing to install, so the runtime is the whole step ────────
function ClusterStep({
  stepLabel,
  source,
  serving,
  initial,
  placed,
  showPickers,
  saving,
  err,
  onBack,
  onFinish
}: {
  stepLabel: string
  /** The pool member whose reported profiles stand in for the cluster; undefined ⇒ no member. */
  source?: DaemonRow
  serving: number
  initial?: { runtime?: string; model?: string }
  /** Is the preset already on the pool (or absent)? False ⇒ Finish has to place it to be honest. */
  placed: boolean
  /** Whether the built-in agent still needs a runtime — hides the pickers otherwise. */
  showPickers: boolean
  saving: boolean
  err: string | null
  onBack?: () => void
  onFinish: (runtime: string, model: string) => void
}) {
  const rm = useRuntimeModel(source, initial)
  // "AgentConnect Cloud" is a name; "Kubernetes cluster" is a thing the operator runs.
  const where = featureFlagEnabled('managed') ? poolLabel() : `the ${poolLabel()}`
  // A serving member can still be mid-probe and advertise no profiles at all. Offering the
  // static fallback list there would write `claude-acp` over the pool runtime the deployment
  // configured, and Finish on the pool skips the move that would have refused it — so with
  // nothing advertised there is nothing to pick and nothing to write.
  const advertised = (source?.runtimeModels.length ?? 0) > 0
  const runtime = advertised ? rm.effectiveRuntime : ''
  // Same runtime, its models not in yet ⇒ keep the pin the preset came with, never clear it.
  const model = runtime && runtime === initial?.runtime && !rm.selectedModel ? (initial.model ?? '') : rm.selectedModel
  // Completing writes nothing when nothing is advertised, which is only honest for a preset already
  // on the pool. An unplaced one would be marked done with no runtime and no placement — the very
  // state this step exists to fix — so it waits for the cluster instead.
  const canFinish = advertised || placed
  return (
    <StepFrame
      stepLabel={stepLabel}
      title="Choose runtime"
      sub={`What the agent runs on ${where}.`}
      footer={
        <>
          {onBack && (
            <Button variant="ghost" disabled={saving} onClick={onBack}>
              Back
            </Button>
          )}
          <div className="flex-1" />
          <Button disabled={saving || !canFinish} onClick={() => onFinish(runtime, model)}>
            <Icon name="check" size={15} />
            {saving ? 'Finishing…' : 'Finish'}
          </Button>
        </>
      }
    >
      {showPickers && advertised && <div className="mt-6" />}
      {showPickers && advertised && <RuntimeModelFields rm={rm} />}
      {showPickers && !advertised && (
        <p className="mt-6 font-sans text-[13px] leading-[1.5] text-(--text-secondary)">
          {placed
            ? `${poolLabel()} has not advertised its runtimes yet, so this leaves the agent's runtime as it is. Change it from the agent's page once the cluster reports them.`
            : `Waiting for ${poolLabel()} to report the runtimes it can run — the agent cannot be placed there until it does. This page keeps checking; pick Daemon instead to run it on your own machine.`}
        </p>
      )}
      {/* Where it lands, in the pool's own terms: the placement names the set, not a Pod. */}
      <div className="mt-4 flex items-center gap-[10px] rounded-[10px] bg-(--surface-sunken) px-4 py-[13px]">
        <span className="flex h-[18px] w-[18px] flex-none">
          <KubernetesMark />
        </span>
        <span className="font-sans text-[13px] font-normal leading-normal text-(--text-secondary)">
          Runs on {where} · {serving > 0 ? `${serving} node${serving === 1 ? '' : 's'} serving` : 'no nodes serving'}
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
