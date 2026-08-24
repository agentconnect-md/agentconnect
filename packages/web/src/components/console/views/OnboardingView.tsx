'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { isAuthConfigured } from '@/lib/auth'
import { daemonCompletesOnboarding, skipOnboarding } from '@/lib/onboarding'
import { computeGettingStarted } from '@/lib/getting-started'
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
  modelLabel,
  preferredModelFor,
  loginRequiredRuntimeIds
} from '@/lib/data'
import type { Agent, DaemonRow } from '@/lib/data'

// Onboarding (design: "AgentConnect Onboarding"). Nothing here blocks: the screen
// configures the org's built-in agent (runtime + model) and then reveals the SAME
// getting-started checklist the console shows (lib/getting-started.ts). Connecting a
// daemon is no longer an onboarding step — it lives in the checklist and follows the
// user into the console (the corner pill in GettingStarted.tsx). Rendered full-screen
// (no rail) by the shell on the /onboarding route.

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
    updateAgent,
    moveAgent,
    refresh
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

  const loading = (agentsLoading || daemonsLoading) && daemons.length === 0 && agents.length === 0

  // First screen: configure the org's built-in `agentconnect` preset — the user picks a
  // runtime + model (design: the built-in agent replaces "create your first agent"). The
  // preset ships unplaced with a deferred runtime. If the org already runs a daemon we
  // place the agent onto it behind the scenes; otherwise placement waits for the
  // checklist's daemon step. Older orgs without the preset skip straight to the reveal.
  const builtinAgent = agents.find((a) => a.builtin)
  const placementDaemon = daemons.find((d) => d.status === 'online') ?? daemons.find(daemonCompletesOnboarding)
  const [setupDone, setSetupDone] = useState(false)
  const needsAgentSetup = !!builtinAgent && !agentIsPlaced(builtinAgent) && !setupDone
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  // Runtime becomes mandatory at placement, so set it FIRST, then move onto the daemon
  // (the CP rejects a move on a runtime-less agent).
  const saveAgentSetup = async (runtime: string, model: string) => {
    if (!builtinAgent) return
    setSaving(true)
    setSaveErr(null)
    try {
      await updateAgent(builtinAgent.id, { runtime, ...(model ? { model } : {}) })
      // Onboarding places onto a concrete machine; the pool is chosen from the agent editor.
      if (placementDaemon) await moveAgent(builtinAgent.id, { kind: 'daemon', daemonId: placementDaemon.daemonId })
      await refresh()
      setSetupDone(true)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const goConsole = () => {
    skipOnboarding(orgKey)
    router.push(orgPath('/home'))
  }

  // The shell renders the full-screen frame + slim top bar (logo · theme · user menu)
  // for the /onboarding route; this is just the centered content.
  return (
    <div className="flex min-h-full items-center justify-center px-5 py-10">
      {loading ? (
        <LoadingState fill />
      ) : needsAgentSetup ? (
        <ConfigureAgent
          agent={builtinAgent!}
          daemon={placementDaemon}
          saving={saving}
          err={saveErr}
          onSave={saveAgentSetup}
          onSkip={() => setSetupDone(true)}
        />
      ) : (
        <RevealChecklist
          gs={computeGettingStarted({
            agents,
            integrations,
            sessions: allSessions,
            members,
            authOn,
            orgHasSessions,
            githubLinked,
            githubEnabled,
            sessionAccessAvailable
          })}
          slackOneClick={slackOneClick}
          runAction={runAction}
          onFinish={goConsole}
        />
      )}
    </div>
  )
}

// --- Phase 1: configure the built-in agent -------------------------------------------
// The user only picks runtime + model. Mirrors AddAgentModal's Runtime/Model row:
// runtime ids come from the org's daemon when there is one (else the static fallback),
// models from the chosen runtime's profile.
function ConfigureAgent({
  agent,
  daemon,
  saving,
  err,
  onSave,
  onSkip
}: {
  agent: Agent
  daemon?: DaemonRow
  saving: boolean
  err: string | null
  onSave: (runtime: string, model: string) => void
  onSkip: () => void
}) {
  const runtimeIds = daemon?.runtimeModels.length ? daemon.runtimeModels.map((r) => r.runtime) : FALLBACK_RUNTIME_IDS
  // Logged-out runtimes are marked, not blocked; the default just prefers a signed-in
  // one so a first agent starts answerable where the daemon allows it.
  const runtimesNeedingLogin = daemon ? loginRequiredRuntimeIds(daemon) : []
  const defaultRuntime = runtimeIds.find((id) => !runtimesNeedingLogin.includes(id)) ?? runtimeIds[0] ?? ''
  const [runtime, setRuntime] = useState('') // '' = untouched
  const effectiveRuntime = runtime && runtimeIds.includes(runtime) ? runtime : defaultRuntime
  const models = daemon?.runtimeModels.find((r) => r.runtime === effectiveRuntime)?.models ?? []
  const [model, setModel] = useState('')
  // Keep the selection valid as the runtime (and so the model set) changes.
  const selectedModel = models.includes(model) ? model : daemon ? preferredModelFor(daemon, effectiveRuntime) : ''

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
          Every org ships with a built-in agent. Pick the runtime and model it should use, and it&rsquo;s ready to work.
        </p>
      </div>

      <div className="flex flex-col gap-[14px] rounded-[10px] border border-(--border-default) bg-(--surface-card) p-4 shadow-(--shadow-xs)">
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

// --- Phase 2: the same checklist the console shows -----------------------------------
function RevealChecklist({
  gs,
  slackOneClick,
  runAction,
  onFinish
}: {
  gs: ReturnType<typeof computeGettingStarted>
  slackOneClick: boolean
  runAction: (action: import('@/lib/getting-started').GsAction) => void
  onFinish: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>('agent')
  return (
    <div className="ac-rise flex w-full max-w-[580px] flex-col gap-4">
      <div className="flex flex-col items-center gap-[10px] text-center">
        <span className="ac-pop flex h-[46px] w-[46px] items-center justify-center rounded-full bg-(--green-50) text-(--green-500)">
          <Icon name="check" size={23} />
        </span>
        <h1 className="font-sans text-[24px] font-semibold leading-[1.2] tracking-[-.02em] text-(--text-primary)">
          Welcome to AgentConnect
        </h1>
        <p className="max-w-[440px] font-sans text-[14px] font-normal leading-[1.55] text-(--text-secondary)">
          Here&rsquo;s your getting-started checklist. Work through the rest any time; it follows you into the console.
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
