'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { LogoMark, Spinner, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useModal } from '@/components/console/ModalProvider'
import { useOrgs } from '@/lib/org-context'
import { skipOnboarding } from '@/lib/onboarding'
import { daemonCommands } from '@/lib/daemon-commands'
import type { DaemonConnectDto } from '@/lib/api'

type DaemonCommand = Pick<DaemonConnectDto, 'daemonId' | 'command'>

// Onboarding wizard (design: "AgentConnect Onboarding") — a 3-step guided setup rendered
// directly in the console content area: Welcome → Add a Daemon → Create an agent → Set up
// integration → live. The daemon step is inline and functional (mints a real join command
// and polls for the daemon to come online, like AddDaemonModal). The agent and integration
// steps hand off to the existing modals — those flows are 1.5k / 3.3k lines of validated
// logic, so the wizard frames them and launches them rather than re-implementing the forms.

const STEPS = [
  { title: 'Add a Daemon', sub: 'Run the Daemon' },
  { title: 'Create an agent', sub: 'Repo & model' },
  { title: 'Set up integration', sub: 'Assign a bot' }
] as const

const WELCOME_CARDS = [
  { icon: 'server', n: 'step 1', title: 'Add a Daemon', desc: 'Run one command to launch a Daemon on your own host.' },
  {
    icon: 'bot',
    n: 'step 2',
    title: 'Create an agent',
    desc: 'Point it at a GitHub repo and working folder, pick a model.'
  },
  { icon: 'plug', n: 'step 3', title: 'Set up integration', desc: 'Assign a bot so the agent can talk in a channel.' }
] as const

export default function OnboardingView() {
  const router = useRouter()
  const params = useParams()
  const {
    agents,
    daemons,
    integrations,
    agentsLoading,
    daemonsLoading,
    provisionDaemon,
    reconnectDaemon,
    deleteDaemon,
    refresh
  } = useConsoleData()
  const { openModal } = useModal()
  const { orgPath } = useOrgs()
  const orgKey = typeof params.slug === 'string' ? params.slug : '-'

  // Only a serving daemon completes step 1. An offline row may be a provisioned daemon
  // whose one-time command was lost on reload; the daemon step reconnects it below.
  const daemonOnline = daemons.some((d) => d.status === 'online')
  const offlineDaemonId = daemons.find((d) => d.status !== 'online')?.daemonId
  const hasAgent = agents.length > 0
  const hasIntegration = integrations.length > 0 || agents.some((a) => (a.hookKinds ?? []).length > 0)

  // 0 daemon · 1 agent · 2 integration · 3 live. `entered` gates the welcome screen.
  const [step, setStep] = useState(0)
  const [entered, setEntered] = useState(false)
  const didInit = useRef(false)
  const loading = (agentsLoading || daemonsLoading) && daemons.length === 0 && agents.length === 0

  // Seed the resume position once, after BOTH lists finish loading: jump straight to the
  // first incomplete step (past the welcome) when the org is already part-way set up.
  // Gating on emptiness would seed from partial data when one SWR key resolves first.
  useEffect(() => {
    if (didInit.current || agentsLoading || daemonsLoading) return
    didInit.current = true
    const s = !daemonOnline ? 0 : !hasAgent ? 1 : !hasIntegration ? 2 : 3
    setStep(s)
    setEntered(s > 0)
  }, [agentsLoading, daemonsLoading, daemonOnline, hasAgent, hasIntegration])

  // --- Daemon provisioning (step 0), mirrors AddDaemonModal --------------------------
  const [connect, setConnect] = useState<DaemonCommand | null>(null)
  const [mintErr, setMintErr] = useState<string | null>(null)
  const provisioned = useRef(false)
  const commandPending = useRef<Promise<DaemonCommand> | null>(null)
  const createdByWizard = useRef(false)
  const connectedOnce = useRef(false)
  useEffect(() => {
    if (!entered || step !== 0 || daemonOnline || provisioned.current) return
    provisioned.current = true
    setMintErr(null)
    createdByWizard.current = !offlineDaemonId
    const command: Promise<DaemonCommand> = offlineDaemonId
      ? reconnectDaemon(offlineDaemonId).then((minted) => ({
          daemonId: offlineDaemonId,
          command: minted.command
        }))
      : provisionDaemon()
    commandPending.current = command
    command.then(setConnect).catch((e) => setMintErr(e instanceof Error ? e.message : String(e)))
  }, [entered, step, daemonOnline, offlineDaemonId, provisionDaemon, reconnectDaemon])

  const provisionedRow = connect ? daemons.find((d) => d.daemonId === connect.daemonId) : undefined
  useEffect(() => {
    if (provisionedRow?.status === 'online') {
      connectedOnce.current = true
      return
    }
    if (!connect) return
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [connect, provisionedRow?.status, refresh])

  // Drop only a wizard-created row that was never claimed. Once it has connected or
  // hosts an agent, a later disconnect must not turn leaving onboarding into deletion.
  const cleanupPending = async () => {
    const pendingConnect = connect ?? (await commandPending.current?.catch(() => null))
    const pendingRow = pendingConnect ? daemons.find((d) => d.daemonId === pendingConnect.daemonId) : undefined
    const hostsAgent = pendingConnect ? agents.some((agent) => agent.daemon === pendingConnect.daemonId) : false
    const shouldDelete =
      pendingConnect &&
      createdByWizard.current &&
      !connectedOnce.current &&
      !hostsAgent &&
      pendingRow?.status !== 'online'
    try {
      if (shouldDelete) await deleteDaemon(pendingConnect.daemonId)
    } catch {
      /* best-effort cleanup — an unclaimed provisioned row is harmless */
    } finally {
      setConnect(null)
      setMintErr(null)
      provisioned.current = false
      commandPending.current = null
      createdByWizard.current = false
      connectedOnce.current = false
    }
  }
  const goConsole = () => {
    void cleanupPending()
    skipOnboarding(orgKey)
    router.push(orgPath('/home'))
  }

  if (loading) return <LoadingState fill />

  // --- Welcome -----------------------------------------------------------------------
  if (!entered) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col items-center px-6 py-10 pb-24 text-center desktop:py-14 desktop:pb-14">
        <LogoMark size={50} />
        <div className="mt-[22px] font-mono text-[12px] font-semibold uppercase leading-none tracking-[.1em] text-(--brand)">
          Get started
        </div>
        <h1 className="mt-[10px] font-sans text-[32px] font-semibold leading-[1.15] tracking-[-.02em] text-(--text-primary)">
          Welcome to AgentConnect
        </h1>
        <p className="mt-3 max-w-[500px] font-sans text-[16px] font-normal leading-[1.55] text-(--text-secondary)">
          Run AI agents on your own Daemons and drive them from Slack, Telegram, and Discord. Three steps to your first
          session.
        </p>
        <div className="mb-[26px] mt-[30px] grid w-full grid-cols-1 gap-3 desktop:grid-cols-3">
          {WELCOME_CARDS.map((c) => (
            <div
              key={c.title}
              className="rounded-md border border-(--border-subtle) bg-(--surface-card) p-4 text-left shadow-(--shadow-xs)"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-[34px] w-[34px] items-center justify-center rounded-md bg-(--brand-soft) text-(--brand-soft-text)">
                  <Icon name={c.icon} size={18} />
                </div>
                <span className="font-mono text-[11px] leading-normal text-(--text-tertiary)">{c.n}</span>
              </div>
              <div className="mt-3 font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                {c.title}
              </div>
              <div className="mt-[3px] font-sans text-[12.5px] font-normal leading-[1.45] text-(--text-tertiary)">
                {c.desc}
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-center gap-[10px] desktop:flex-row">
          <Button size="lg" onClick={() => setEntered(true)}>
            <Icon name="arrow-right" size={16} />
            Add a Daemon
          </Button>
          <Button size="lg" variant="ghost" onClick={goConsole}>
            Explore the console first
          </Button>
        </div>
        <div className="mt-[18px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          You&rsquo;ll run one command on the host where your agents should run.
        </div>
      </div>
    )
  }

  // --- Stepper wizard ----------------------------------------------------------------
  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-8 pb-24 desktop:py-10 desktop:pb-10">
      <div className="flex flex-col gap-8 desktop:flex-row desktop:gap-10">
        <StepRail current={step < 3 ? step : 3} />
        <div className="min-w-0 flex-1">
          {step === 0 && (
            <StepBody
              title="Add a Daemon"
              sub="Run this on the host where your agents should run. It launches a Daemon that connects to AgentConnect and stays available."
              footer={
                <>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await cleanupPending()
                      setEntered(false)
                    }}
                  >
                    Back
                  </Button>
                  <div className="flex-1" />
                  <Button disabled={!daemonOnline} onClick={() => setStep(1)}>
                    Create an agent
                    <Icon name="arrow-right" size={15} />
                  </Button>
                </>
              }
            >
              <Terminal connect={connect} err={mintErr} />
              <ConnectedCard
                online={!!provisionedRow && provisionedRow.status === 'online'}
                name={provisionedRow?.name}
                host={provisionedRow?.host}
                version={provisionedRow?.version}
                resumed={daemonOnline && !provisionedRow}
                resumedName={daemons.find((d) => d.status === 'online')?.name ?? daemons[0]?.name}
              />
              <div className="mt-[14px] flex items-start gap-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                <Icon name="info" size={15} className="mt-[1px] flex-none" />
                <span>
                  Keep this process running. The daemon runs agents locally over ACP and holds your platform
                  connections.
                </span>
              </div>
            </StepBody>
          )}

          {step === 1 && (
            <StepBody
              title="Create an agent"
              sub="It runs on the Daemon you just added. Point it at a repo and working directory, then pick a model."
              footer={
                <>
                  <Button variant="ghost" onClick={() => setStep(0)}>
                    Back
                  </Button>
                  <div className="flex-1" />
                  <Button disabled={!hasAgent} onClick={() => setStep(2)}>
                    Set up integration
                    <Icon name="arrow-right" size={15} />
                  </Button>
                </>
              }
            >
              <ActionPanel
                icon="bot"
                done={hasAgent}
                doneLabel={hasAgent && agents[0] ? `${agentLabel(agents[0])} created` : ''}
                title={hasAgent ? 'Agent created' : 'Create your first agent'}
                desc={
                  hasAgent
                    ? 'Add more later from the console — each with its own repo, model, and bot.'
                    : 'Give it a name, choose the Daemon and model, and point it at a GitHub repo and working directory.'
                }
                cta={hasAgent ? 'Create another' : 'Create an agent'}
                onCta={() => openModal('agent')}
              />
            </StepBody>
          )}

          {step === 2 && (
            <StepBody
              title="Set up integration"
              sub={`Give ${agents[0] ? agentLabel(agents[0]) : 'your agent'} a bot identity so it can read and post in a channel — Slack, Telegram, or Discord.`}
              footer={
                <>
                  <Button variant="ghost" onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <div className="flex-1" />
                  <Button onClick={goConsole}>
                    <Icon name="radio" size={15} />
                    {hasIntegration ? 'Go live' : 'Finish'}
                  </Button>
                </>
              }
            >
              <ActionPanel
                icon="plug"
                done={hasIntegration}
                doneLabel={hasIntegration ? 'Integration connected' : ''}
                title={hasIntegration ? 'Integration connected' : 'Connect a channel'}
                desc={
                  hasIntegration
                    ? 'Your agent can now read and post in the connected channel.'
                    : 'Assign a bot identity and pick a channel. This step is optional — you can do it later from the agent page.'
                }
                cta={hasIntegration ? 'Add another' : 'Set up integration'}
                onCta={() => agents[0] && openModal('integration', agents[0])}
              />
            </StepBody>
          )}

          {step === 3 && (
            <div className="flex flex-col items-start">
              <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-(--brand) text-white">
                <Icon name="check" size={30} />
              </span>
              <h2 className="mt-5 font-sans text-[26px] font-semibold leading-[1.15] tracking-[-.02em] text-(--text-primary)">
                You&rsquo;re live
              </h2>
              <p className="mt-2 max-w-[460px] font-sans text-[15px] font-normal leading-[1.55] text-(--text-secondary)">
                {agents[0] ? agentLabel(agents[0]) : 'Your agent'} is running on{' '}
                {daemons.find((d) => d.status === 'online')?.name ?? daemons[0]?.name ?? 'your Daemon'}. Open the
                console to watch its first session.
              </p>
              <div className="mt-7">
                <Button size="lg" onClick={goConsole}>
                  Go to console
                  <Icon name="arrow-right" size={16} />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// A step's main column: heading + sub, content, and a bottom footer nav (divider above).
function StepBody({
  title,
  sub,
  children,
  footer
}: {
  title: string
  sub: string
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <div className="flex min-h-[420px] flex-col">
      <h2 className="font-sans text-[24px] font-semibold leading-[1.2] tracking-[-.02em] text-(--text-primary)">
        {title}
      </h2>
      <p className="mt-[6px] max-w-[620px] font-sans text-[14px] font-normal leading-[1.5] text-(--text-secondary)">
        {sub}
      </p>
      <div className="mt-[22px]">{children}</div>
      <div className="mt-8 flex items-center gap-[10px] border-t border-(--border-subtle) pt-5">{footer}</div>
    </div>
  )
}

// The 3-step progress rail — a left column on desktop, a horizontal strip on mobile.
function StepRail({ current }: { current: number }) {
  return (
    <div className="flex flex-none gap-2 desktop:w-60 desktop:flex-col desktop:gap-1 desktop:border-r desktop:border-(--border-subtle) desktop:pr-6">
      <div className="hidden font-mono text-[12px] font-semibold uppercase leading-none tracking-[.06em] text-(--text-tertiary) desktop:mb-[10px] desktop:block">
        Setup
      </div>
      {STEPS.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <div
            key={s.title}
            className={`flex flex-1 items-center gap-3 rounded-md px-[10px] py-[11px] desktop:flex-none ${
              active ? 'bg-(--surface-sunken)' : ''
            }`}
          >
            <span
              className={`flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full font-mono text-[12px] font-semibold ${
                done
                  ? 'bg-(--brand) text-white'
                  : active
                    ? 'border-2 border-(--brand) bg-(--surface-card) text-(--brand)'
                    : 'border-[1.5px] border-(--border-strong) bg-(--surface-app) text-(--text-tertiary)'
              }`}
            >
              {done ? <Icon name="check" size={15} /> : i + 1}
            </span>
            <div className="min-w-0">
              <div
                className={`truncate font-sans text-[13.5px] leading-normal ${
                  active || done ? 'font-semibold text-(--text-primary)' : 'font-medium text-(--text-secondary)'
                }`}
              >
                {s.title}
              </div>
              <div className="hidden truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:block">
                {s.sub}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Dark terminal block with Run / Install-as-service tabs + copy — the real minted join
// command (or a minting/error placeholder), matching AddDaemonModal's CommandBox.
function Terminal({ connect, err }: { connect: DaemonCommand | null; err: string | null }) {
  const cmds = connect ? daemonCommands(connect.command) : null
  const tabs = [
    { key: 'run', label: 'Run', command: cmds?.run ?? null },
    { key: 'service', label: 'Install as service', command: cmds?.login ?? null }
  ]
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const command = tabs[active]?.command ?? null
  const copy = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="overflow-hidden rounded-[10px] border border-(--gray-800) bg-(--gray-1000)">
      <div className="flex items-stretch border-b border-(--gray-800)">
        {tabs.map((tab, i) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => {
              setActive(i)
              setCopied(false)
            }}
            aria-selected={i === active}
            className={`inline-flex cursor-pointer items-center gap-[6px] border-0 border-b-2 bg-transparent px-[13px] py-[9px] font-mono text-[11px] font-medium leading-normal ${
              i === active
                ? 'border-(--magenta-300) text-[#cdd6e0]'
                : 'border-transparent text-(--text-inverse-dim) hover:text-[#cdd6e0]'
            }`}
          >
            <Icon name="terminal" size={13} />
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          onClick={copy}
          disabled={!command}
          className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent px-[13px] py-[9px] font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim) disabled:cursor-default disabled:opacity-50"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div className="break-all px-[16px] py-[15px] font-mono text-[12.5px] leading-[1.75] text-[#cdd6e0]">
        {command ? (
          <div>
            <span className="text-(--magenta-300)">$</span> {command}
          </div>
        ) : err ? (
          <div className="text-(--status-error)">Could not provision a key — {err}</div>
        ) : (
          <div className="text-(--text-inverse-dim)">Minting key…</div>
        )}
      </div>
    </div>
  )
}

// The connected / waiting daemon card under the terminal.
function ConnectedCard({
  online,
  name,
  host,
  version,
  resumed,
  resumedName
}: {
  online: boolean
  name?: string
  host?: string
  version?: string
  resumed?: boolean
  resumedName?: string
}) {
  if (resumed) {
    return (
      <div className="mt-4 flex items-center gap-[11px] rounded-[10px] border border-(--brand-soft-border) bg-(--brand-soft) px-[14px] py-[13px]">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-(--brand-soft-border) bg-(--surface-card)">
          <Icon name="server" size={19} color="var(--brand)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            {resumedName ?? 'A daemon'} already connected
          </div>
          <div className="mono text-[12px] text-(--text-secondary)">Continue to the next step.</div>
        </div>
      </div>
    )
  }
  return (
    <div className="mt-4 flex items-center gap-[11px] rounded-[10px] border border-dashed border-(--border-strong) px-[14px] py-[13px]">
      {online ? (
        <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-(--status-online)">
          <Icon name="check" size={13} color="#fff" />
        </span>
      ) : (
        <span className="flex-none leading-[0]">
          <Spinner size={22} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
          {online ? `${name ?? 'Daemon'} connected` : 'Waiting for daemon…'}
        </div>
        <div className="mono text-[12px] text-(--text-tertiary)">
          {online ? `${host ?? ''}${version ? ` · v${version}` : ''}` : "It'll appear here once it connects."}
        </div>
      </div>
      {online ? (
        <span className="flex flex-none items-center gap-[6px] rounded-full bg-(--status-online-soft) px-[9px] py-[3px]">
          <span className="h-[7px] w-[7px] rounded-full bg-(--status-online)" />
          <span className="font-mono text-[11px] font-medium leading-normal text-[#0f7a48]">online</span>
        </span>
      ) : null}
    </div>
  )
}

// A centered call-to-action panel for the agent / integration steps: an icon, a title +
// description, a completion chip once done, and the primary button that opens the modal.
function ActionPanel({
  icon,
  title,
  desc,
  cta,
  onCta,
  done,
  doneLabel
}: {
  icon: string
  title: string
  desc: string
  cta: string
  onCta: () => void
  done: boolean
  doneLabel: string
}) {
  return (
    <div className="flex flex-col items-start rounded-[10px] border border-(--border-subtle) bg-(--surface-app) px-6 py-7">
      <span className="flex h-11 w-11 items-center justify-center rounded-md bg-(--brand-soft) text-(--brand-soft-text)">
        <Icon name={icon} size={22} />
      </span>
      {done && doneLabel ? (
        <div className="mt-4 inline-flex items-center gap-2 rounded-md bg-(--brand-soft) px-3 py-2">
          <Icon name="check" size={14} className="text-(--brand-soft-text)" />
          <span className="font-sans text-[12.5px] font-medium leading-normal text-(--brand-soft-text)">
            {doneLabel}
          </span>
        </div>
      ) : null}
      <div className="mt-4 font-sans text-[16px] font-semibold leading-normal text-(--text-primary)">{title}</div>
      <p className="mt-[3px] max-w-[520px] font-sans text-[13px] font-normal leading-[1.5] text-(--text-tertiary)">
        {desc}
      </p>
      <div className="mt-5">
        <Button variant={done ? 'secondary' : 'primary'} onClick={onCta}>
          <Icon name="plus" size={15} />
          {cta}
        </Button>
      </div>
    </div>
  )
}
