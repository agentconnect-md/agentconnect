'use client'

// The Linear WORKSPACE CARD (linear-integration.md §7.4, §9.5). A Linear bot row IS
// one connected workspace, so what the Settings → Bots card shows beside it is the
// workspace's own identity and health, plus the way to repair a grant that stopped
// working.
//
// The state lives behind the module's own context (the contract's
// `lifecycleActions.CardProvider`), mounted once per platform tab, because the row
// action and the card notice drive the SAME reconnect round trip and must not each
// open their own.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
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

  // The round trip is not open once it settles, whichever way it went.
  const openBotId = flow.phase === 'authorizing' ? reconnectingBotId : null
  const value = useMemo<LinearCardState>(
    () => ({
      reconnectingBotId: openBotId,
      connectErr: flow.appMissing ? 'Linear isn’t set up on this deployment.' : flow.err,
      startReconnect
    }),
    [flow.appMissing, flow.err, openBotId, startReconnect]
  )

  return <CardCtx.Provider value={value}>{children}</CardCtx.Provider>
}

/** The row's Reconnect control, in the card's 100px action track. Haloed while the
 *  grant is known dead — the same needs-attention shape Slack's refresh uses. */
function LinearRowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const card = useLinearCard()
  const open = card.reconnectingBotId === bot.id
  const dead = !!bot.revokedAt
  return (
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
  )
}

/**
 * The workspace card body, under the bot row: connect status and the Reconnect CTA.
 *
 * The CTA is offered on a LIVE workspace too, not only a dead grant. Enabling agent
 * session events on an already-installed Linear app raises a new scope, and until
 * every prior authorization re-consents the workspace keeps a perfectly valid token
 * while receiving nothing (§15) — so the repair has to be reachable from the healthy
 * state as well.
 */
function LinearCardNotice({ bot }: { bot: BotDto }) {
  const card = useLinearCard()
  if (bot.platform !== 'linear') return null

  // staleness signal not yet exposed — the CP publishes no `lastDeliveryAt`, so a
  // webhook-silent workspace is reachable only through the always-offered CTA below.
  const dead = !!bot.revokedAt
  const open = card.reconnectingBotId === bot.id

  return (
    <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-[10px] pl-10">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`badge ${dead ? 'bg-(--status-error-soft) text-(--status-error)' : 'bg-(--surface-active) text-(--text-tertiary)'}`}
        >
          {dead ? 'grant expired' : 'connected'}
        </span>
        <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">
          {bot.workspaceName || bot.name}
        </span>
        <span className="min-w-0 flex-1 font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
          {dead
            ? 'Linear no longer accepts this workspace’s grant — reconnect to restore delivery.'
            : 'Delegations not arriving? Reconnect to re-consent the workspace’s event subscription.'}
        </span>
      </div>
      {card.connectErr && card.reconnectingBotId === null && (
        <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-[1.4] text-(--status-error)">
          {card.connectErr}
        </div>
      )}
      {open && (
        <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
          Approve the workspace in the Linear tab — this card updates once it lands.
        </div>
      )}
    </div>
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
