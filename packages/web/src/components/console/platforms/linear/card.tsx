'use client'

// The AGENT page's Linear card ({@link WebAgentIntegrationCardFacet}). The host header
// already names the connected workspace and carries the unlink, so the module adds only
// what is Linear's: Reconnect in that header's action track (§7.4) and, beneath it, the
// generic conversation list of the workspace's TEAM rows (§4.3, §9.5). The team is the
// channel, so the dispatch selector and the trigger live on those rows.
// Disconnecting ends the workspace for every agent, so that action is the org view's.

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
import { IntegrationChannelList } from '@/components/console/IntegrationChannelList'
import { type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { linearApi } from './api'
import { useLinearConnect, type LinearConnectFlow } from './connect'

/** One reconnect round trip per card, shared by the header button that starts it and the
 *  band that reports it — two halves the host renders in places that share no state. */
interface LinearCardState {
  flow: LinearConnectFlow
  /** A funnel that could not start, as a sentence — the header button has nowhere to put it. */
  err: string | null
  /** The grant is known dead (`rc/bot-revoked`), so the repair is the lit one. */
  dead: boolean
}

const CardCtx = createContext<LinearCardState | null>(null)

/** Card-scope state carrier, not chrome: it renders its children unchanged. */
export function LinearWorkspaceCard({ integration, children }: { integration: IntegrationRow; children: ReactNode }) {
  const { bots, refresh } = useConsoleData()
  const botId = integration.botId ?? ''
  const bot = bots.find((b) => b.id === botId)
  const flow = useLinearConnect(
    () => linearApi.reconnect(botId),
    () => void refresh()
  )
  const dead = !!bot?.revokedAt
  const value = useMemo<LinearCardState>(
    () => ({ flow, err: flow.appMissing ? 'Linear isn’t set up on this deployment.' : flow.err, dead }),
    [dead, flow]
  )
  return <CardCtx.Provider value={value}>{children}</CardCtx.Provider>
}

/** The workspace's one repair, in the header's action track beside the host's unlink.
 *  Haloed while the grant is known dead — the same needs-attention shape Slack's refresh uses. */
export function LinearWorkspaceHeaderActions() {
  const card = useContext(CardCtx)
  if (!card) return null
  const reconnecting = card.flow.phase === 'authorizing'
  return (
    <>
      {card.dead && (
        <span className="badge flex-none bg-(--status-error-soft) text-(--status-error)">grant expired</span>
      )}
      <button
        type="button"
        disabled={reconnecting}
        title={reconnecting ? 'Waiting for Linear…' : 'Reconnect this workspace'}
        aria-label="Reconnect this workspace"
        onClick={card.flow.start}
        className={`iconbtn h-7 w-7 flex-none ${card.dead ? 'border-(--status-error) text-(--status-error)' : ''} ${
          reconnecting ? 'cursor-default opacity-55' : 'cursor-pointer'
        }`}
      >
        <Icon name={reconnecting ? 'loader' : 'refresh-cw'} size={13} className={reconnecting ? 'animate-spin' : ''} />
      </button>
    </>
  )
}

export function LinearWorkspaceRows({ integration, padX }: { integration: IntegrationRow; padX: number }) {
  const { getAgent } = useConsoleData()
  const card = useContext(CardCtx)
  const reconnecting = card?.flow.phase === 'authorizing'
  // The page's agent — a private one starts every team row off, as on any platform.
  const agent = integration.agentId ? getAgent(integration.agentId) : undefined

  return (
    <>
      {card?.err && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
          style={{ padding: `9px ${padX}px` }}
        >
          <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
          <span>{card.err}</span>
        </div>
      )}
      {reconnecting && (
        <div
          className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-app) font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)"
          style={{ padding: `10px ${padX}px` }}
        >
          <Icon name="info" size={14} className="mt-[3px] flex-none" />
          <span>Approve the workspace in the Linear tab — this card updates once it lands.</span>
        </div>
      )}
      {/* Sharing is structural on a Linear bot (§4.3), so every team row carries the dispatch selector. */}
      <IntegrationChannelList
        integrationId={integration.id}
        channels={integration.channels}
        botId={integration.botId}
        agentId={integration.agentId}
        platform={integration.platform}
        shareable={integration.shareable ?? true}
        gated={agent?.visibility === 'restricted'}
        padX={padX}
      />
    </>
  )
}
