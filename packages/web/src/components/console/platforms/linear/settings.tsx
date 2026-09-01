'use client'

// The ORG Bots view's Linear fragments (linear-integration.md §7.4, §9.5). A Linear
// bot row IS one connected workspace, so what the row gains here are the two actions
// that belong to the workspace as a whole rather than to any one agent: re-authorize
// the grant, and disconnect it for the organization.
//
// Disconnect lives ONLY here. An agent's own card can unlink itself from a workspace;
// removing the workspace for everyone is an org-level decision, and offering it beside
// a single membership would let one member end every other member's access by
// mistake.
//
// The state lives behind the module's own context (the contract's
// `lifecycleActions.CardProvider`), mounted once per platform tab, because the row
// action and the card notice drive the SAME reconnect round trip and must not each
// open their own.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Icon } from '@/components/ui'
import type { BotDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import type { WebBotSettingsFragments } from '../contract'
import { linearApi } from './api'
import { useLinearConnect } from './connect'

interface LinearCardState {
  /** The workspace whose reconnect round trip is open, if any. */
  reconnectingBotId: string | null
  connectErr: string | null
  startReconnect(botId: string): void
  /** The workspace whose disconnect confirmation is open, if any. */
  disconnectingBotId: string | null
  askDisconnect(botId: string | null): void
}

const CardCtx = createContext<LinearCardState | null>(null)

function useLinearCard(): LinearCardState {
  const state = useContext(CardCtx)
  if (!state) throw new Error('Linear settings fragment rendered outside its CardProvider')
  return state
}

function LinearCardProvider({ children }: { children: ReactNode }) {
  const { refresh } = useConsoleData()
  const [reconnectingBotId, setReconnectingBotId] = useState<string | null>(null)
  const [disconnectingBotId, setDisconnectingBotId] = useState<string | null>(null)
  // The bot the pending mint is for. A ref, not the state above: `start()` reads its
  // mint closure in the same tick as the click, before a setState has landed.
  const target = useRef<string | null>(null)

  const flow = useLinearConnect(
    () => linearApi.reconnect(target.current ?? ''),
    () => {
      setReconnectingBotId(null)
      void refresh()
    }
  )

  const { start, clearError } = flow
  const startReconnect = useCallback(
    (botId: string) => {
      target.current = botId
      setReconnectingBotId(botId)
      clearError()
      start()
    },
    [clearError, start]
  )
  const askDisconnect = useCallback((botId: string | null) => setDisconnectingBotId(botId), [])

  // The round trip is not open once it settles, whichever way it went.
  const openBotId = flow.phase === 'authorizing' ? reconnectingBotId : null
  const value = useMemo<LinearCardState>(
    () => ({
      reconnectingBotId: openBotId,
      connectErr: flow.appMissing ? 'Linear isn’t set up on this deployment.' : flow.err,
      startReconnect,
      disconnectingBotId,
      askDisconnect
    }),
    [askDisconnect, disconnectingBotId, flow.appMissing, flow.err, openBotId, startReconnect]
  )

  return <CardCtx.Provider value={value}>{children}</CardCtx.Provider>
}

/** The workspace's two lifecycle actions, in the card's 100px action track. Reconnect
 *  is haloed while the grant is known dead — the same needs-attention shape Slack's
 *  refresh uses. */
function LinearRowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const card = useLinearCard()
  const open = card.reconnectingBotId === bot.id
  const dead = !!bot.revokedAt
  return (
    <>
      <button
        type="button"
        disabled={!canWrite || open}
        title={open ? 'Waiting for Linear…' : 'Reconnect this workspace'}
        aria-label="Reconnect this workspace"
        onClick={() => card.startReconnect(bot.id)}
        className={`iconbtn h-7 w-7 flex-none ${dead ? 'border-(--status-error) text-(--status-error)' : ''} ${
          open ? 'cursor-default opacity-55' : 'cursor-pointer'
        }`}
      >
        <Icon name={open ? 'loader' : 'refresh-cw'} size={13} className={open ? 'animate-spin' : ''} />
      </button>
      {canWrite && (
        <button
          type="button"
          title="Disconnect this workspace"
          aria-label="Disconnect this workspace"
          onClick={() => card.askDisconnect(bot.id)}
          className="iconbtn h-7 w-7 flex-none cursor-pointer"
        >
          <Icon name="unplug" size={13} />
        </button>
      )}
    </>
  )
}

/**
 * Confirm disconnecting one workspace for the whole organization.
 *
 * ONE server call, never a client loop over `integrations`: that list is
 * visibility-filtered, so a member on an agent outside the caller's audience is
 * invisible here — a loop would lift the memberships it can see and the bot delete
 * behind it would refuse on the one it never knew about, leaving the workspace half
 * unlinked after the operator confirmed a full disconnect. The authoritative member
 * set only exists server-side, so the whole teardown does too; a partial one comes
 * back as an error naming what is still linked.
 */
function DisconnectWorkspaceModal({ bot, onClose }: { bot: BotDto; onClose: () => void }) {
  const { refresh } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const name = bot.workspaceName || bot.name
  // A workspace normally has members — the first connect makes one — but every one can
  // be unlinked, and "all 0 agents" is not a sentence. The count is the VISIBLE one, so
  // it describes rather than bounds what the call removes.
  const members = bot.agentIds.length
  const audience =
    members === 0 ? 'this organization' : members === 1 ? 'the agent that uses it' : `all ${members} agents that use it`

  const disconnect = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await linearApi.disconnect(bot.id)
      await refresh()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <Icon name="unplug" size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Disconnect workspace</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          <span className="mono text-(--text-primary)">{name}</span>&#32;is removed for {audience}, and AgentConnect
          forgets its Linear grant. Delegations in that workspace stop reaching any agent. Connecting it again is a
          fresh authorization in Linear.
        </p>
        <p className="mt-[10px] mb-0 font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
          Agents you cannot see are removed too — the workspace is disconnected for the whole organization.
        </p>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={disconnect} className={busy ? 'pointer-events-none opacity-50' : undefined}>
          <Icon name="unplug" size={15} />
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </div>
    </>
  )
}

/**
 * The card's per-bot band, rendered only when there is something to say: a reconnect
 * waiting on the Linear tab, or a funnel that could not start. It also HOSTS the
 * disconnect dialog its sibling row action opens — the action track is a `<span>`
 * cell, while this fragment renders as a block row of the card.
 *
 * It deliberately no longer narrates a healthy workspace. The row already carries its
 * connect state — the host's own `revoked` badge and the haloed Reconnect — and a
 * standing "delegations not arriving?" band on every live workspace reads as a
 * problem report rather than as chrome.
 */
function LinearCardNotice({ bot }: { bot: BotDto }) {
  const card = useLinearCard()
  if (bot.platform !== 'linear') return null
  const open = card.reconnectingBotId === bot.id
  const err = card.reconnectingBotId === null ? card.connectErr : null
  const disconnecting = card.disconnectingBotId === bot.id
  if (!open && !err && !disconnecting) return null

  return (
    <>
      {(open || err) && (
        <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-[10px] pl-10">
          <div
            className={`font-sans text-[12px] font-normal leading-[1.45] ${err ? 'text-(--status-error)' : 'text-(--text-tertiary)'}`}
          >
            {err ?? 'Approve the workspace in the Linear tab — this card updates once it lands.'}
          </div>
        </div>
      )}
      {disconnecting && (
        <div className="scrim" onClick={() => card.askDisconnect(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <DisconnectWorkspaceModal bot={bot} onClose={() => card.askDisconnect(null)} />
          </div>
        </div>
      )}
    </>
  )
}

export const linearSettingsFragments: WebBotSettingsFragments = {
  lifecycleActions: { CardProvider: LinearCardProvider, RowActions: LinearRowActions, CardNotice: LinearCardNotice },
  copy: {
    // A Linear bot row is a connected WORKSPACE, so the card's heading, delete
    // tooltip and empty state all read that word rather than "bot".
    identityNoun: 'workspace',
    // Linear can genuinely reach `revokedAt`: the `OAuthApp revoked` doorbell stamps
    // it and flips every membership (§7.4), and reconnecting is what repairs it.
    revokedHint: 'This workspace revoked the Linear app — reconnect to restore delivery',
    // A connected workspace is definitionally multi-agent (§4.3): the provider stamps
    // `shareable: true` structurally, so the toggle is never the operator's lever.
    shareHint: {
      available: 'Every connected Linear workspace serves all of its member agents',
      unavailable: 'Every connected Linear workspace serves all of its member agents'
    }
  }
}
