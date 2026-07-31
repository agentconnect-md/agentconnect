'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentLabel, isDirectConversation, type IntegrationChannelRow, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import type { AgentIcon } from '@/lib/agent-icon'

/** The per-conversation trigger toggle: a ⚡ marker followed by the segmented
 *  bar. Channels: "off" / "any message" / "@-mention" (the default, so it sits
 *  last). DM rows are binary off/on, and only a gated (restricted-agent)
 *  integration has any — resource-visibility.md §14. Every segment carries
 *  hover copy. */
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
  // channel takes the full three-way choice for EVERY agent, gated or not: an operator
  // who wants the bot silent here but still in the channel on the platform has nowhere
  // else to say so. A GROUP DM takes the channel's choice, not the DM's: several people
  // share it, so "every message" must stay opt-in.
  const here = channel.kind === 'mpim' ? 'this group DM' : 'this channel'
  const segs: [IntegrationChannelRow['trigger'], string, string][] =
    channel.kind === 'im'
      ? [
          ['off', 'off', "The agent doesn't respond in this conversation."],
          ['any', 'on', 'The agent responds to messages in this conversation.']
        ]
      : [
          ['off', 'off', `The agent doesn't respond in ${here}, even when @-mentioned.`],
          ['any', 'any message', `The agent responds to every message in ${here}.`],
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

/** One band of the channel list: the rows of a single Discord server, with the header
 *  to print above them (absent ⇒ no header, the flat lead group). */
export interface SpaceGroup {
  key: string
  label?: string
  rows: IntegrationChannelRow[]
}

/** How a band's header will actually READ once the CSS uppercases it — the form two
 *  labels must differ in to be distinguishable on screen. "acme" and "Acme" collide. */
const asDisplayed = (label: string) => label.toLocaleUpperCase().replace(/\s+/g, ' ').trim()

/**
 * Shortest tails of `ids` that are unique among them — the suffix that tells two
 * same-named bands apart. Grows from 4 characters until no two ids share a tail (a fixed
 * width is not collision-free: Discord snowflakes of one shard share their low bits),
 * and falls back to the whole id when even that is exhausted.
 */
function spaceDiscriminators(ids: string[]): Map<string, string> {
  const longest = Math.max(0, ...ids.map((id) => id.length))
  for (let width = 4; width <= longest; width++) {
    const tails = ids.map((id) => id.slice(-width))
    if (new Set(tails).size === ids.length) return new Map(ids.map((id, i) => [id, tails[i]!]))
  }
  return new Map(ids.map((id) => [id, id]))
}

/**
 * Bucket channel rows by the space (Discord server) they sit in.
 *
 * A Discord bot is usually in several servers, each with its own "#general", so the
 * channel name alone doesn't say which row an operator is configuring — the rows are
 * banded under their server, alphabetically.
 *
 * Grouping keys on the server ID, never the label: Discord permits two distinct servers
 * to carry the same name, and banding those together would merge exactly the rows this
 * is here to separate. When two bands would READ alike — compared as the header renders
 * them, uppercased, so "acme" and "Acme" count as a clash — both are suffixed with a
 * tail of their id, widened until the tails themselves differ. A server whose name
 * hasn't resolved yet still gets its own band, headed by that id tail alone.
 *
 * Platforms with one implicit container per bot (Slack, Telegram, Feishu) report no
 * space at all and stay one flat, unheaded list, which leads.
 *
 * Exported for its unit test.
 */
export function groupBySpace(rows: IntegrationChannelRow[]): SpaceGroup[] {
  const spaces = new Map<string, { label?: string; rows: IntegrationChannelRow[] }>()
  for (const c of rows) {
    const key = c.spaceId ?? ''
    const group = spaces.get(key)
    if (group) {
      group.rows.push(c)
      group.label ??= c.space
    } else spaces.set(key, { ...(c.space ? { label: c.space } : {}), rows: [c] })
  }
  const keyed = [...spaces.entries()].filter(([key]) => key)
  const discriminator = spaceDiscriminators(keyed.map(([key]) => key))
  // An unnamed server is headed by its discriminator alone — it is still a distinct
  // server, and leaving it unheaded would silently pool it with the flat group. Those
  // synthesized headers join the collision count too: a server could be NAMED "server
  // 2222", and only a real label can take a suffix to break such a tie.
  const proposed = (key: string, label?: string) => label ?? `server ${discriminator.get(key) ?? key}`
  const seen = new Map<string, number>()
  for (const [key, { label }] of keyed) {
    const as = asDisplayed(proposed(key, label))
    seen.set(as, (seen.get(as) ?? 0) + 1)
  }
  return [...spaces.entries()]
    .map(([key, { label, rows }]) => {
      if (!key) return { key, rows }
      const clash = (seen.get(asDisplayed(proposed(key, label))) ?? 0) > 1
      const suffix = discriminator.get(key) ?? key
      return { key, label: clash && label !== undefined ? `${label} · ${suffix}` : proposed(key, label), rows }
    })
    .sort((a, b) => (!a.key ? -1 : !b.key ? 1 : (a.label ?? '').localeCompare(b.label ?? '')))
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
 * `httpBot.updateChannel`), so this is the client-side safety net for a row
 * whose owner the CP couldn't resolve — never the only thing keeping the two
 * pages agreeing. Mirrors `botChannels` in SettingsView.
 */
export function channelOwners(botId: string, integrations: IntegrationRow[]): Map<string, string> {
  const owners = new Map<string, string>()
  for (const i of integrations) {
    if (i.botId !== botId) continue
    for (const c of i.channels) {
      if (isDirectConversation(c.kind) || !c.agentId || owners.has(c.channelId)) continue
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
  // httpBot.ts's compiler uses for a channel nobody has ever claimed.
  const members = memberIds.map(member)
  const owners = shareable && botId ? channelOwners(botId, integrations) : undefined
  const viewer = agentId && memberIds.includes(agentId) ? member(agentId) : undefined
  const defaultAgent = (c: IntegrationChannelRow) => {
    const explicit = c.agentId ?? owners?.get(c.channelId)
    return (explicit ? members.find((m) => m.id === explicit) : undefined) ?? members[0]
  }
  const channelRows = channels.filter((c) => !isDirectConversation(c.kind))
  // A direct conversation is not a place the bot can be invited to and has no
  // per-conversation choice to make unless the agent is gated (resource-visibility.md
  // §14.3) — a non-gated bot always answers its DMs, and answers a group DM whenever
  // it is @-mentioned. The daemon still REPORTS them (that is how a conversation
  // previously mistaken for a channel converts), so hide them here, not at the source.
  const dmRows = gated ? channels.filter((c) => isDirectConversation(c.kind)) : []
  const grouped = groupBySpace(channelRows)
  const row = (c: IntegrationChannelRow) => {
    const def = !isDirectConversation(c.kind) && shareable ? defaultAgent(c) : undefined
    return (
      <div
        key={c.channelId}
        className="flex flex-wrap items-center gap-x-[10px] gap-y-2 border-t border-(--border-subtle) bg-(--surface-app)"
        style={{ padding: `10px ${padX}px` }}
      >
        <span className="font-mono text-[14px] font-medium leading-normal text-(--text-tertiary)">
          {c.kind === 'im' ? '@' : c.kind === 'mpim' ? '@@' : '#'}
        </span>
        {/* DM labels are stored as "@Alice" (name resolvers); the glyph column already
            renders the marker, so strip a leading @ to avoid "@@Alice". */}
        <span className="mono min-w-0 flex-1 truncate text-[13px] text-(--text-primary)">
          {isDirectConversation(c.kind) ? c.name.replace(/^@+/, '') : c.name}
        </span>
        <div className="ml-auto flex items-center gap-[10px] max-desktop:ml-0 max-desktop:w-full max-desktop:flex-col max-desktop:items-start">
          {def && (
            <>
              {/* The PATCH goes through THIS agent's integration on purpose:
                  ownership of a shared (http) channel is bot-scoped server-side —
                  the route resolves the effective owner across every install,
                  fences on it (`expectedOwnerAgentId`) and hands the write to
                  `httpBot.updateChannel`, so exactly one row stays canonical no
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
      {grouped.map((g) => (
        <Fragment key={g.key || '(unscoped)'}>
          {g.label && groupHeader(g.label, padX)}
          {g.rows.map(row)}
        </Fragment>
      ))}
      {dmRows.length > 0 && groupHeader('Direct messages', padX)}
      {dmRows.map(row)}
      <div
        className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-app) font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)"
        style={{ padding: `10px ${padX}px` }}
      >
        <Icon name="info" size={14} className="mt-[3px] flex-none" />
        <span>
          {shareable
            ? 'Channels appear here when the bot is invited to them. Trigger is set per channel; default dispatch is the agent who handles unmatched messages.'
            : gated
              ? 'Channels appear here when the bot is invited; direct messages appear when someone writes to the bot.'
              : 'Channels appear here when the bot is invited to them. Trigger is set per channel.'}{' '}
          {/* Answers the question the list otherwise raises — there is no "leave" here,
              because leaving is a platform action. Off is the console's equivalent. */}
          Set a channel to off to silence the agent there; removing the bot from the channel itself is done on the
          platform.
        </span>
      </div>
    </>
  )
}
