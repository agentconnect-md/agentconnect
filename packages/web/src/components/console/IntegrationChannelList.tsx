'use client'

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { agentLabel, isDirectConversation, type IntegrationChannelRow, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import { channelListSemantics } from '@/components/console/platforms/registry'
import {
  ChannelSettingsPopover,
  type ChannelSettingsGroup,
  type ChannelSettingsOption
} from '@/components/console/ChannelSettingsPopover'
import { useOwnerChangeGuard } from '@/components/console/OwnerChangeGuard'
import { useChannelGates } from '@/components/console/decisions/channel-gates'
import { managedByRouting } from '@/lib/decisions/binding'
import {
  DecisionRoutingModal,
  clearRoutingResume,
  readRoutingResume,
  stopRouting
} from '@/components/console/decisions/routing/DecisionRoutingModal'
import { RoutingEntry, type DispatchRouting } from '@/components/console/DefaultDispatchPicker'
import type { AgentIcon } from '@/lib/agent-icon'
import { chatPlatformName } from '@/lib/platform-labels'
import type { WebChannelListMessage } from '@/components/console/platforms/contract'

type ChannelListTranslator = (key: string, values?: Record<string, string | number>) => string

type NounKey = 'channel' | 'conversation' | 'group' | 'groupChat' | 'team'

function nounKey(noun: string): NounKey {
  if (noun === 'conversation') return 'conversation'
  if (noun === 'group chat') return 'groupChat'
  if (noun === 'group') return 'group'
  if (noun === 'team') return 'team'
  return 'channel'
}

function localNoun(t: ChannelListTranslator, noun: string, plural = false): string {
  return t(`nouns.${nounKey(noun)}${plural ? 'Plural' : ''}`)
}

function resolveMessage(
  t: ChannelListTranslator,
  message: WebChannelListMessage,
  values?: Record<string, string | number>
): string {
  return t(message.key, { ...message.values, ...values })
}

/** The row's trigger choice; `decision` saves only with its gate, through the binding strip. */
type RowTrigger = IntegrationChannelRow['trigger'] | 'decision'

type SessionMode = NonNullable<IntegrationChannelRow['sessionMode']>

/** A row's two per-conversation choices behind one button: whether the agent responds here, and which session a message joins. */
function RowSettings({
  channel,
  platform,
  disabled,
  trigger,
  allowDecision,
  gateOwnsTrigger = false,
  onTrigger,
  onSessionMode
}: {
  /** The row's By decision pill owns the trigger (its × leaves it), so only the session mode stays here. */
  gateOwnsTrigger?: boolean
  channel: IntegrationChannelRow
  /** Names the room the way its platform does — one noun per card. */
  platform?: string
  /** Demo rows (no live integration id) render the control inert. */
  disabled: boolean
  /** The row's effective choice, which is the memory trigger unless a gate overrides it. */
  trigger: RowTrigger
  /** Whether `by decision` is offered here at all — the flag and a non-shared bot; the platform may still withhold it. */
  allowDecision: boolean
  onTrigger: (trigger: RowTrigger) => void | Promise<void>
  onSessionMode: (mode: SessionMode) => Promise<void>
}) {
  const t = useTranslations('Integrations.channelList')
  const translate: ChannelListTranslator = (key, values) => t(key as never, values as never)
  const here = translate('thisRoom', { noun: localNoun(translate, rowNoun(channel.kind, platform)) })
  const semantics = channelListSemantics(platform)
  // Only a 1:1 DM is On/Off; a group DM keeps a channel's choices (several people share it), and every agent gets Off.
  const respond: ChannelSettingsOption<RowTrigger>[] =
    channel.kind === 'im'
      ? [
          { value: 'any', label: translate('trigger.on'), hint: translate('trigger.dmOnHint') },
          { value: 'off', label: translate('trigger.off'), hint: translate('trigger.dmOffHint') }
        ]
      : (
          [
            { value: 'mention', label: translate('trigger.mention'), hint: translate('trigger.mentionHint') },
            {
              value: 'any',
              label: translate('trigger.anyMessage'),
              hint: translate('trigger.anyMessageHint', { room: here })
            },
            {
              value: 'decision',
              label: translate('trigger.decision'),
              hint: translate('trigger.decisionHint', { room: here })
            },
            { value: 'off', label: translate('trigger.off'), hint: translate('trigger.offHint', { room: here }) }
          ] satisfies ChannelSettingsOption<RowTrigger>[]
        ).filter((o) =>
          // The room's vocabulary is the platform's: nothing matches "All messages" where no unaddressed traffic exists.
          o.value === 'decision'
            ? channel.trigger === 'decision' ||
              (allowDecision && (!semantics.triggers || semantics.triggers.includes('decision')))
            : !semantics.triggers || semantics.triggers.includes(o.value)
        )
  // A direct conversation is one continuous exchange already, so only a channel row chooses its session.
  const sessions = isDirectConversation(channel.kind)
    ? []
    : (
        [
          {
            value: 'createNew',
            label: translate('sessionMode.createNew'),
            hint: translate('sessionMode.createNewHint')
          },
          {
            value: 'append',
            label: translate('sessionMode.append'),
            hint: t.rich(
              'sessionMode.appendHint' as never,
              {
                room: here,
                code: (chunks: ReactNode) => <span className="mono">{chunks}</span>
              } as never
            )
          }
        ] satisfies ChannelSettingsOption<SessionMode>[]
      ).filter((o) => !semantics.sessionModes || semantics.sessionModes.includes(o.value))
  // While a decision owns the trigger, the plain choices stay listed but inert, and the footer says how to get them back.
  const groups: ChannelSettingsGroup[] = [
    {
      id: 'trigger',
      label: translate('settings.respondTo'),
      options: gateOwnsTrigger ? respond.filter((o) => o.value !== 'decision') : respond,
      value: trigger,
      onPick: (value) => onTrigger(value as RowTrigger),
      ...(gateOwnsTrigger && {
        locked: { label: translate('settings.respondLocked'), hint: translate('settings.respondLockedHint') }
      })
    }
  ]
  // One mode is no choice, so a platform that offers only one shows no group for it.
  if (sessions.length > 1) {
    groups.push({
      id: 'session',
      label: translate('settings.sessionMode'),
      options: sessions,
      value: channel.sessionMode ?? 'createNew',
      // An Off row starts no session, so the button leaves the mode unsaid.
      summarize: (chosen) => chosen.trigger !== 'off',
      onPick: (value) => onSessionMode(value as SessionMode)
    })
  }
  if (!groups.length) return null
  return (
    <span className="inline-flex items-center gap-[7px] max-desktop:w-full">
      {/* ⚡ is the console's one trigger glyph, on every platform's rows and the code-host rows alike. */}
      {!gateOwnsTrigger && (
        <span title={translate('trigger.hint')} className="flex-none leading-none">
          <Icon name="zap" size={14} color="var(--text-tertiary)" />
        </span>
      )}
      <ChannelSettingsPopover groups={groups} name={rowLabel(channel)} disabled={disabled} />
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

/** The plural of a noun a module supplies — what a column header over a list of rows reads.
 *  Today's modules all take a bare "s", so only a test keeps the sibilant arm honest. */
export const roomPlural = (noun: string): string => (/(?:s|x|z|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`)

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

/** How the row prints its NAME, where the platform gives the conversation more than a label
 *  (a Linear team's key and its page). Direct rows never take it — their label is a person — and
 *  a module that declares none leaves the host printing the name. Exported for the same host. */
export const rowName = (kind: IntegrationChannelRow['kind'], platform?: string) =>
  isDirectConversation(kind) ? undefined : channelListSemantics(platform).RowName

/** The place, named as the operator knows it. "on the platform" is our word for it,
 *  not theirs — a person deciding whether to remove a bot wants to read "in Telegram". */
const platformName = (platform?: string): string => chatPlatformName(platform, 'the chat app')

/** The row's name as displayed. DM labels are stored as "@Alice" (the name resolvers
 *  write them that way) and the glyph column already renders the marker, so a leading
 *  "@" is stripped to avoid "@@Alice". Exported alongside `roomGlyph` for the same
 *  reason: the mobile card header summarises this row directly above it. */
export const rowLabel = (row: Pick<IntegrationChannelRow, 'kind' | 'name'>): string =>
  isDirectConversation(row.kind) ? row.name.replace(/^@+/, '') : row.name

/** The row's label as two pieces — the name it leads with, and the dim tail printed after it.
 *  How a label comes apart is the platform's own (`splitRowLabel`); a module that declares none
 *  keeps the whole label as the name. Direct rows are never split: their label is a person. */
export function rowLabelParts(
  row: Pick<IntegrationChannelRow, 'kind' | 'name'>,
  platform?: string
): { name: string; hint?: string } {
  const label = rowLabel(row)
  const split = channelListSemantics(platform).splitRowLabel
  if (!split || isDirectConversation(row.kind)) return { name: label }
  const parts = split(label)
  return parts.name ? parts : { name: label }
}

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
  platform?: string,
  translate?: ChannelListTranslator
): { leave: boolean; name: string; label: string; icon: string; hint: string; confirm: string } {
  const noun = rowNoun(row.kind, platform)
  const displayNoun = translate ? localNoun(translate, noun) : noun
  const displayNounPlural = translate ? localNoun(translate, noun, true) : roomPlural(noun)
  const name = rowLabel(row)
  if (canLeaveRow(row.kind, platform)) {
    return {
      leave: true,
      name,
      label: translate ? translate('action.leaveLabel', { noun: displayNoun }) : `Leave ${noun}`,
      icon: 'log-out',
      hint: translate
        ? translate('action.leaveHint', { noun: displayNoun, platform: platformName(platform) })
        : `The bot leaves this ${noun} in ${platformName(platform)} and the row goes with it. Add it back to undo.`,
      confirm: translate
        ? translate('action.leaveConfirm', { name, noun: displayNoun, platform: platformName(platform) })
        : `Have the bot leave ${name}? It leaves the ${noun} in ${platformName(platform)} and stops receiving anything there. Add it back to undo.`
    }
  }
  const custom = channelListSemantics(platform).cannotLeaveRowHint
  const rest = translate
    ? isDirectConversation(row.kind)
      ? translate('action.directListing', { noun: displayNoun })
      : custom
        ? resolveMessage(translate, custom, { noun: displayNoun, nounPlural: displayNounPlural })
        : translate('action.genericCannotLeave', { noun: displayNoun, platform: platformName(platform) })
    : isDirectConversation(row.kind)
      ? `Nobody adds or removes a bot in a ${noun} — the row comes back on the next message.`
      : custom?.key === 'discordCannotLeaveRowHint'
        ? 'A Discord bot belongs to a server, not one channel — use Leave on the server heading above to take it out. If it is still in there, the row will come back.'
        : `The bot stays in the ${noun} — remove it in ${platformName(platform)} for that. If it is still in there, the row will come back.`
  return {
    leave: false,
    name,
    label: translate ? translate('action.removeLabel') : 'Remove from this list',
    icon: 'x',
    hint: translate ? translate('action.onlyStopsShowing', { rest }) : `Only stops showing it here. ${rest}`,
    confirm: translate ? translate('action.removeConfirm', { name, rest }) : `Remove ${name} from this list? ${rest}`
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
  const t = useTranslations('Integrations.channelList')
  const translate: ChannelListTranslator = (key, values) => t(key as never, values as never)
  const action = rowMenuAction(channel, platform, translate)
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

/** A shared bot's per-conversation dispatch (§10.1): the default agent, or the bot's By decision routing when it owns the row. */
function DispatchPicker({
  current,
  members,
  viewer,
  disabled,
  labelled,
  routing,
  onClaim
}: {
  /** The channel's effective default (the bot's earliest member when unset). */
  current: MemberAgent
  /** Every agent sharing the bot, each a pickable default. */
  members: MemberAgent[]
  /** The agent being viewed, marked in the list; absent when it doesn't share this bot. */
  viewer?: MemberAgent
  /** Demo rows (no live integration id) render the control read-only. */
  disabled: boolean
  /** Name the default beside its mark on desktop too, where the row has room for it. */
  labelled: boolean
  /** The row's By decision routing and the Decision's name when it owns the row; absent where the platform has no By decision. */
  routing?: DispatchRouting
  onClaim: (agentId: string) => void | Promise<void>
}) {
  const t = useTranslations('Integrations.channelList')
  const translate: ChannelListTranslator = (key, values) => t(key as never, values as never)
  const [box, setBox] = useState<PopoverBox | null>(null)
  const [saving, setSaving] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const open = box !== null
  const close = useCallback(() => setBox(null), [])
  // Host cards clip their rows, so the menu portals to fixed coordinates; scrolling and resizing dismiss it.
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
  const claim = (id: string) => {
    close()
    if (disabled || saving) return
    // Under routing, picking an agent leaves the decision for plain dispatch to that agent.
    if (routing?.active) return routing.onStop(id)
    if (id === current.id) return
    setSaving(true)
    Promise.resolve(onClaim(id)).finally(() => setSaving(false))
  }
  const routed = routing?.active === true
  const routingName = routing?.name ?? translate('dispatch.routingFallback')
  const heading =
    'px-[9px] pb-1 pt-[6px] font-sans text-[10px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)'
  return (
    <span className="flex-none">
      <button
        ref={btnRef}
        onClick={toggle}
        title={
          routed
            ? translate('dispatch.routedButton', { name: routingName })
            : translate('defaultDispatch.button', { agent: current.label })
        }
        aria-label={
          routed
            ? translate('dispatch.routedButton', { name: routingName })
            : translate('defaultDispatch.button', { agent: current.label })
        }
        aria-expanded={open}
        className={`flex h-7 cursor-pointer items-center gap-[6px] rounded-md border border-(--border-default) bg-(--surface-card) pl-[7px] pr-[6px] hover:border-(--border-strong) hover:bg-(--surface-hover) ${
          saving ? 'opacity-60' : ''
        }`}
      >
        {routed ? (
          <>
            <Icon name="split" size={13} className="flex-none text-(--brand)" />
            <span className="mono max-w-[180px] truncate text-[11.5px] text-(--text-primary)">{routingName}</span>
          </>
        ) : (
          <>
            <span className="av h-4 w-4 rounded-[4px]">
              <AgentIconView icon={current.icon} runtime={current.runtime} size={16} />
            </span>
            {/* The mobile row breaks the control onto its own line, so it is always named there. */}
            <span
              className={`mono max-w-[180px] truncate text-[11.5px] text-(--text-primary) ${labelled ? '' : 'desktop:hidden'}`}
            >
              {current.label}
            </span>
          </>
        )}
        <Icon name="chevron-down" size={11} color="var(--text-tertiary)" />
      </button>
      {box &&
        createPortal(
          <>
            <span className="fixed inset-0 z-[1090]" onClick={close} />
            <div
              className="fixed z-[1100] w-max min-w-[200px] max-w-[260px] rounded-lg border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg)"
              style={box.style}
            >
              <div className={heading}>
                {routing ? translate('dispatch.sendTo') : translate('defaultDispatch.label')}
              </div>
              {members.map((member) => (
                <button
                  key={member.id}
                  onClick={() => claim(member.id)}
                  disabled={disabled || saving}
                  aria-pressed={member.id === current.id && !routed}
                  className={`flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-[9px] py-[6px] text-left hover:bg-(--surface-hover) ${
                    disabled || saving ? 'cursor-default opacity-60' : 'cursor-pointer'
                  }`}
                >
                  <span className="av h-[18px] w-[18px] flex-none rounded-[5px]">
                    <AgentIconView icon={member.icon} runtime={member.runtime} size={18} />
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-(--text-primary)">
                    {member.label}
                  </span>
                  {member.id === viewer?.id && (
                    <span className="flex-none font-sans text-[10.5px] leading-normal text-(--text-tertiary)">
                      {translate('defaultDispatch.thisAgent')}
                    </span>
                  )}
                  <Icon
                    name="check"
                    size={13}
                    className={`flex-none ${member.id === current.id && !routed ? 'text-(--brand)' : 'text-transparent'}`}
                  />
                </button>
              ))}
              {routing && (
                <>
                  <div className="my-1 h-px bg-(--border-subtle)" />
                  <div className={heading}>{translate('dispatch.orDecision')}</div>
                  <div className="px-[9px] pb-[6px] pt-[2px]">
                    <RoutingEntry
                      name={routed ? routingName : null}
                      canStop={routing.canStop}
                      onOpen={() => {
                        close()
                        routing.onOpen()
                      }}
                      onStop={() => {
                        close()
                        routing.onStop()
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </span>
  )
}

/** An integration's conversation rows and their controls, for a padding-less card; demo rows (no id) are inert. */
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
  const t = useTranslations('Integrations.channelList')
  const translate: ChannelListTranslator = (key, values) => t(key as never, values as never)
  const {
    setChannelSessionMode,
    setChannelAgent,
    forgetChannel,
    leaveConversation,
    refresh,
    bots,
    agents,
    integrations
  } = useConsoleData()
  const ownerGuard = useOwnerChangeGuard()
  // The shared-bot row whose By decision rules modal is open.
  const [routingRow, setRoutingRow] = useState<{
    botId: string
    channelId: string
    name: string
    resume?: boolean
  } | null>(null)
  // An inline Create decision returns naming the row whose rules modal it left; that row's list reopens it on the kept draft.
  useEffect(() => {
    const resumed = readRoutingResume()
    if (!resumed || !shareable || resumed.botId !== botId) return
    const row = channels.find((c) => c.channelId === resumed.channelId)
    if (!row) return
    clearRoutingResume()
    setRoutingRow({ botId: resumed.botId, channelId: row.channelId, name: rowLabel(row), resume: true })
  }, [botId, shareable, channels])
  // A derived roster is the platform's own list — nothing is observed into it, and nothing is dropped from here.
  const derivedRoster = channelListSemantics(platform).roster === 'derived'
  // The agents that share this bot — the candidate per-conversation defaults.
  const memberIds = shareable && botId ? (bots.find((b) => b.id === botId)?.agentIds ?? []) : []
  // Dispatch is a decision only where there are two agents to decide between.
  const dispatchable = memberIds.length > 1
  // Why a private agent's rows start off. A platform whose gate is more than the row's own says so itself.
  const gatedMessage = channelListSemantics(platform).gatedNote
  const gatedNote = gatedMessage ? resolveMessage(translate, gatedMessage) : translate('gatedNote')
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
  // Live rows read the gate from the channel DTO; explicit mock mode keeps its local prototype gates.
  // The single-owner gate lives in one hook the org's bot roster shares, so the two rows cannot drift apart.
  const gates = useChannelGates()
  const decisions = gates.decisions
  const decisionsOffered = gates.offered
  const rowTrigger = (c: IntegrationChannelRow): RowTrigger => gates.rowTrigger(botId, c)
  const pickTrigger = (c: IntegrationChannelRow, trigger: RowTrigger) =>
    gates.pickTrigger(botId, integrationId, c, trigger)
  /**
   * Leaving, for a platform that has no per-conversation membership to leave. A
   * Discord bot is in a SERVER, so the action belongs to the band that names one —
   * putting it on a row would promise something far smaller than it does. Bands
   * without a server id (the flat lead group of every other platform) get nothing.
   */
  const spaceAction = (g: SpaceGroup): ReactNode => {
    if (!integrationId || channelListSemantics(platform).leave !== 'space' || !g.key) return undefined
    const noun = roomNoun(platform)
    const displayNoun = localNoun(translate, noun)
    const displayNounPlural = localNoun(translate, noun, true)
    const server = g.label ?? translate('space.thisServer')
    return (
      <button
        className="iconbtn h-6 w-6 flex-none"
        title={translate('space.leaveTitle', { space: server, noun: displayNounPlural })}
        aria-label={translate('space.leaveAria', { space: g.label ?? g.key })}
        onClick={() =>
          void act(async () => {
            if (
              !window.confirm(
                translate('space.leaveConfirm', {
                  space: server,
                  platform: platformName(platform),
                  noun: displayNoun,
                  nounPlural: displayNounPlural
                })
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
  const decisionTriggers = gates.decisionTriggers(platform)
  // Beneath a row: the gate's status strip and rules modal while a draft or saved gate exists.
  const decisionStrip = (c: IntegrationChannelRow): ReactNode =>
    shareable
      ? null
      : gates.strip({
          botId,
          integrationId,
          row: c,
          // The same owner the row's dispatch picker shows — for a shared bot, a sibling install's.
          agentName: (defaultAgent(c) ?? (agentId ? member(agentId) : undefined))?.label ?? '',
          padX
        })
  const row = (c: IntegrationChannelRow) => {
    // One member is no choice, so the row drops the picker unless the bot's routing owns the row.
    const def = dispatchable || (shareable && managedByRouting(c)) ? defaultAgent(c) : undefined
    const label = rowLabelParts(c, platform)
    const Name = rowName(c.kind, platform)
    const trigger = rowTrigger(c)
    return (
      <Fragment key={c.channelId}>
        <div
          className="flex flex-wrap items-center gap-x-[10px] gap-y-2 border-t border-(--border-subtle) bg-(--surface-app)"
          style={{ padding: `10px ${padX}px` }}
        >
          <span className="font-mono text-[14px] font-medium leading-normal text-(--text-tertiary)">
            {roomGlyph(c.kind, platform)}
          </span>
          <span className="mono flex min-w-0 flex-1 items-baseline gap-[6px] truncate text-[13px] text-(--text-primary)">
            {Name ? (
              <Name name={label.name} channelKey={c.key} url={c.url} />
            ) : (
              <span className="min-w-0 truncate">{label.name}</span>
            )}
            {label.hint && <span className="flex-none text-(--text-tertiary)">{label.hint}</span>}
          </span>
          <div className="ml-auto flex items-center gap-2 max-desktop:ml-0 max-desktop:w-full max-desktop:flex-col max-desktop:items-start">
            {!shareable && gates.entry({ botId, platform, integrationId, row: c })}
            {def && (
              // The PATCH goes through THIS agent's integration: shared ownership is bot-scoped and fenced server-side.
              <DispatchPicker
                current={def}
                members={members}
                viewer={viewer}
                disabled={!integrationId}
                labelled={decisionTriggers && !isDirectConversation(c.kind)}
                routing={
                  decisionsOffered && decisionTriggers && botId && !isDirectConversation(c.kind)
                    ? {
                        name: c.decision?.name ?? null,
                        active: managedByRouting(c),
                        canStop: !!integrationId,
                        onOpen: () => setRoutingRow({ botId, channelId: c.channelId, name: rowLabel(c) }),
                        onStop: (agentId?: string) =>
                          void act(async () => {
                            await stopRouting(decisions!, botId, c.channelId, agentId)
                            refresh()
                          })
                      }
                    : undefined
                }
                onClaim={(id) =>
                  ownerGuard.guard({ platform, from: def, toId: id, room: rowLabel(c) }, () =>
                    setChannelAgent(integrationId!, c.channelId, id)
                  )
                }
              />
            )}
            <RowSettings
              channel={c}
              platform={platform}
              disabled={!integrationId || gates.busy(botId, c)}
              trigger={trigger}
              // A shared bot routes by its own rules (§3.2) from the dispatch menu, so it gets no per-channel gate.
              allowDecision={decisionsOffered && !shareable}
              gateOwnsTrigger={
                trigger === 'decision' && ((!!decisions && !shareable) || (shareable && managedByRouting(c)))
              }
              onTrigger={(next) => pickTrigger(c, next)}
              onSessionMode={(mode) => setChannelSessionMode(integrationId!, c.channelId, mode)}
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
        {decisionStrip(c)}
      </Fragment>
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
          <span>{gatedNote}</span>
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
      {dmRows.length > 0 && groupHeader(translate('directMessages'), padX)}
      {dmRows.map(row)}
      {ownerGuard.dialog}
      {routingRow && decisions && (
        <DecisionRoutingModal
          botId={routingRow.botId}
          channelId={routingRow.channelId}
          channelName={routingRow.name}
          resume={routingRow.resume}
          onClose={() => setRoutingRow(null)}
        />
      )}
    </>
  )
}
