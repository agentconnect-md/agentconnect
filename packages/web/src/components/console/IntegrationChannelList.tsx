'use client'

import { useState } from 'react'
import type { IntegrationChannelRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'

/** The per-channel trigger toggle — "@-mention" (default) vs "any message". */
function TriggerToggle({
  channel,
  disabled,
  onChange
}: {
  channel: IntegrationChannelRow
  /** Demo rows (no live integration id) render the control inert. */
  disabled: boolean
  onChange: (trigger: IntegrationChannelRow['trigger']) => void
}) {
  const [saving, setSaving] = useState(false)
  const pick = (trigger: IntegrationChannelRow['trigger']) => {
    if (disabled || saving || trigger === channel.trigger) return
    setSaving(true)
    Promise.resolve(onChange(trigger)).finally(() => setSaving(false))
  }
  const seg = (trigger: IntegrationChannelRow['trigger'], label: string) => {
    const active = channel.trigger === trigger
    return (
      <button
        key={trigger}
        onClick={() => pick(trigger)}
        disabled={disabled || saving}
        className={`rounded-[7px] border-0 px-3 py-[5px] font-sans text-[12.5px] leading-normal max-desktop:w-full ${
          disabled ? 'cursor-default' : 'cursor-pointer'
        } ${
          active
            ? 'bg-(--surface-card) font-semibold text-(--text-primary) shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
            : 'bg-transparent font-normal text-(--text-tertiary)'
        } ${saving ? 'opacity-60' : ''}`}
      >
        {label}
      </button>
    )
  }
  return (
    <div className="inline-flex gap-[2px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[2px] max-desktop:grid max-desktop:w-full max-desktop:grid-cols-2">
      {seg('mention', '@-mention')}
      {seg('any', 'any message')}
    </div>
  )
}

/** Per-channel default-agent picker for a SHARED bot (§10.1): which agent this
 *  channel's traffic routes to. "No default" clears it (falls through to keyword /
 *  the bot's group default). */
function DefaultAgentSelect({
  channel,
  options,
  disabled,
  onChange
}: {
  channel: IntegrationChannelRow
  options: { id: string; label: string }[]
  disabled: boolean
  onChange: (agentId: string | null) => void
}) {
  const [saving, setSaving] = useState(false)
  return (
    <select
      value={channel.agentId ?? ''}
      disabled={disabled || saving}
      onChange={(e) => {
        setSaving(true)
        Promise.resolve(onChange(e.target.value || null)).finally(() => setSaving(false))
      }}
      className={`rounded-[7px] border border-(--border-subtle) bg-(--surface-card) px-2 py-[5px] font-sans text-[12.5px] leading-normal text-(--text-primary) max-desktop:w-full ${
        disabled ? 'cursor-default opacity-60' : 'cursor-pointer'
      } ${saving ? 'opacity-60' : ''}`}
    >
      <option value="">No default</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * The channel rows of one integration — one row per channel the bot is in, each
 * with its trigger toggle (and, for a SHARED bot, a per-channel default-agent
 * picker), closed by the "invite the bot" hint. Shared by the Integrations page and
 * the agent detail page; render inside a padding-less card whose header row sits
 * above. Demo rows (no `integrationId`) are inert.
 */
export function IntegrationChannelList({
  integrationId,
  channels,
  botId,
  shareable = false,
  padX = 18
}: {
  integrationId?: string
  channels: IntegrationChannelRow[]
  /** The backing bot id — resolves the member agents offered as per-channel defaults. */
  botId?: string
  /** When true (shared bot), show the per-channel default-agent picker. */
  shareable?: boolean
  /** Horizontal row padding, to line up with the host card (18 list / 14 detail). */
  padX?: number
}) {
  const { setChannelTrigger, setChannelAgent, bots, agents } = useConsoleData()
  // The agents that share this bot — the candidate per-channel defaults.
  const memberIds = shareable && botId ? (bots.find((b) => b.id === botId)?.agentIds ?? []) : []
  const agentOptions = memberIds.map((id) => {
    const a = agents.find((x) => x.id === id)
    return { id, label: a?.displayName || a?.name || id }
  })
  return (
    <>
      {channels.map((c) => (
        <div
          key={c.channelId}
          className="flex flex-wrap items-center gap-x-[10px] gap-y-2 border-t border-(--border-subtle) bg-(--surface-app)"
          style={{ padding: `10px ${padX}px` }}
        >
          <span className="font-mono text-[14px] font-medium leading-normal text-(--text-tertiary)">#</span>
          <span className="mono min-w-0 flex-1 truncate text-[13px] text-(--text-primary)">{c.name}</span>
          <div className="ml-auto flex items-center gap-[10px] max-desktop:ml-0 max-desktop:w-full max-desktop:flex-col max-desktop:items-stretch">
            {shareable && agentOptions.length > 0 && (
              <DefaultAgentSelect
                channel={c}
                options={agentOptions}
                disabled={!integrationId}
                onChange={(agentId) => setChannelAgent(integrationId!, c.channelId, agentId)}
              />
            )}
            <TriggerToggle
              channel={c}
              disabled={!integrationId}
              onChange={(trigger) => setChannelTrigger(integrationId!, c.channelId, trigger)}
            />
          </div>
        </div>
      ))}
      <div
        className="flex items-center gap-2 border-t border-(--border-subtle) bg-(--surface-app) font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
        style={{ padding: `10px ${padX}px` }}
      >
        <Icon name="info" size={14} className="flex-none" />
        {shareable
          ? 'Channels appear here when the bot is invited. Pick a default agent per channel; trigger is set per channel.'
          : 'Channels appear here when the bot is invited to them. Trigger is set per channel.'}
      </div>
    </>
  )
}
