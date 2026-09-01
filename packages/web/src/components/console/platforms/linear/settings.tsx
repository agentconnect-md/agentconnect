'use client'

// The Linear WORKSPACE CARD (linear-integration.md §7.4, §9.5). A Linear bot row IS
// one connected workspace, so what the Settings → Bots card needs beside it is not a
// bot adornment but a small membership surface: who is on the workspace, which member
// catches a bare delegation, and how to repair a grant that stopped working.
//
// The state lives behind the module's own context (the contract's
// `lifecycleActions.CardProvider`), mounted once per platform tab, because the row
// action and the card notice drive the SAME reconnect round trip and must not each
// open their own.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AgentIconView } from '@/components/marks'
import { Icon } from '@/components/ui'
import type { BotDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import type { WebBotSettingsFragments } from '../contract'
import { linearApi } from './api'
import { useLinearConnect } from './connect'

/**
 * The member a bare delegation reaches: the workspace's persisted pointer, or —
 * while none is set — the earliest member, which is what the orchestrator's compile
 * falls back to. Null on a workspace with no members left.
 */
export function linearDefaultAgentId(bot: Pick<BotDto, 'preferredAgentId' | 'agentIds'>): string | null {
  const preferred = bot.preferredAgentId
  if (preferred && bot.agentIds.includes(preferred)) return preferred
  return bot.agentIds[0] ?? null
}

/** Why the default member's Remove control is inert (§7.4): a workspace with members
 *  but no default would strand every bare delegation. */
export const LINEAR_DEFAULT_REMOVE_BLOCKED = 'Make another agent the default first'

interface LinearCardState {
  /** The workspace whose reconnect round trip is open, if any. */
  reconnectingBotId: string | null
  connectErr: string | null
  startReconnect(botId: string): void
  /** The workspace whose membership write is in flight — one per card. */
  busyBotId: string | null
  rowErr: { botId: string; message: string } | null
  moveDefault(bot: BotDto, agentId: string): void
  removeMember(bot: BotDto, integrationId: string): void
}

const CardCtx = createContext<LinearCardState | null>(null)

function useLinearCard(): LinearCardState {
  const state = useContext(CardCtx)
  if (!state) throw new Error('Linear settings fragment rendered outside its CardProvider')
  return state
}

function LinearCardProvider({ children }: { children: ReactNode }) {
  const { refresh, deleteIntegration } = useConsoleData()
  const [reconnectingBotId, setReconnectingBotId] = useState<string | null>(null)
  const [busyBotId, setBusyBotId] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<{ botId: string; message: string } | null>(null)
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
      setRowErr(null)
      clearError()
      start()
    },
    [clearError, start]
  )

  const write = useCallback(async (botId: string, run: () => Promise<unknown>) => {
    setBusyBotId(botId)
    setRowErr(null)
    try {
      await run()
    } catch (e) {
      setRowErr({ botId, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyBotId(null)
    }
  }, [])

  const moveDefault = useCallback(
    (bot: BotDto, agentId: string) => {
      void write(bot.id, async () => {
        await linearApi.setDefaultAgent(bot.id, agentId)
        await refresh()
      })
    },
    [refresh, write]
  )

  const removeMember = useCallback(
    (bot: BotDto, integrationId: string) => {
      void write(bot.id, () => deleteIntegration(integrationId))
    },
    [deleteIntegration, write]
  )

  // The round trip is not open once it settles, whichever way it went.
  const openBotId = flow.phase === 'authorizing' ? reconnectingBotId : null
  const value = useMemo<LinearCardState>(
    () => ({
      reconnectingBotId: openBotId,
      connectErr: flow.appMissing ? 'Linear isn’t set up on this deployment.' : flow.err,
      startReconnect,
      busyBotId,
      rowErr,
      moveDefault,
      removeMember
    }),
    [busyBotId, flow.appMissing, flow.err, moveDefault, openBotId, removeMember, rowErr, startReconnect]
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
 * The workspace card body, under the bot row: connect status, the member agents with
 * the default marked and movable, and the Reconnect CTA.
 *
 * The CTA is offered on a LIVE workspace too, not only a dead grant. Enabling agent
 * session events on an already-installed Linear app raises a new scope, and until
 * every prior authorization re-consents the workspace keeps a perfectly valid token
 * while receiving nothing (§15) — so the repair has to be reachable from the healthy
 * state as well.
 */
function LinearCardNotice({ bot }: { bot: BotDto }) {
  const card = useLinearCard()
  const { getAgent, integrations } = useConsoleData()
  if (bot.platform !== 'linear') return null

  // staleness signal not yet exposed — the CP publishes no `lastDeliveryAt`, so a
  // webhook-silent workspace is reachable only through the always-offered CTA below.
  const dead = !!bot.revokedAt
  const defaultAgentId = linearDefaultAgentId(bot)
  const open = card.reconnectingBotId === bot.id
  const busy = card.busyBotId === bot.id
  // Live rows carry an id; a demo row does not, and its member cannot be removed.
  const integrationIdOf = (agentId: string): string | undefined =>
    integrations.find((row) => row.botId === bot.id && row.agentId === agentId)?.id

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
      {bot.agentIds.length > 0 && (
        <div className="mt-[10px] overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card)">
          {bot.agentIds.map((agentId) => {
            const agent = getAgent(agentId)
            const isDefault = agentId === defaultAgentId
            const integrationId = integrationIdOf(agentId)
            return (
              <div
                key={agentId}
                className="flex items-center gap-[10px] border-b border-(--border-subtle) px-3 py-2 last:border-b-0"
              >
                <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                  <AgentIconView icon={agent?.icon} runtime={agent?.runtime || agent?.model || ''} size={22} />
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[12px]">{agent ? agentLabel(agent) : agentId}</span>
                {isDefault ? (
                  <span
                    className="badge flex-none bg-(--surface-active) text-(--text-secondary)"
                    title="Bare delegations start a session with this agent"
                  >
                    default
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => card.moveDefault(bot, agentId)}
                    className={`chip flex-none px-[9px] py-[3px] text-[11.5px] ${busy ? 'cursor-default opacity-55' : 'cursor-pointer'}`}
                  >
                    Make default
                  </button>
                )}
                <button
                  type="button"
                  disabled={isDefault || busy || !integrationId}
                  title={isDefault ? LINEAR_DEFAULT_REMOVE_BLOCKED : 'Remove this agent from the workspace'}
                  aria-label={`Remove ${agent ? agentLabel(agent) : agentId} from the workspace`}
                  onClick={() => integrationId && card.removeMember(bot, integrationId)}
                  className={`iconbtn h-7 w-7 flex-none ${
                    isDefault || busy || !integrationId ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'
                  }`}
                >
                  <Icon name="user-minus" size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {card.rowErr?.botId === bot.id && (
        <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-[1.4] text-(--status-error)">
          {card.rowErr.message}
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
