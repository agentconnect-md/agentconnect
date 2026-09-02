'use client'

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { agentLabel, isDirectConversation, type IntegrationChannelRow, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import { channelListSemantics } from '@/components/console/platforms/registry'
import { TriggerSelect, type TriggerOption } from '@/components/console/TriggerSelect'
import { useOwnerChangeGuard } from '@/components/console/OwnerChangeGuard'
import type { AgentIcon } from '@/lib/agent-icon'
import { chatPlatformName } from '@/lib/platform-labels'

/** The per-conversation trigger dropdown: channels take "off" / "any message" / "@-mention" (the
 *  default, so it sits last), DM rows are binary off/on, and shared bots project that state across
 *  every membership row. Every choice carries hover copy. */
function TriggerToggle({
  channel,
  platform,
  disabled,
  onChange
}: {
  channel: IntegrationChannelRow
  /** Names the room the way its platform does — one noun per card. */
  platform?: string
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
  // A DM conversation activates on any message once enabled — binary off/on. A
  // channel takes the full three-way choice for EVERY agent, gated or not: an operator
  // who wants the bot silent here but still in the channel on the platform has nowhere
  // else to say so. A GROUP DM takes the channel's choice, not the DM's: several people
  // share it, so "every message" must stay opt-in.
  const here = `this ${rowNoun(channel.kind, platform)}`
  // The room's vocabulary is the platform's: nothing matches "any message" where no unaddressed traffic exists.
  const allowed = channelListSemantics(platform).triggers
  const roomOptions: TriggerOption<IntegrationChannelRow['trigger']>[] = [
    { value: 'off', label: 'off', hint: `The agent doesn't respond in ${here}, even when @-mentioned.` },
    { value: 'any', label: 'any message', hint: `The agent responds to every message in ${here}.` },
    {
      value: 'mention',
      label: '@-mention',
      hint: "The agent responds when @-mentioned. Follow-ups in a thread it has joined don't need another mention."
    }
  ]
  const options: TriggerOption<IntegrationChannelRow['trigger']>[] =
    channel.kind === 'im'
      ? [
          { value: 'off', label: 'off', hint: "The agent doesn't respond in this conversation." },
          { value: 'any', label: 'on', hint: 'The agent responds to messages in this conversation.' }
        ]
      : roomOptions.filter((o) => !allowed || allowed.includes(o.value))
  return (
    <TriggerSelect
      options={options}
      value={channel.trigger}
      onChange={pick}
      ariaLabel={`Trigger for ${rowLabel(channel)}`}
      hint="Trigger — when the agent responds here"
      disabled={disabled}
      busy={saving}
      className="max-desktop:w-full"
    />
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

/** The band that names a run of rows — a Discord server, or the DM section. `action`
 *  is the band-level control (leaving a Discord server, which no single row can do). */
function groupHeader(label: string, padX: number, action?: ReactNode) {
  return (
    <div
      className="flex items-center gap-2 border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[11px] font-semibold leading-normal text-(--text-tertiary) uppercase"
      style={{ padding: `6px ${padX}px` }}
      title={label}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {action}
    </div>
  )
}

/** One agent that shares the bot — the shape the default-dispatch popover renders.
 *  `restricted` is what makes a default move consequential (§6.2), so it travels with it. */
type MemberAgent = { id: string; label: string; runtime: string; restricted: boolean; icon?: AgentIcon | null }

// Per-platform display semantics come from the platform modules
// ({@link WebChannelListSemantics}, §10); the ALGORITHMS below — grouping, the
// DM/group-DM nouns and glyphs, the leave call itself — stay host-generic,
// because none of them vary by platform.

/**
 * Can this platform withdraw a bot from a single conversation, here?
 *
 * Only Telegram (`leaveChat`), which needs no extra permission — the module that
 * declares `leave: 'conversation'`.
 *
 * Slack CAN do it technically, but `conversations.leave` requires `channels:manage`
 * — a scope that also grants create, archive, kick and rename, and whose addition
 * would force every installed workspace to re-authorize. That is a steep price for
 * the one platform where it buys least: Slack reports its membership
 * authoritatively, so removing the bot in Slack makes the row disappear on its own,
 * and Off already covers "stop responding here". A deployment that grants the scope
 * on its own app can still call the leave API directly.
 *
 * Discord cannot at all — a bot joins a SERVER and sees its channels through
 * permissions, so the smallest thing it can leave is the whole server
 * (`leave: 'space'`), offered per-server instead. Feishu has no bot self-leave in
 * the SDK.
 */
const canLeaveConversation = (platform?: string): boolean => channelListSemantics(platform).leave === 'conversation'

/**
 * What this platform calls the room.
 *
 * ONE noun per card. Telegram and Lark have groups; Slack and Discord have channels.
 * Mixing them — a "#" row, a "channel" footer and a "Leave group" menu item, all
 * describing the same Telegram row — makes an operator wonder whether they are three
 * different things. A direct conversation is neither, so it keeps its own word.
 */
const roomNoun = (platform?: string): string => channelListSemantics(platform).roomNoun

/** "A"/"An" for a noun a module supplies. The room noun is the platform's own word and
 *  may start with a vowel, so the article cannot be a literal. Exported for its test:
 *  today's modules all take "A", so only a test keeps the other arm honest. */
export const roomArticle = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'An' : 'A')

/** The noun for ONE row: a DM is never a channel or a group, whatever the platform. */
const rowNoun = (kind: IntegrationChannelRow['kind'], platform?: string): string =>
  kind === 'im' ? 'conversation' : kind === 'mpim' ? 'group chat' : roomNoun(platform)

/** The list marker. "#" is the channel convention Slack and Discord share; a Telegram
 *  or Lark group has no such sigil, so it gets none rather than a borrowed one.
 *  The DM markers are kind-driven and platform-free. Exported because the mobile card
 *  header summarises the same row and must not disagree with it — the two sit one
 *  above the other at ≤768px. */
export const roomGlyph = (kind: IntegrationChannelRow['kind'], platform?: string): string =>
  kind === 'im' ? '@' : kind === 'mpim' ? '@@' : channelListSemantics(platform).roomGlyph

/** The place, named as the operator knows it. "on the platform" is our word for it,
 *  not theirs — a person deciding whether to remove a bot wants to read "in Telegram". */
const platformName = (platform?: string): string => chatPlatformName(platform, 'the chat app')

/** The row's name as displayed. DM labels are stored as "@Alice" (the name resolvers
 *  write them that way) and the glyph column already renders the marker, so a leading
 *  "@" is stripped to avoid "@@Alice". Exported alongside `roomGlyph` for the same
 *  reason: the mobile card header summarises this row directly above it. */
export const rowLabel = (row: Pick<IntegrationChannelRow, 'kind' | 'name'>): string =>
  isDirectConversation(row.kind) ? row.name.replace(/^@+/, '') : row.name

/** Whether the bot can be made to leave THIS row from here — the platform must have a
 *  per-conversation leave, and the row must be somewhere membership applies at all. */
export const canLeaveRow = (kind: IntegrationChannelRow['kind'], platform?: string): boolean =>
  canLeaveConversation(platform) && !isDirectConversation(kind)

/**
 * The ONE action a row offers, fully worded. Exported and pure because the rule it encodes —
 * one action, the strongest the platform allows, and the copy carries whatever that leaves
 * undone — is the whole design and belongs in a test rather than only in a rendered button.
 *
 * Three cases hide behind "cannot leave", and they call for different sentences:
 * a Discord bot belongs to a SERVER, so the way out is the band heading above the row,
 * and naming Discord would send the operator hunting for a per-conversation control that
 * does not exist; a direct conversation is not somewhere the bot was ever ADDED, so
 * there is nothing to be shown out of and the row is only a listing; everything else
 * has a real membership the operator ends in the chat app.
 */
export function rowMenuAction(
  row: Pick<IntegrationChannelRow, 'kind' | 'name'>,
  platform?: string
): { leave: boolean; name: string; label: string; icon: string; hint: string; confirm: string } {
  const noun = rowNoun(row.kind, platform)
  const name = rowLabel(row)
  if (canLeaveRow(row.kind, platform)) {
    return {
      leave: true,
      name,
      label: `Leave ${noun}`,
      icon: 'log-out',
      hint: `The bot leaves this ${noun} in ${platformName(platform)} and the row goes with it. Add it back to undo.`,
      confirm: `Have the bot leave ${name}? It leaves the ${noun} in ${platformName(platform)} and stops receiving anything there. Add it back to undo.`
    }
  }
  const rest = isDirectConversation(row.kind)
    ? `Nobody adds or removes a bot in a ${noun} — the row comes back on the next message.`
    : (channelListSemantics(platform).cannotLeaveRowHint ??
      `The bot stays in the ${noun} — remove it in ${platformName(platform)} for that. If it is still in there, the row will come back.`)
  return {
    leave: false,
    name,
    label: 'Remove from this list',
    icon: 'x',
    hint: `Only stops showing it here. ${rest}`,
    confirm: `Remove ${name} from this list? ${rest}`
  }
}

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
 * The row's ONE way out, worded by `rowMenuAction` — a bare icon button, not a menu: a
 * single-item overflow menu is two clicks and a popover to reach one control, and the repository
 * rows next to it already spend their × directly. Where the bot can leave, leaving is the only
 * choice: it does everything the weaker one does and more, so offering both would ask the operator
 * to distinguish two outcomes that differ only in how far they reach. Where it cannot, removing the
 * row is the only choice and its copy carries the rest.
 *
 * That collapse is what makes the "already gone" case load-bearing: on a leave-capable platform a
 * stale row has no second escape hatch, so Leave must also succeed when the bot has already been
 * removed there (`isAlreadyOutOfChat`, daemon side).
 *
 * The label names the OUTCOME. Neither says "forget", the earlier wording: it describes our
 * bookkeeping, not the user's outcome, and in a product that gives agents a MEMORY it reads like
 * erasing what was said. Both confirm, since neither is undoable from here.
 */
function RowAction({
  channel,
  platform,
  onForget,
  onLeave
}: {
  channel: IntegrationChannelRow
  platform?: string
  onForget: () => Promise<void>
  onLeave: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const action = rowMenuAction(channel, platform)
  const run = () => {
    if (busy || !window.confirm(action.confirm)) return
    setBusy(true)
    void (action.leave ? onLeave() : onForget()).finally(() => setBusy(false))
  }
  return (
    // The row's controls stack on mobile, where a left-aligned lone button reads as
    // stray; pinning it to the row's end keeps it looking like the row's own control.
    <button
      onClick={run}
      disabled={busy}
      title={`${action.label} — ${action.hint}`}
      aria-label={`${action.label}: ${action.name}`}
      className={`iconbtn h-7 w-7 flex-none max-desktop:self-end ${busy ? 'opacity-60' : ''}`}
    >
      <Icon name={action.icon} size={14} color="var(--text-tertiary)" />
    </button>
  )
}

/**
 * Explicit per-conversation owners of one bot, merged across every install of it.
 *
 * A shared bot fans its membership snapshot out to one integration per agent,
 * while the owner is persisted on a single canonical row — so the row this
 * agent's page renders may carry no `agentId` even though a sibling install
 * names the owner. The CP already resolves this bot-wide (GET /integrations
 * stamps the effective owner onto every install, from ALL installs including
 * ones the viewer can't see, and PATCH …/channels/:id routes ownership through
 * `httpBot.updateConversation`), so this is the client-side safety net for a row
 * whose owner the CP couldn't resolve — never the only thing keeping the two
 * pages agreeing. Mirrors `botChannels` in SettingsView.
 */
export function conversationOwners(botId: string, integrations: IntegrationRow[]): Map<string, string> {
  const owners = new Map<string, string>()
  for (const i of integrations) {
    if (i.botId !== botId) continue
    for (const c of i.channels) {
      if (!c.agentId || owners.has(c.channelId)) continue
      owners.set(c.channelId, c.agentId)
    }
  }
  return owners
}

/** Per-conversation default dispatch for a SHARED bot (§10.1). Every active shared
 *  conversation has exactly one owner: the agent that answers whatever its
 *  routing rules don't hand to someone else.
 *
 *  The design keeps this strictly apart from the trigger toggle (the two are separate
 *  controls, never merged) — a compact avatar + chevron whose popover
 *  READS the current default and offers exactly one action, claiming the channel
 *  for the agent whose page this is. Handing a conversation to some third agent stays
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
 * (plus one row per reported direct conversation), each
 * with its trigger toggle (and, for a SHARED bot, the per-conversation default-dispatch
 * popover ahead of it), closed by the "invite the bot" hint. Render inside a
 * padding-less card whose header row sits above. Demo rows (no `integrationId`)
 * are inert.
 */
export function IntegrationChannelList({
  integrationId,
  channels,
  botId,
  agentId,
  platform,
  shareable = false,
  gated = false,
  padX = 18
}: {
  integrationId?: string
  channels: IntegrationChannelRow[]
  /** The backing bot id — resolves the member agents offered as per-conversation defaults. */
  botId?: string
  /** Which platform this integration talks to. Decides what "leave" can even mean:
   *  one conversation (Slack, Telegram), a whole server (Discord), or nothing. */
  platform?: string
  /** The agent whose page this is — the "Make … default" target of the default-dispatch popover. */
  agentId?: string
  /** When true (shared bot), show the per-conversation default-agent picker. */
  shareable?: boolean
  /** Restricted-agent integration (resource-visibility.md §14): conversations are
   *  gated — new ones start off and the banner explains the gate. */
  gated?: boolean
  /** Horizontal row padding, to line up with the host card (18 list / 14 detail). */
  padX?: number
}) {
  const { setChannelTrigger, setChannelAgent, forgetChannel, leaveConversation, bots, agents, integrations } =
    useConsoleData()
  const ownerGuard = useOwnerChangeGuard()
  // A derived roster is the platform's own list — nothing is observed into it, and nothing is dropped from here.
  const derivedRoster = channelListSemantics(platform).roster === 'derived'
  // Where rows come from, plus the platform's tail — which on a derived roster IS the arrival sentence, so it leads.
  const footerNote = channelListSemantics(platform).footerNote
  const footerSentences = [
    ...(derivedRoster
      ? footerNote
        ? [footerNote]
        : []
      : [
          `${roomArticle(roomNoun(platform))} ${roomNoun(platform)} appears here once the bot is added to it, and its trigger is set per conversation.`,
          'Direct messages appear when someone writes to the bot.'
        ]),
    ...(shareable ? ['Default dispatch is the agent who handles unmatched messages in the conversation.'] : []),
    ...(!derivedRoster && footerNote ? [footerNote] : [])
  ]
  // A platform refusal is the useful half of a failed Leave — a missing scope or a
  // last-member channel tells the operator what to do — so it is shown verbatim
  // rather than collapsed into "something went wrong".
  const [error, setError] = useState<string | null>(null)
  const act = useCallback(async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  // The agents that share this bot — the candidate per-conversation defaults.
  const memberIds = shareable && botId ? (bots.find((b) => b.id === botId)?.agentIds ?? []) : []
  const member = (id: string): MemberAgent => {
    const a = agents.find((x) => x.id === id)
    return {
      id,
      label: a ? agentLabel(a) : id,
      runtime: a?.runtime ?? a?.model ?? '',
      restricted: a?.visibility === 'restricted',
      icon: a?.icon
    }
  }
  // The agents that share this bot. A conversation's default is its explicit owner —
  // this row's when the CP stamped it, else whichever sibling install of the bot
  // persists it — falling back to the earliest install, the same ordering
  // httpBot.ts's compiler uses for a conversation nobody has ever claimed.
  const members = memberIds.map(member)
  const owners = shareable && botId ? conversationOwners(botId, integrations) : undefined
  const viewer = agentId && memberIds.includes(agentId) ? member(agentId) : undefined
  const defaultAgent = (c: IntegrationChannelRow) => {
    const explicit = c.agentId ?? owners?.get(c.channelId)
    return (explicit ? members.find((m) => m.id === explicit) : undefined) ?? members[0]
  }
  const channelRows = channels.filter((c) => !isDirectConversation(c.kind))
  // Direct rows keep their compact On/Off trigger control; shared bots project it
  // bot-wide just like channels.
  const dmRows = channels.filter((c) => isDirectConversation(c.kind))
  const grouped = groupBySpace(channelRows)
  /**
   * Leaving, for a platform that has no per-conversation membership to leave. A
   * Discord bot is in a SERVER, so the action belongs to the band that names one —
   * putting it on a row would promise something far smaller than it does. Bands
   * without a server id (the flat lead group of every other platform) get nothing.
   */
  const spaceAction = (g: SpaceGroup): ReactNode => {
    if (!integrationId || channelListSemantics(platform).leave !== 'space' || !g.key) return undefined
    const noun = roomNoun(platform)
    return (
      <button
        className="iconbtn h-6 w-6 flex-none"
        title={`Leave ${g.label ?? 'this server'} — the bot leaves the whole server, with every ${noun} in it`}
        aria-label={`Leave the server ${g.label ?? g.key}`}
        onClick={() =>
          void act(async () => {
            if (
              !window.confirm(
                `Leave ${g.label ?? 'this server'}? A ${platformName(platform)} bot cannot leave one ${noun} — it leaves the whole server, and every ${noun} of it disappears from this list. Re-invite it to undo.`
              )
            ) {
              return
            }
            await leaveConversation(integrationId, { kind: 'space', spaceId: g.key })
          })
        }
      >
        <Icon name="log-out" size={13} color="var(--text-tertiary)" />
      </button>
    )
  }
  const row = (c: IntegrationChannelRow) => {
    const def = shareable ? defaultAgent(c) : undefined
    return (
      <div
        key={c.channelId}
        className="flex flex-wrap items-center gap-x-[10px] gap-y-2 border-t border-(--border-subtle) bg-(--surface-app)"
        style={{ padding: `10px ${padX}px` }}
      >
        <span className="font-mono text-[14px] font-medium leading-normal text-(--text-tertiary)">
          {roomGlyph(c.kind, platform)}
        </span>
        <span className="mono min-w-0 flex-1 truncate text-[13px] text-(--text-primary)">{rowLabel(c)}</span>
        <div className="ml-auto flex items-center gap-[10px] max-desktop:ml-0 max-desktop:w-full max-desktop:flex-col max-desktop:items-start">
          {def && (
            <>
              {/* The PATCH goes through THIS agent's integration on purpose:
                  ownership of a shared (http) conversation is bot-scoped server-side —
                  the route resolves the effective owner across every install,
                  fences on it (`expectedOwnerAgentId`) and hands the write to
                  `httpBot.updateConversation`, so exactly one row stays canonical no
                  matter which install the console patched. */}
              <DefaultAgentPicker
                current={def}
                viewer={viewer}
                disabled={!integrationId}
                onClaim={(id) =>
                  ownerGuard.guard({ platform, from: def, toId: id, room: rowLabel(c) }, () =>
                    setChannelAgent(integrationId!, c.channelId, id)
                  )
                }
              />
              {/* The design separates the two controls with a hairline — default
                  dispatch and trigger are different decisions, not one bar. */}
              <span className="hidden h-[18px] w-px flex-none bg-(--border-subtle) desktop:block" />
            </>
          )}
          <TriggerToggle
            channel={c}
            platform={platform}
            disabled={!integrationId}
            onChange={(trigger) => setChannelTrigger(integrationId!, c.channelId, trigger)}
          />
          {/* Demo rows carry no button rather than an inert one, and a derived roster none at all — the
              platform owns the list. Which of the two callbacks a row spends is `rowMenuAction`'s call. */}
          {integrationId && !derivedRoster && (
            <RowAction
              channel={c}
              platform={platform}
              onForget={() => act(() => forgetChannel(integrationId, c.channelId))}
              onLeave={() =>
                act(() => leaveConversation(integrationId, { kind: 'conversation', channel: c.channelId }))
              }
            />
          )}
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
            {`This agent is private: conversations start off. Enable each ${roomNoun(platform)}${derivedRoster ? '' : ' or direct message'} below before the agent responds there.`}
          </span>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
          style={{ padding: `9px ${padX}px` }}
        >
          <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
          <span>{error}</span>
        </div>
      )}
      {grouped.map((g) => (
        <Fragment key={g.key || '(unscoped)'}>
          {g.label && groupHeader(g.label, padX, spaceAction(g))}
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
        <span>{footerSentences.join(' ')}</span>
      </div>
      {ownerGuard.dialog}
    </>
  )
}
