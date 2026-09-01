// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
import type { Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import type { WizardHost } from '../contract'
import { useDeploymentConfig } from '../deployment-config'
import { usePublishedFooter, usePublishedIdentityChrome } from '../publish'
import { linearApi } from './api'
import { linearConnectAvailability, useLinearConnect } from './connect'
import { linearLinkInput } from './link'
import { LinearMark } from './mark'

// The pane's two button shapes. Literal class strings, never assembled — Tailwind's
// scanner only sees full literals in the source text (STYLE.md §8).
const PRIMARY =
  'flex h-[46px] w-full items-center justify-center gap-[10px] rounded-[10px] border-0 bg-(--surface-inverse) font-sans text-[14px] font-semibold leading-normal text-white'
const SECONDARY =
  'flex h-8 flex-none cursor-pointer items-center rounded-[8px] border border-(--border-default) bg-(--surface-card) px-3 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)'

/**
 * Linear's wizard pane — "which workspace does this agent work in?"
 * (linear-integration.md §4.3, §7.1).
 *
 * It REPLACES the host's identity chassis rather than filling a slot in it. The
 * chassis asks a question Linear does not have: a Linear bot is not an identity you
 * create with pasted credentials and then hand to one agent, it is a workspace the
 * organization connected once, and every agent on it is a member. So the pane hides
 * the mode cards, the free-bot list and the footer primary, and offers the two
 * choices that do exist — link an already-connected workspace, or connect another.
 *
 * With none connected there is nothing to pick from, so the pane LANDS on the connect
 * hand-off. It does not fire one: the authorize tab is a popup, and a popup opened
 * from an effect rather than from a click is blocked by default in every major
 * browser — a first run that silently opens nothing. Zero-config means no fields to
 * fill, not no button to press.
 */
export function LinearWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  // The chassis reads this same probe for its relay capability; one SWR key ⇒ one
  // request. Only the "has it answered yet" bit is read here — the VALUE comes off
  // the host, so the two can never disagree about the deployment.
  const probe = useDeploymentConfig(true)
  const { bots, loading } = useConsoleData()
  const { createIntegration, invalidate, close } = host
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [linkingBotId, setLinkingBotId] = useState<string | null>(null)
  const [linkErr, setLinkErr] = useState<string | null>(null)

  const flow = useLinearConnect(
    () => linearApi.startConnect(agent.id),
    () => {
      invalidate()
      setConnected(true)
    }
  )
  const { start, cancel } = flow

  // An answer WINS over a later error: a transient revalidation failure must not
  // retract a relay this pane already learned about (the Slack funnel's rule).
  const relayAvailable: boolean | null = probe.config ? host.relayCapability.available : probe.failed ? false : null
  const availability = linearConnectAvailability({
    relayAvailable,
    appConfigured: flow.appMissing ? false : null
  })

  const workspaces = bots.filter((b) => b.platform === 'linear')
  // No workspace to pick means no choice to present — the pane IS the connect
  // hand-off then, and cancelling it leaves the wizard rather than an empty list.
  const forcedConnect = !loading && workspaces.length === 0
  // `connected` holds the pane on its terminal state: the refresh that lands with a
  // completed round trip is exactly what would otherwise flip the roster from empty to
  // one workspace and replace the success line with a picker.
  const pane: 'picker' | 'connect' = connected || connecting || forcedConnect ? 'connect' : 'picker'

  // The whole identity chassis is this pane's to replace: mode cards, free-bot list,
  // the share toggle and the footer primary all describe a model Linear does not have.
  usePublishedIdentityChrome(host, { hidden: true })
  usePublishedFooter(host, { label: 'Connect', enabled: false, onSubmit: () => {}, hidden: true })

  const link = (botId: string) => {
    if (linkingBotId) return
    setLinkingBotId(botId)
    setLinkErr(null)
    void (async () => {
      try {
        await createIntegration(linearLinkInput(agent.id, botId))
        close()
      } catch (e) {
        setLinkErr(e instanceof Error ? e.message : String(e))
        setLinkingBotId(null)
      }
    })()
  }

  // Back from a pane the operator chose; from the forced one there is nowhere to go but
  // out, and the host footer's own Cancel is what the gate leaves that job to.
  const leaveConnect = () => {
    cancel()
    if (forcedConnect) close()
    else setConnecting(false)
  }

  if (availability === 'checking') {
    return (
      <Frame>
        <div className="flex items-center gap-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="loader" size={15} className="flex-none animate-spin" />
          Checking your Linear setup…
        </div>
      </Frame>
    )
  }

  if (availability === 'app_required') {
    return (
      <Frame>
        <Note>
          Linear isn&rsquo;t set up on this deployment yet. An administrator registers one Linear OAuth application for
          the whole deployment before workspaces can be connected.
        </Note>
      </Frame>
    )
  }

  if (availability === 'relay_required') {
    return (
      <Frame>
        <Note>
          Linear delivers over HTTP callbacks only, so it needs a public callback endpoint. Ask an administrator to
          configure one, then connect a workspace here.
        </Note>
      </Frame>
    )
  }

  if (pane === 'connect') {
    return (
      <Frame>
        {connected ? (
          <>
            <div className="flex items-start gap-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              <Icon name="check" size={15} color="var(--status-online)" className="mt-[1px] flex-none" />
              <span>
                Workspace connected —&#32;<span className="mono">{agent.name}</span>&#32;is now its default agent, the
                one a bare delegation starts a session with.
              </span>
            </div>
            <button type="button" onClick={close} className={`${PRIMARY} mt-[12px] cursor-pointer`}>
              Done
            </button>
          </>
        ) : flow.err ? (
          <>
            <div className="flex items-start gap-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
              <Icon name="triangle-alert" size={15} className="mt-[1px] flex-none" />
              <span>{flow.err}</span>
            </div>
            <div className="mt-[12px] flex items-center gap-2">
              <button type="button" onClick={start} className={`${PRIMARY} cursor-pointer`}>
                Try again
              </button>
              <button type="button" onClick={leaveConnect} className={SECONDARY}>
                {forcedConnect ? 'Cancel' : 'Back'}
              </button>
            </div>
          </>
        ) : flow.phase === 'authorizing' ? (
          <>
            <div className={`${PRIMARY} opacity-85`}>
              <Icon name="loader" size={16} className="flex-none animate-spin" />
              Waiting for Linear…
            </div>
            <div className="mt-[10px] flex items-center justify-between gap-2">
              <span className="font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                Approve the workspace in the Linear tab.
              </span>
              <button type="button" onClick={leaveConnect} className={SECONDARY}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-[12px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              <span className="mono">{agent.name}</span>&#32;becomes the workspace&rsquo;s default agent — the one a
              bare delegation starts a session with. There is nothing to fill in here: you approve the workspace in a
              Linear popup.
            </div>
            {/* The popup opens from THIS click. Fired from an effect it is blocked. */}
            <button type="button" onClick={start} className={`${PRIMARY} cursor-pointer`}>
              <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                <LinearMark fillPct={100} />
              </span>
              Connect Linear
            </button>
            {!forcedConnect && (
              <div className="mt-[10px] flex justify-end">
                <button type="button" onClick={leaveConnect} className={SECONDARY}>
                  Back
                </button>
              </div>
            )}
          </>
        )}
      </Frame>
    )
  }

  return (
    <div className="mb-4 overflow-hidden rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[6px]">
      <div className="px-2 pb-[6px] pt-[5px] font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">
        Pick the Linear workspace <span className="mono">{agent.name}</span> works in.
      </div>
      {workspaces.map((b) => {
        const linked = b.agentIds.includes(agent.id)
        return (
          <button
            key={b.id}
            type="button"
            disabled={linked || linkingBotId !== null}
            title={linked ? 'Already linked to this agent' : b.workspaceName || b.name}
            onClick={() => link(b.id)}
            className={`fopt min-h-[42px] items-center gap-[10px] px-2 py-2 ${
              linked || linkingBotId !== null ? 'cursor-default' : 'cursor-pointer'
            } ${linked ? 'opacity-55' : ''}`}
          >
            <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
              <LinearMark fillPct={100} />
            </span>
            <span className="mono min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold text-(--text-primary)">
              {b.workspaceName || b.name}
            </span>
            {linked && <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">linked</span>}
            {linkingBotId === b.id && <Icon name="loader" size={14} className="flex-none animate-spin" />}
          </button>
        )
      })}
      <button
        type="button"
        disabled={linkingBotId !== null}
        onClick={() => setConnecting(true)}
        className={`fopt min-h-[42px] items-center gap-[10px] px-2 py-2 ${
          linkingBotId !== null ? 'cursor-default opacity-55' : 'cursor-pointer'
        }`}
      >
        <Icon name="plus" size={15} color="var(--text-tertiary)" className="flex-none" />
        <span className="min-w-0 flex-1 truncate text-left font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
          Connect another workspace…
        </span>
      </button>
      {linkErr && (
        <div className="px-2 pb-[6px] pt-1 font-sans text-[11.5px] font-normal leading-[1.4] text-(--status-error)">
          {linkErr}
        </div>
      )}
    </div>
  )
}

/** The pane's own card, so every state sits in one box the wizard can measure. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">{children}</div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
      <Icon name="info" size={15} className="mt-[1px] flex-none" />
      <span>{children}</span>
    </div>
  )
}
