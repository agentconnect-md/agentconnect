'use client'

// Integrations page: the org's installed messaging bots and code hosts, and the
// agents bound to them. Both halves are org-level infrastructure — every member
// can see them, writes are gated on the role (viewers get no controls, and
// uninstalling the GitHub App from an account is owner-only).
//
// The Add-integration dialog is the SAME one the agent page opens; reached from
// here it carries no agent, so the modal grows an Agent field (ModalProvider's
// `integration` kind with no target).

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Icon, Toggle } from '@/components/ui'
import { AgentIconView, LoadingState, PlatformMark } from '@/components/marks'
import { useModal } from '@/components/console/ModalProvider'
import { DefaultDispatchPicker } from '@/components/console/DefaultDispatchPicker'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { useOrgs } from '@/lib/org-context'
import { creatorLabel, type BotDto, type MeDto } from '@/lib/api'
import { agentLabel, isDirectConversation, type IntegrationRow } from '@/lib/data'
import { roomGlyph, roomPlural, rowLabelParts, rowName } from '@/components/console/IntegrationChannelList'
import {
  botCardCopy,
  botSharingEditable,
  channelListSemantics,
  platformRegistry,
  platformSharingFixed
} from '@/components/console/platforms/registry'
import {
  BOT_PLATFORM_TABS,
  botMatchesPlatformTab,
  visibleBotPlatformTabs
} from '@/components/console/platforms/host-projections'
import { useOwnerChangeGuard } from '@/components/console/OwnerChangeGuard'
import DeleteBotModal from '@/components/console/modals/DeleteBotModal'
import GithubCard from '@/components/console/GithubCard'
import GiteaCard from '@/components/console/GiteaCard'
import GitlabCard from '@/components/console/GitlabCard'

// The free-bot sub-line shows where the bot came from without repeating
// historical usage metadata in the list row.
function botSubline(b: BotDto, labels: { freedFrom: string; builtin: string }): string {
  return b.freedFromAgent ? `${labels.freedFrom} ${b.freedFromAgent}` : b.prebuilt ? labels.builtin : ''
}

/** The Bots card's fallback `CardProvider`: a platform with no lifecycle
 *  machinery still needs SOMETHING to key by platform id around the row list. */
function PassThrough({ children }: { children: ReactNode }) {
  return <>{children}</>
}

// Design grid (`isSettings` Bots card): Bot | Sharable | Agents | Created by |
// actions. The 100px action track fits refresh + platform link + delete and stays
// identical across rows; below 480px "Created by" is dropped to preserve space.
const BOT_GRID = 'grid-cols-[3fr_1.1fr_1fr_100px] min-[480px]:grid-cols-[2fr_0.9fr_1.5fr_1fr_100px]'
type BotRosterRow = { kind: 'workspace'; key: string; label: string } | { kind: 'bot'; key: string; bot: BotDto }

// Preserve the server's bot order within each workspace. The heading is rendered
// only when this produces several groups, so single-workspace organizations keep
// the compact flat list.
function botRosterRows(bots: BotDto[], unavailableLabel: string): BotRosterRow[] {
  const groups = new Map<string, { label: string; bots: BotDto[] }>()
  for (const bot of bots) {
    const workspaceId = bot.workspaceId?.trim() || null
    const workspaceName = bot.workspaceName?.trim() || null
    const key = workspaceId ? `id:${workspaceId}` : workspaceName ? `name:${workspaceName.toLowerCase()}` : 'unknown'
    const current = groups.get(key)
    if (current) {
      if (workspaceName && current.label === workspaceId) current.label = workspaceName
      current.bots.push(bot)
      continue
    }
    groups.set(key, {
      label: workspaceName ?? workspaceId ?? unavailableLabel,
      bots: [bot]
    })
  }
  if (groups.size <= 1) return bots.map((bot) => ({ kind: 'bot', key: bot.id, bot }))
  return [...groups].flatMap(([workspaceKey, group]) => [
    { kind: 'workspace', key: `workspace:${workspaceKey}`, label: group.label },
    ...group.bots.map((bot) => ({ kind: 'bot' as const, key: bot.id, bot }))
  ])
}

// One merged conversation row for a bot's expandable roster.
interface BotChannelView {
  channelId: string
  name: string
  kind: 'channel' | 'im' | 'mpim'
  /** The conversation's own glyph and tint, where the platform gives it one (a Linear team). */
  icon?: string
  color?: string
  /** Its handle and the page it opens on the platform, where it has them (a Linear team). */
  key?: string
  url?: string
  /** Effective per-conversation owner; null only before legacy state converges. */
  agentId: string | null
  /** Any integration whose snapshot row backs this channel; ownership PATCHes
   *  are bot-scoped. */
  integrationId: string | null
}

// The bot's conversation roster, merged across its installs (a shared bot fans out to
// one integration per agent, each reporting its own membership snapshot).
function botChannels(bot: BotDto, integrations: IntegrationRow[]): BotChannelView[] {
  const merged = new Map<string, BotChannelView>()
  for (const i of integrations) {
    if (i.botId !== bot.id) continue
    for (const c of i.channels) {
      const explicit = c.agentId ?? null
      const prev = merged.get(c.channelId)
      if (!prev) {
        merged.set(c.channelId, {
          channelId: c.channelId,
          name: c.name,
          kind: c.kind ?? 'channel',
          ...(c.icon ? { icon: c.icon } : {}),
          ...(c.color ? { color: c.color } : {}),
          ...(c.key ? { key: c.key } : {}),
          ...(c.url ? { url: c.url } : {}),
          agentId: explicit,
          integrationId: i.id ?? null
        })
      } else if (!prev.agentId && explicit) {
        prev.agentId = explicit
        prev.integrationId = i.id ?? null
      }
    }
  }
  // Channels first, then the direct conversations (DMs and group DMs) under one
  // heading — the roster's second half is "places the bot was not invited to".
  return [...merged.values()].sort((a, b) => {
    const rank = (k: BotChannelView['kind']) => (isDirectConversation(k) ? 1 : 0)
    if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind)
    return a.name.localeCompare(b.name)
  })
}

/** The page's two section headings. Cards own no top margin here — the section
 *  spacing is the wrapper's, so a heading and its card read as one block. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-[22px]">
      <div className="mb-2 font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
        {label}
      </div>
      {children}
    </section>
  )
}

export default function IntegrationsView() {
  const t = useTranslations('Integrations')
  // `?bot=<id>` opens that bot's channel roster — the agent page's bot chip and
  // the Settings-era deep links land here. `?platform=<id>` only selects the
  // tab, for senders that know which provider needs attention but not which of
  // its installs: the session-access "reauthorize your Slack app" notification
  // is deliberately one of those (see `session-access-notifications.ts`).
  const params = useSearchParams()
  const targetBotId = params.get('bot')
  const targetPlatform = params.get('platform')
  const { me } = useProfile()
  const { myRole } = useOrgs()
  const { openModal } = useModal()
  const isOwner = myRole === 'owner'
  const canWrite = myRole !== 'viewer' // the CP denies viewer writes; hide the controls too
  const [deletingBot, setDeletingBot] = useState<BotDto | null>(null)

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="psub mt-0 min-w-[240px] flex-1">{t('description')}</p>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => openModal('integration')}>
            <Icon name="plus" size={14} />
            {t('addIntegration')}
          </Button>
        )}
      </div>

      <Section label={t('messagingApps')}>
        <BotsCard
          canWrite={canWrite}
          me={me}
          targetBotId={targetBotId}
          targetPlatform={targetPlatform}
          onDelete={setDeletingBot}
        />
      </Section>

      <Section label={t('codeHosts')}>
        <GithubCard canWrite={canWrite} isOwner={isOwner} />
        {/* Cards own no margin here (see Section) — every card after the first supplies its own gap. */}
        <div className="mt-4">
          <GitlabCard canWrite={canWrite} />
        </div>
        <div className="mt-4">
          <GiteaCard canWrite={canWrite} />
        </div>
      </Section>

      {deletingBot && (
        <div className="scrim" onClick={() => setDeletingBot(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <DeleteBotModal bot={deletingBot} onClose={() => setDeletingBot(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tabbed IM bots card ───────────────────────────────────────────────────────
// The platform tabs select one complete roster at a time — in-use and free bots
// are shown together, and "Show in use" narrows to the ones an agent actually
// answers on. Each row carries the Sharable toggle (PATCH /bots/:id; the CP's
// 409 reason renders inline) + installed-agent stack and expands to the bot's
// channel roster.
function BotsCard({
  canWrite,
  me,
  targetBotId,
  targetPlatform,
  onDelete
}: {
  canWrite: boolean
  me: MeDto | null
  targetBotId: string | null
  targetPlatform: string | null
  onDelete: (b: BotDto) => void
}) {
  const t = useTranslations('Integrations')
  const { orgPath } = useOrgs()
  const { bots, integrations, getAgent, setBotShareable, setChannelAgent, loading: dataLoading } = useConsoleData()
  // On an owner-as-default platform the seat IS a private agent's grant, so moving it is confirmed first.
  const ownerGuard = useOwnerChangeGuard()
  const tabs = visibleBotPlatformTabs(bots)
  const [platformTabKey, setPlatformTabKey] = useState<string>(tabs[0]?.key ?? '')
  // Bot row expanded to its channel roster (one at a time), the bot whose
  // shareable PATCH is in flight, and the last toggle denial to surface (the CP
  // 409s with a reason: no relay connected / still shared by several agents).
  const [openBotId, setOpenBotId] = useState<string | null>(null)
  const [botBusyId, setBotBusyId] = useState<string | null>(null)
  const [botErr, setBotErr] = useState<{ id: string; msg: string } | null>(null)
  // Hides the bots no agent is installed on. Free bots are the reusable pool the
  // Add-integration picker offers, so they belong in the roster by default — this
  // is for reading the org's live surface area, not for pruning.
  const [inUseOnly, setInUseOnly] = useState(false)

  const targetBot = bots.find((bot) => bot.id === targetBotId)
  const targetBotPlatformTabKey = targetBot ? tabs.find((tab) => botMatchesPlatformTab(targetBot, tab))?.key : undefined
  // Ungated modules keep the strip non-empty, so falling back to the first tab keeps this lookup total.
  const platformTab = (tabs.find((tab) => tab.key === platformTabKey) ?? tabs[0])!
  const { label } = platformTab
  const platformBots = bots.filter((bot) => botMatchesPlatformTab(bot, platformTab))
  const shownBots = inUseOnly ? platformBots.filter((bot) => bot.agentIds.length > 0) : platformBots
  const rosterRows = botRosterRows(shownBots, t('workspaceUnavailable'))
  // Per-tab totals stay UNFILTERED: they answer "where does this org have bots",
  // which the filter must not silently rewrite while you read across the strip.
  const tabCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tab of BOT_PLATFORM_TABS)
      counts.set(tab.key, bots.filter((bot) => botMatchesPlatformTab(bot, tab)).length)
    return counts
  }, [bots])

  // Runs before the bot effect below, so `?bot=` still wins; a platform with no visible tab is ignored.
  const targetPlatformTabKey = tabs.find((tab) => tab.platform === targetPlatform)?.key
  useEffect(() => {
    if (!targetPlatformTabKey) return
    setPlatformTabKey(targetPlatformTabKey)
  }, [targetPlatformTabKey])

  useEffect(() => {
    if (!targetBotId || !targetBotPlatformTabKey) return
    setPlatformTabKey(targetBotPlatformTabKey)
    setOpenBotId(targetBotId)
  }, [targetBotId, targetBotPlatformTabKey])

  useEffect(() => {
    if (!targetBotId || openBotId !== targetBotId) return
    document.getElementById(`integration-bot-${targetBotId}`)?.scrollIntoView({ block: 'start' })
  }, [openBotId, targetBotId])

  const flipShareable = async (b: BotDto, next: boolean) => {
    if (botBusyId) return
    setBotBusyId(b.id)
    setBotErr(null)
    try {
      await setBotShareable(b.id, next)
    } catch (e) {
      setBotErr({ id: b.id, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBotBusyId(null)
    }
  }

  // The active platform's Settings fragments (§10 `settingsFragments`): row
  // badges, provider deep links, and the lifecycle machinery that owns its own
  // card-scope state. `CardProvider` is mounted below, KEYED BY PLATFORM, which
  // is what keeps a module's hooks from changing identity when the tab changes.
  const fragments = platformRegistry.get(platformTab.platform)?.settingsFragments
  const RowBadges = fragments?.botCard?.RowBadges
  const RowLinks = fragments?.botCard?.RowLinks
  const RowSettings = fragments?.botCard?.RowSettings
  const RowActions = fragments?.lifecycleActions?.RowActions
  const CardNotice = fragments?.lifecycleActions?.CardNotice
  const CardProvider = fragments?.lifecycleActions?.CardProvider ?? PassThrough
  // The words the CARD writes into its own chrome (the revoked badge, the
  // Sharable cell, and `noun` — the "app"/"bot" heading, delete tooltip and
  // empty-state sentence). All of them used to be Slack's model rendered over
  // every platform's rows; the module supplies the wording, the host still
  // decides when and which arm to show.
  const rowCopy = botCardCopy(platformTab.platform)
  const noun = rowCopy.identityNoun.toLowerCase() === 'app' ? t('appLabel') : t('botLabel')

  return (
    <div className="card">
      <div className="cardhead gap-0 py-0">
        <div
          className="flex min-w-0 flex-1 gap-0 overflow-x-auto [scrollbar-width:none] desktop:overflow-x-visible [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label={t('botPlatform')}
        >
          {tabs.map((item) => {
            const selected = item.key === platformTabKey
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`${selected ? 'tab on' : 'tab'} mr-[5px] flex items-center gap-[5px] whitespace-nowrap last:mr-0 desktop:mr-[22px] desktop:gap-[6px]`}
                onClick={() => {
                  setPlatformTabKey(item.key)
                  setOpenBotId(null)
                }}
              >
                <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
                  <PlatformMark platform={item.platform} fillPct={100} />
                </span>
                {item.label}
                <span className="font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
                  {tabCounts.get(item.key) ?? 0}
                </span>
              </button>
            )
          })}
        </div>
        {/* Pinned right of the scrolling tab strip. At 375px the full label eats a
            third of the row, so the mobile arm keeps only the words that carry it. */}
        <label className="flex flex-none cursor-pointer items-center gap-2 pl-3 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
          <span className="max-desktop:hidden">{t('showInUse')}</span>
          <span className="desktop:hidden">{t('inUse')}</span>
          <Toggle checked={inUseOnly} onChange={setInUseOnly} />
        </label>
      </div>
      {/* gap must match the data rows' or the narrow tracks drift out of line. */}
      <div className={`row h ${BOT_GRID} gap-[11px]`}>
        {/* `.row.h` uppercases, so the module's lower-case noun renders as the
            heading did when the host picked between two literals. */}
        <span>{noun}</span>
        <span>{t('sharable')}</span>
        <span>{t('agents')}</span>
        <span className="whitespace-nowrap max-[479px]:hidden">{t('createdBy')}</span>
        <span />
      </div>
      {/* Keyed by platform id: switching tabs REMOUNTS the module's card state,
          which is the only way the fragments' hooks keep a stable identity when
          the active module changes. Non-lifecycle platforms get `PassThrough`, so
          the key is inert for them. */}
      <CardProvider key={platformTab.platform}>
        {rosterRows.map((row) => {
          if (row.kind === 'workspace') {
            return (
              <div
                key={row.key}
                className="flex items-center gap-2 border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-2"
              >
                <span className="font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                  {t('workspace')}
                </span>
                <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">{row.label}</span>
              </div>
            )
          }
          const b = row.bot
          const free = b.agentIds.length === 0
          const open = openBotId === b.id
          const channels = open ? botChannels(b, integrations) : []
          // One member is no choice — the column would name that agent on every row and offer nothing.
          const showDefaultDispatch = b.shareable && channels.length > 0 && b.agentIds.length > 1
          const chanGrid = showDefaultDispatch ? 'grid-cols-[1fr_auto]' : 'grid-cols-[1fr]'
          // The picker's choices: every agent installed on the bot.
          const agentOptions = b.agentIds.map((id) => {
            const ag = getAgent(id)
            return {
              id,
              name: ag ? agentLabel(ag) : id,
              model: ag?.model || ag?.runtime || '',
              runtime: ag?.runtime || ag?.model || '',
              icon: ag?.icon
            }
          })
          const roomNoun = channelListSemantics(b.platform).roomNoun
          const roomLabel = roomNoun.charAt(0).toUpperCase() + roomNoun.slice(1)
          // The outgoing owner, as the owner-change warning reads it — private is what costs.
          const owner = (id: string | null) => {
            const ag = id ? getAgent(id) : undefined
            return ag ? { id: ag.id, label: agentLabel(ag), restricted: ag.visibility === 'restricted' } : undefined
          }
          return (
            <Fragment key={b.id}>
              <div
                id={`integration-bot-${b.id}`}
                className={`row click ${BOT_GRID} items-center gap-[11px]`}
                onClick={() => setOpenBotId(open ? null : b.id)}
              >
                <div className="flex min-w-0 items-center gap-[10px]">
                  <Icon
                    name="chevron-right"
                    size={14}
                    className={`flex-none text-(--text-tertiary) transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                    <span className="flex h-[14px] w-[14px] items-center justify-center">
                      <PlatformMark platform={b.platform} fillPct={100} />
                    </span>
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{b.name}</span>
                  {b.prebuilt && (
                    <span className="badge bg-(--surface-active) text-(--text-tertiary)">{t('builtin')}</span>
                  )}
                  {/* Workspace uninstalled the app / revoked its tokens (rc/bot-revoked):
                    the credential is dead until a re-install refreshes it. The
                    sentence is the module's (§10 `settingsFragments.copy`) — only
                    Slack can name the lifecycle event that put the bot here. */}
                  {b.revokedAt && (
                    <span className="badge bg-(--status-error-soft) text-(--status-error)" title={rowCopy.revokedHint}>
                      {t('revoked')}
                    </span>
                  )}
                  {RowBadges && <RowBadges bot={b} />}
                </div>
                {/* The host picks the arm by transport; the module owns both
                    sentences. A platform that declares none gets one sentence for
                    both arms — its transport is not why sharing is unavailable.
                    Enablement asks the same question the CP does
                    (`botSharingEditable`): transport ALONE left Feishu's HTTP bots
                    with a live toggle for a capability the server refuses. */}
                <span
                  className="flex items-center justify-self-start"
                  title={
                    (b.transport ?? 'socket') === 'socket' ? rowCopy.shareHint.unavailable : rowCopy.shareHint.available
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Structural sharing is not a control at all: the provider stamps
                      the flag, so the cell states it rather than offering a toggle
                      the CP would accept and the provider contract does not have. */}
                  {platformSharingFixed(b.platform) ? (
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {t('always')}
                    </span>
                  ) : (
                    <Toggle
                      checked={b.shareable}
                      disabled={!canWrite || botBusyId === b.id || !botSharingEditable(b)}
                      onChange={(next) => void flipShareable(b, next)}
                    />
                  )}
                </span>
                <div className="flex min-w-0 items-center">
                  {b.agentIds.length > 0 ? (
                    b.agentIds.map((id, idx) => {
                      const ag = getAgent(id)
                      return (
                        <Link
                          key={id}
                          href={orgPath(`/agents/${encodeURIComponent(id)}?tab=config`)}
                          aria-label={`Open ${ag ? agentLabel(ag) : id} configuration`}
                          title={ag ? agentLabel(ag) : id}
                          className={`av h-[22px] w-[22px] rounded-[6px] no-underline focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) ${
                            idx > 0 ? '-ml-[6px] shadow-[-1px_0_0_0_var(--surface-card)]' : ''
                          }`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <AgentIconView icon={ag?.icon} runtime={ag?.runtime || ag?.model || ''} size={22} />
                        </Link>
                      )
                    })
                  ) : (
                    <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      {botSubline(b, { freedFrom: t('bot.freedFrom'), builtin: t('bot.builtin') })}
                    </span>
                  )}
                </div>
                <span className="min-w-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) max-[479px]:hidden">
                  {b.createdBy ? creatorLabel(b.createdBy, me) : b.prebuilt ? t('agentConnect') : '—'}
                </span>
                {/* The 100px action track: the module's own controls (refresh, provider
                  deep link) first, then the host's delete. */}
                <span className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  {RowActions && <RowActions bot={b} canWrite={canWrite} />}
                  {RowLinks && <RowLinks bot={b} />}
                  {free && canWrite ? (
                    <button className="iconbtn h-7 w-7 flex-none" title={`Delete ${noun}`} onClick={() => onDelete(b)}>
                      <Icon name="trash" size={14} />
                    </button>
                  ) : !free ? (
                    <span
                      title={t('uninstallFirst')}
                      className="flex h-7 w-7 flex-none cursor-not-allowed items-center justify-center opacity-45"
                    >
                      <Icon name="trash" size={14} />
                    </span>
                  ) : (
                    <span className="h-7 w-7 flex-none" />
                  )}
                </span>
              </div>
              {botErr?.id === b.id && (
                <div className="border-b border-(--border-subtle) px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
                  {botErr.msg}
                </div>
              )}
              {CardNotice && <CardNotice bot={b} />}
              {open && (
                <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-4 pb-[14px] pl-10 pt-3">
                  {RowSettings && <RowSettings bot={b} canWrite={canWrite} />}
                  {channels.length > 0 ? (
                    <>
                      <div
                        className={`grid ${chanGrid} gap-[11px] px-3 pb-[7px] font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)`}
                      >
                        {/* The platform's own noun for the room, not "conversation": these rows
                            are a Linear workspace's teams and a Slack bot's channels. */}
                        <span>{roomPlural(roomLabel)}</span>
                        {showDefaultDispatch && <span className="justify-self-end">{t('defaultDispatch')}</span>}
                      </div>
                      <div className="overflow-visible rounded-lg border border-(--border-subtle) bg-(--surface-card)">
                        {channels.map((c, index) => {
                          const label = rowLabelParts(c, b.platform)
                          // The room marker is the platform's own glyph, not the channel convention:
                          // a Linear team and a Telegram group carry no "#", so they get no icon.
                          const glyph = roomGlyph(c.kind, b.platform)
                          const glyphIcon =
                            glyph === '@@' ? 'users' : glyph === '@' ? 'at-sign' : glyph === '#' ? 'hash' : null
                          const Name = rowName(c.kind, b.platform)
                          return (
                            <Fragment key={c.channelId}>
                              {isDirectConversation(c.kind) && !isDirectConversation(channels[index - 1]?.kind) && (
                                <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                                  {t('directMessages')}
                                </div>
                              )}
                              <div
                                className={`grid ${chanGrid} items-center gap-[11px] border-b border-(--border-subtle) px-3 py-2 last:border-b-0`}
                              >
                                <span className="mono flex min-w-0 items-center gap-[7px] text-[12px]">
                                  {glyphIcon && (
                                    <Icon
                                      name={glyphIcon}
                                      size={12}
                                      color="var(--text-tertiary)"
                                      className="flex-none"
                                    />
                                  )}
                                  {/* The room's noun is the platform's own; the two direct kinds are platform-free. */}
                                  <span className="sr-only">
                                    {c.kind === 'mpim'
                                      ? t('groupDm')
                                      : c.kind === 'im'
                                        ? t('directMessage')
                                        : roomLabel}
                                    :{' '}
                                  </span>
                                  <span className="flex min-w-0 items-baseline gap-[6px] truncate">
                                    {Name ? (
                                      <Name name={label.name} channelKey={c.key} url={c.url} />
                                    ) : (
                                      <span className="min-w-0 truncate">{label.name}</span>
                                    )}
                                    {label.hint && (
                                      <span className="flex-none text-(--text-tertiary)">{label.hint}</span>
                                    )}
                                  </span>
                                </span>
                                {showDefaultDispatch && (
                                  <DefaultDispatchPicker
                                    options={agentOptions}
                                    activeId={c.agentId ?? b.agentIds[0] ?? null}
                                    disabled={!canWrite || !c.integrationId}
                                    onPick={(agentId) =>
                                      ownerGuard.guard(
                                        {
                                          platform: b.platform,
                                          from: owner(c.agentId ?? b.agentIds[0] ?? null),
                                          toId: agentId,
                                          room: c.name
                                        },
                                        () => setChannelAgent(c.integrationId!, c.channelId, agentId)
                                      )
                                    }
                                  />
                                )}
                              </div>
                            </Fragment>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                      {t('noConversations', { room: roomNoun })}
                    </div>
                  )}
                </div>
              )}
            </Fragment>
          )
        })}
      </CardProvider>
      {shownBots.length === 0 &&
        (dataLoading ? (
          <LoadingState size={22} padding={20} />
        ) : platformBots.length > 0 ? (
          // Filtered empty — say so, or the roster reads as "this org has no
          // Slack bots" when it has several sitting free.
          <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            {t(platformBots.length === 1 ? 'empty.filteredOne' : 'empty.filteredMany', {
              platform: label,
              noun,
              count: platformBots.length
            })}
          </div>
        ) : (
          <div className="px-4 py-7 text-center">
            <div className="font-sans text-[13px] font-semibold leading-normal">{t('empty.noneTitle', { noun })}</div>
            <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('empty.noneBody', { platform: label, noun })}
            </div>
          </div>
        ))}
      {ownerGuard.dialog}
    </div>
  )
}
