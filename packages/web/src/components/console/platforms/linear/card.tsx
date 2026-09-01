'use client'

// The AGENT page's Linear card body ({@link WebAgentIntegrationCardFacet}). Linking is the
// consent act and unlinking is the mute, so the row carries no trigger and no issue list.
// Disconnecting ends the workspace for every agent, so that action is the org view's.

import { useState } from 'react'
import { Icon } from '@/components/ui'
import { DefaultDispatchPicker } from '@/components/console/DefaultDispatchPicker'
import { agentLabel, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { linearApi } from './api'
import { useLinearConnect } from './connect'

export function LinearWorkspaceRows({ integration, padX }: { integration: IntegrationRow; padX: number }) {
  const { bots, getAgent, setChannelAgent, deleteIntegration, refresh } = useConsoleData()
  const [err, setErr] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const botId = integration.botId ?? ''
  const bot = bots.find((b) => b.id === botId)
  const flow = useLinearConnect(
    () => linearApi.reconnect(botId),
    () => void refresh()
  )

  // The seeded workspace row: the default rides the same PATCH a Slack row makes.
  const channel = integration.channels[0]
  const memberIds = bot?.agentIds ?? []
  const options = memberIds.map((id) => {
    const a = getAgent(id)
    return {
      id,
      name: a ? agentLabel(a) : id,
      model: a?.model || a?.runtime || '',
      runtime: a?.runtime || a?.model || '',
      icon: a?.icon
    }
  })
  // The CP-stamped owner; unclaimed falls back to the earliest member, as the CP does.
  const owner = channel?.agentId ?? memberIds[0] ?? null
  const name = bot?.workspaceName || bot?.name || integration.name
  const dead = !!bot?.revokedAt
  const reconnecting = flow.phase === 'authorizing'
  const connectErr = flow.appMissing ? 'Linear isn’t set up on this deployment.' : flow.err

  const unlink = () => {
    if (leaving || !integration.id) return
    if (!window.confirm(`Remove ${name} from this agent? It stays connected for the organization's other agents.`)) {
      return
    }
    setLeaving(true)
    setErr(null)
    void (async () => {
      try {
        await deleteIntegration(integration.id!)
      } catch (cause) {
        setErr(cause instanceof Error ? cause.message : String(cause))
        setLeaving(false)
      }
    })()
  }

  return (
    <>
      {(err || connectErr) && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
          style={{ padding: `9px ${padX}px` }}
        >
          <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
          <span>{err ?? connectErr}</span>
        </div>
      )}
      <div
        className="flex flex-wrap items-center gap-x-[10px] gap-y-2 border-t border-(--border-subtle) bg-(--surface-app)"
        style={{ padding: `10px ${padX}px` }}
      >
        <span className="mono min-w-0 flex-1 truncate text-[13px] text-(--text-primary)" title={name}>
          {name}
        </span>
        {dead && <span className="badge flex-none bg-(--status-error-soft) text-(--status-error)">grant expired</span>}
        <div className="ml-auto flex items-center gap-[10px] max-desktop:ml-0 max-desktop:w-full max-desktop:flex-col max-desktop:items-start">
          {options.length > 0 && (
            <>
              <DefaultDispatchPicker
                options={options}
                activeId={owner}
                disabled={!integration.id || !channel}
                onPick={(id) => setChannelAgent(integration.id!, channel!.channelId, id)}
              />
              <span className="hidden h-[18px] w-px flex-none bg-(--border-subtle) desktop:block" />
            </>
          )}
          <button
            type="button"
            disabled={reconnecting || !botId}
            title={reconnecting ? 'Waiting for Linear…' : 'Reconnect this workspace'}
            aria-label="Reconnect this workspace"
            onClick={flow.start}
            className={`iconbtn h-7 w-7 flex-none ${dead ? 'border-(--status-error) text-(--status-error)' : ''} ${
              reconnecting ? 'cursor-default opacity-55' : 'cursor-pointer'
            }`}
          >
            <Icon
              name={reconnecting ? 'loader' : 'refresh-cw'}
              size={13}
              className={reconnecting ? 'animate-spin' : ''}
            />
          </button>
          <button
            type="button"
            disabled={leaving || !integration.id}
            title="Remove this workspace from this agent"
            aria-label={`Remove ${name} from this agent`}
            onClick={unlink}
            className={`iconbtn h-7 w-7 flex-none ${leaving ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
          >
            <Icon name="x" size={14} color="var(--text-tertiary)" />
          </button>
        </div>
      </div>
      <div
        className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-app) font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)"
        style={{ padding: `10px ${padX}px` }}
      >
        <Icon name="info" size={14} className="mt-[3px] flex-none" />
        <span>
          Sessions start when someone delegates or mentions the app on an issue in this workspace.
          {reconnecting && ' Approve the workspace in the Linear tab — this card updates once it lands.'}
        </span>
      </div>
    </>
  )
}
