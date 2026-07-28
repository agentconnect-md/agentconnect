'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentLabel, type IntegrationChannelRow, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import type { AgentIcon } from '@/lib/agent-icon'

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

/**
 * Bucket channel rows by the space (Discord server) they sit in.
 *
 * A Discord bot is usually in several servers, each with its own "#general", so the
 * channel name alone doesn't say which row an operator is configuring — the rows are
 * banded under their server, alphabetically. Platforms with one implicit container per
 * bot (Slack, Telegram, Feishu) report no space and stay one flat, unheaded list; so do
 * the Discord rows whose server name hasn't resolved yet, which lead the list rather
 * than hiding under a header that doesn't apply to them.
 *
 * Exported for its unit test.
 */
export function groupBySpace(rows: IntegrationChannelRow[]): [string, IntegrationChannelRow[]][] {
  const spaces = new Map<string, IntegrationChannelRow[]>()
  for (const c of rows) {
    const key = c.space ?? ''
    const group = spaces.get(key)
    if (group) group.push(c)
    else spaces.set(key, [c])
  }
  return [...spaces.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
}

/** The band that names a run of rows — a Discord server, or the DM section. */
function groupHeader(label: string, padX: number) {
  return (
    <div
      className="border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[11px] font-semibold leading-normal text-(--text-tertiary) uppercase"
      style={{ padding: `6px ${padX}px` }}
      title={label}
    >
      <span className="block truncate">{label}</span>
    </div>
  )
}

/** One agent that shares the bot — the shape the default-dispatch popover renders. */
type MemberAgent = { id: string; label: string; runtime: string; icon?: AgentIcon | null }

/** Fixed-position placement of the portalled popover, measured off its button. */
type PopoverBox = { style: { left?: number; right?: number; top?: number; bottom?: number } }

/** Menu width and the room one needs below the button before it flips upward —
 *  a rough height bound, so nothing has to be measured in a second pass. */
const POPOVER_W = 240
const POPOVER_H = 150

/** Anchor the popover under its button, flipping up / right-aligning when the
 *  viewport edge is too close. Exported for its unit test — the flip corners are
 *  the whole reason this isn't inline. */
export function placePopover(
  btn: { left: number; right: number; top: number; bottom: number },
  vw: number,
  vh: number
): PopoverBox {
  const style: PopoverBox['style'] = {}
  if (btn.left + POPOVER_W > vw - 8) style.right = Math.max(8, vw - btn.right)
  else style.left = btn.left
  if (btn.bottom + POPOVER_H > vh - 8 && btn.top > POPOVER_H) style.bottom = vh - btn.top + 6
  else style.top = btn.bottom + 6
  return { style }
}

/**
 * Explicit per-channel owners of one bot, merged across every install of it.
 *
 * A shared bot fans its membership snapshot out to one integration per agent,
 * while the owner is persisted on a single canonical row — so the row this
 * agent's page renders may carry no `agentId` even though a sibling install
 * names the owner. The CP already resolves this bot-wide (GET /integrations
 * stamps the effective owner onto every install, from ALL installs including
 * ones the viewer can't see, and PATCH …/channels/:id routes ownership through
 * `sharedBot.updateChannel`), so this is the client-side safety net for a row
 * whose owner the CP couldn't resolve — never the only thing keeping the two
 * pages agreeing. Mirrors `botChannels` in SettingsView.
 */
export function channelOwners(botId: string, integrations: IntegrationRow[]): Map<string, string> {
  const owners = new Map<string, string>()
  for (const i of integrations) {
    if (i.botId !== botId) continue
    for (const c of i.channels) {
      if (c.kind === 'im' || !c.agentId || owners.has(c.channelId)) continue
      owners.set(c.channelId, c.agentId)
    }
  }
  return owners
}

/** Per-channel default dispatch for a SHARED bot (§10.1). Every active shared
 *  channel has exactly one owner: the agent that answers whatever the channel's
 *  routing rules don't hand to someone else.
 *
 *  The design keeps this strictly apart from the trigger toggle ("切换 default 和
 *  trigger 是两类控制，不要混一起") — a compact avatar + chevron whose popover
 *  READS the current default and offers exactly one action, claiming the channel
 *  for the agent whose page this is. Handing a channel to some third agent stays
 *  in Settings → Bots, where the whole roster is in view. */
function DefaultAgentPicker({
  current,
  viewer,
  disabled,
  onClaim
}: {
  /** The channel's effective default (the bot's earliest member when unset). */
  current: MemberAgent
  /** The agent being viewed — the "Make … default" target; absent when it doesn't share this bot. */
  viewer?: MemberAgent
  /** Demo rows (no live integration id) render the control read-only. */
  disabled: boolean
  onClaim: (agentId: string) => void | Promise<void>
}) {
  const [box, setBox] = useState<PopoverBox | null>(null)
  const [saving, setSaving] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const open = box !== null
  const isViewer = viewer?.id === current.id
  const close = useCallback(() => setBox(null), [])
  // The host cards clip their content (rounded corners over full-bleed rows), so
  // an absolutely-positioned menu is cut off on the last row. Portal it to the
  // body at fixed coordinates measured off the button instead — which also means
  // it can't follow the page, so scrolling and resizing dismiss it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])
  const toggle = () => {
    const el = btnRef.current
    if (open || !el) return close()
    setBox(placePopover(el.getBoundingClientRect(), window.innerWidth, window.innerHeight))
  }
  const claim = () => {
    close()
    if (!viewer || disabled || saving) return
    setSaving(true)
    Promise.resolve(onClaim(viewer.id)).finally(() => setSaving(false))
  }
  return (
    <span className="flex-none">
      <button
        ref={btnRef}
        onClick={toggle}
        title={`Default dispatch — ${current.label}`}
        aria-label={`Default dispatch — ${current.label}`}
        aria-expanded={open}
        className={`flex cursor-pointer items-center gap-[3px] rounded-[7px] border-0 bg-transparent p-[3px] hover:bg-(--surface-hover) ${
          saving ? 'opacity-60' : ''
        }`}
      >
        <span className="av h-[22px] w-[22px] rounded-[6px]">
          <AgentIconView icon={current.icon} runtime={current.runtime} size={22} />
        </span>
        {/* Desktop rows read the avatar in the context of the row it sits on; the
            mobile row breaks onto its own line, where a bare mark says nothing. */}
        <span className="mono max-w-[180px] truncate text-[12px] text-(--text-tertiary) desktop:hidden">
          {current.label}
        </span>
        <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
      </button>
      {box &&
        createPortal(
          <>
            <span className="fixed inset-0 z-[1090]" onClick={close} />
            <div
              className="fixed z-[1100] min-w-[230px] rounded-[10px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
              style={box.style}
            >
              <div className="px-[9px] pb-[5px] pt-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                Default dispatch
              </div>
              <div className="flex items-center gap-[9px] px-[9px] py-[6px]">
                <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                  <AgentIconView icon={current.icon} runtime={current.runtime} size={22} />
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">
                  {current.label}
                </span>
                {isViewer && (
                  <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">this agent</span>
                )}
              </div>
              {viewer && !isViewer && (
                <>
                  <div className="my-1 h-px bg-(--border-subtle)" />
                  <button
                    onClick={claim}
                    disabled={disabled || saving}
                    className={`flex w-full items-center gap-[9px] rounded-[6px] border-0 bg-transparent px-[9px] py-[7px] text-left hover:bg-(--surface-hover) ${
                      disabled || saving ? 'cursor-default opacity-60' : 'cursor-pointer'
                    }`}
                  >
                    <Icon name="corner-down-left" size={13} color="var(--text-tertiary)" className="flex-none" />
                    <span className="min-w-0 truncate font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                      Make <span className="mono">{viewer.label}</span> default
                    </span>
                  </button>
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </span>
  )
}

/**
 * The conversation rows of one integration — one row per channel the bot is in
 * (plus, on a gated/restricted agent, one row per reported DM conversation), each
 * with its trigger toggle (and, for a SHARED bot, the per-channel default-dispatch
 * popover ahead of it), closed by the "invite the bot" hint. Render inside a
 * padding-less card whose header row sits above. Demo rows (no `integrationId`)
 * are inert.
 */
export function IntegrationChannelList({
  integrationId,
  channels,
  botId,
  agentId,
  shareable = false,
  gated = false,
  padX = 18
}: {
  integrationId?: string
  channels: IntegrationChannelRow[]
  /** The backing bot id — resolves the member agents offered as per-channel defaults. */
  botId?: string
  /** The agent whose page this is — the "Make … default" target of the default-dispatch popover. */
  agentId?: string
  /** When true (shared bot), show the per-channel default-agent picker. */
  shareable?: boolean
  /** Restricted-agent integration (resource-visibility.md §14): conversations are
   *  gated — new ones start off, DM rows appear, the banner explains the gate. */
  gated?: boolean
  /** Horizontal row padding, to line up with the host card (18 list / 14 detail). */
  padX?: number
}) {
  const { setChannelTrigger, setChannelAgent, bots, agents, integrations } = useConsoleData()
  // The agents that share this bot — the candidate per-channel defaults.
  const memberIds = shareable && botId ? (bots.find((b) => b.id === botId)?.agentIds ?? []) : []
  const member = (id: string): MemberAgent => {
    const a = agents.find((x) => x.id === id)
    return { id, label: a ? agentLabel(a) : id, runtime: a?.runtime ?? a?.model ?? '', icon: a?.icon }
  }
  // The agents that share this bot. A channel's default is its explicit owner —
  // this row's when the CP stamped it, else whichever sibling install of the bot
  // persists it — falling back to the earliest install, the same ordering
  // sharedBot.ts's compiler uses for a channel nobody has ever claimed.
  const members = memberIds.map(member)
  const owners = shareable && botId ? channelOwners(botId, integrations) : undefined
  const viewer = agentId && memberIds.includes(agentId) ? member(agentId) : undefined
  const defaultAgent = (c: IntegrationChannelRow) => {
    const explicit = c.agentId ?? owners?.get(c.channelId)
    return (explicit ? members.find((m) => m.id === explicit) : undefined) ?? members[0]
  }
  const channelRows = channels.filter((c) => c.kind !== 'im')
  const dmRows = channels.filter((c) => c.kind === 'im')
  const grouped = groupBySpace(channelRows)
  const row = (c: IntegrationChannelRow) => {
    const def = c.kind !== 'im' && shareable ? defaultAgent(c) : undefined
    return (
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
        <div className="ml-auto flex items-center gap-[10px] max-desktop:ml-0 max-desktop:w-full max-desktop:flex-col max-desktop:items-start">
          {def && (
            <>
              {/* The PATCH goes through THIS agent's integration on purpose:
                  ownership of a shared (http) channel is bot-scoped server-side —
                  the route resolves the effective owner across every install,
                  fences on it (`expectedOwnerAgentId`) and hands the write to
                  `sharedBot.updateChannel`, so exactly one row stays canonical no
                  matter which install the console patched. */}
              <DefaultAgentPicker
                current={def}
                viewer={viewer}
                disabled={!integrationId}
                onClaim={(id) => setChannelAgent(integrationId!, c.channelId, id)}
              />
              {/* The design separates the two controls with a hairline — default
                  dispatch and trigger are different decisions, not one bar. */}
              <span className="hidden h-[18px] w-px flex-none bg-(--border-subtle) desktop:block" />
            </>
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
  }
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
      {grouped.map(([space, rows]) => (
        <Fragment key={space || '(unscoped)'}>
          {space && groupHeader(space, padX)}
          {rows.map(row)}
        </Fragment>
      ))}
      {dmRows.length > 0 && groupHeader('Direct messages', padX)}
      {dmRows.map(row)}
      <div
        className="flex items-center gap-2 border-t border-(--border-subtle) bg-(--surface-app) font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
        style={{ padding: `10px ${padX}px` }}
      >
        <Icon name="info" size={14} className="flex-none" />
        {shareable
          ? 'Channels appear here when the bot is invited to them. Trigger is set per channel; default dispatch is the agent who handles unmatched messages.'
          : gated
            ? 'Channels appear here when the bot is invited; direct messages appear when someone writes to the bot.'
            : 'Channels appear here when the bot is invited to them. Trigger is set per channel.'}
      </div>
    </>
  )
}
