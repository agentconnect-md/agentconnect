'use client'

import { useState } from 'react'
import type { IntegrationChannelRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'

/** The per-conversation trigger toggle: a ⚡ marker followed by the segmented
 *  bar. Channels: "any message" vs "@-mention" (default; mention sits last),
 *  plus an "off" segment on a gated (restricted-agent) integration —
 *  resource-visibility.md §14. DM rows are binary off/on. Every segment
 *  carries hover copy. */
function TriggerToggle({
  channel,
  disabled,
  gated,
  onChange
}: {
  channel: IntegrationChannelRow
  /** Demo rows (no live integration id) render the control inert. */
  disabled: boolean
  /** Restricted-agent integration: conversations are gated, "off" is offered. */
  gated: boolean
  onChange: (trigger: IntegrationChannelRow['trigger']) => void
}) {
  const [saving, setSaving] = useState(false)
  const pick = (trigger: IntegrationChannelRow['trigger']) => {
    if (disabled || saving || trigger === channel.trigger) return
    setSaving(true)
    Promise.resolve(onChange(trigger)).finally(() => setSaving(false))
  }
  const seg = (trigger: IntegrationChannelRow['trigger'], label: string, hint: string) => {
    const active = channel.trigger === trigger
    return (
      <button
        key={trigger}
        onClick={() => pick(trigger)}
        disabled={disabled || saving}
        title={hint}
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
  // A DM conversation activates on any message once enabled — binary off/on. A
  // channel keeps the any/mention choice (mention last); "off" appears when
  // gated (and, so the state stays visible, on an inert off row of a
  // no-longer-gated integration).
  const segs: [IntegrationChannelRow['trigger'], string, string][] =
    channel.kind === 'im'
      ? [
          ['off', 'off', "The agent doesn't respond in this conversation."],
          ['any', 'on', 'The agent responds to messages in this conversation.']
        ]
      : gated || channel.trigger === 'off'
        ? [
            ['off', 'off', "The agent doesn't respond in this channel."],
            ['any', 'any message', 'The agent responds to every message in this channel.'],
            [
              'mention',
              '@-mention',
              "The agent responds when @-mentioned. Follow-ups in a thread it has joined don't need another mention."
            ]
          ]
        : [
            ['any', 'any message', 'The agent responds to every message in this channel.'],
            [
              'mention',
              '@-mention',
              "The agent responds when @-mentioned. Follow-ups in a thread it has joined don't need another mention."
            ]
          ]
  return (
    <span className="inline-flex items-center gap-[7px] max-desktop:w-full">
      <span title="Trigger — when the agent responds here" className="flex-none leading-none">
        <Icon name="zap" size={14} color="var(--text-tertiary)" />
      </span>
      <div
        className={
          segs.length === 3
            ? 'inline-flex flex-1 gap-[2px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[2px] max-desktop:grid max-desktop:grid-cols-3'
            : 'inline-flex flex-1 gap-[2px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[2px] max-desktop:grid max-desktop:grid-cols-2'
        }
      >
        {segs.map(([trigger, label, hint]) => seg(trigger, label, hint))}
      </div>
    </span>
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
 * The conversation rows of one integration — one row per channel the bot is in
 * (plus, on a gated/restricted agent, one row per reported DM conversation), each
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
  gated = false,
  padX = 18
}: {
  integrationId?: string
  channels: IntegrationChannelRow[]
  /** The backing bot id — resolves the member agents offered as per-channel defaults. */
  botId?: string
  /** When true (shared bot), show the per-channel default-agent picker. */
  shareable?: boolean
  /** Restricted-agent integration (resource-visibility.md §14): conversations are
   *  gated — new ones start off, DM rows appear, the banner explains the gate. */
  gated?: boolean
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
  const channelRows = channels.filter((c) => c.kind !== 'im')
  const dmRows = channels.filter((c) => c.kind === 'im')
  const row = (c: IntegrationChannelRow) => (
    <div
      key={c.channelId}
      className="flex flex-wrap items-center gap-x-[10px] gap-y-2 border-t border-(--border-subtle) bg-(--surface-app)"
      style={{ padding: `10px ${padX}px` }}
    >
      <span className="font-mono text-[14px] font-medium leading-normal text-(--text-tertiary)">
        {c.kind === 'im' ? '@' : '#'}
      </span>
      {/* DM labels are stored as "@Alice" (name resolvers); the glyph column already
          renders the marker, so strip a leading @ to avoid "@@Alice". */}
      <span className="mono min-w-0 flex-1 truncate text-[13px] text-(--text-primary)">
        {c.kind === 'im' ? c.name.replace(/^@+/, '') : c.name}
      </span>
      <div className="ml-auto flex items-center gap-[10px] max-desktop:ml-0 max-desktop:w-full max-desktop:flex-col max-desktop:items-stretch">
        {c.kind !== 'im' && shareable && agentOptions.length > 0 && (
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
          gated={gated}
          onChange={(trigger) => setChannelTrigger(integrationId!, c.channelId, trigger)}
        />
      </div>
    </div>
  )
  return (
    <>
      {gated && (
        <div
          role="note"
          className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)"
          style={{ padding: `9px ${padX}px` }}
        >
          <Icon name="lock" size={13} className="mt-[2px] flex-none" />
          <span>
            This agent is private: conversations start off. Enable each channel or direct message below before the agent
            responds there.
          </span>
        </div>
      )}
      {channelRows.map(row)}
      {dmRows.length > 0 && (
        <div
          className="border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[11px] font-semibold leading-normal text-(--text-tertiary) uppercase"
          style={{ padding: `6px ${padX}px` }}
        >
          Direct messages
        </div>
      )}
      {dmRows.map(row)}
      <div
        className="flex items-center gap-2 border-t border-(--border-subtle) bg-(--surface-app) font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
        style={{ padding: `10px ${padX}px` }}
      >
        <Icon name="info" size={14} className="flex-none" />
        {shareable
          ? 'Channels appear here when the bot is invited. Pick a default agent per channel; trigger is set per channel.'
          : gated
            ? 'Channels appear here when the bot is invited; direct messages appear when someone writes to the bot.'
            : 'Channels appear here when the bot is invited to them. Trigger is set per channel.'}
      </div>
    </>
  )
}
