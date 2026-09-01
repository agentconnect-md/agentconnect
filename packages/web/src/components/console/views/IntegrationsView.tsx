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
import { Button, Icon, Toggle } from '@/components/ui'
import { AgentIconView, GithubMark, LoadingState, PlatformMark } from '@/components/marks'
import { useModal } from '@/components/console/ModalProvider'
import { DefaultDispatchPicker } from '@/components/console/DefaultDispatchPicker'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { useOrgs } from '@/lib/org-context'
import {
  creatorLabel,
  fetchGithubInstallUrl,
  fetchGithubInstallations,
  syncGithubInstallations,
  type BotDto,
  type GithubInstallationDto,
  type MeDto
} from '@/lib/api'
import { agentLabel, isDirectConversation, type IntegrationRow } from '@/lib/data'
import {
  botCardCopy,
  botSharingEditable,
  platformRegistry,
  platformSharingFixed
} from '@/components/console/platforms/registry'
import { BOT_PLATFORM_TABS, botMatchesPlatformTab } from '@/components/console/platforms/host-projections'
import DeleteBotModal from '@/components/console/modals/DeleteBotModal'
import UninstallGithubInstallationModal from '@/components/console/modals/UninstallGithubInstallationModal'
import GitlabCard from '@/components/console/GitlabCard'

// The free-bot sub-line shows where the bot came from without repeating
// historical usage metadata in the list row.
function botSubline(b: BotDto): string {
  return b.freedFromAgent ? `freed from ${b.freedFromAgent}` : b.prebuilt ? 'builtin' : ''
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
function botRosterRows(bots: BotDto[]): BotRosterRow[] {
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
      label: workspaceName ?? workspaceId ?? 'Workspace unavailable',
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
        <p className="psub mt-0 min-w-[240px] flex-1">
          Messaging bots and code hosts installed for this organization, and the agents bound to them.
        </p>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => openModal('integration')}>
            <Icon name="plus" size={14} />
            Add integration
          </Button>
        )}
      </div>

      <Section label="Messaging apps">
        <BotsCard
          canWrite={canWrite}
          me={me}
          targetBotId={targetBotId}
          targetPlatform={targetPlatform}
          onDelete={setDeletingBot}
        />
      </Section>

      <Section label="Code hosts">
        <GithubCard canWrite={canWrite} isOwner={isOwner} />
        {/* Cards own no margin here (see Section) — the second one supplies its own gap. */}
        <div className="mt-4">
          <GitlabCard canWrite={canWrite} />
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
  const { orgPath } = useOrgs()
  const { bots, integrations, getAgent, setBotShareable, setChannelAgent, loading: dataLoading } = useConsoleData()
  const [platformTabKey, setPlatformTabKey] = useState<string>(BOT_PLATFORM_TABS[0]?.key ?? '')
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
  const targetBotPlatformTabKey = targetBot
    ? BOT_PLATFORM_TABS.find((tab) => botMatchesPlatformTab(targetBot, tab))?.key
    : undefined
  // The registry always registers modules, so the strip is never empty; falling
  // back to the first tab is what keeps this lookup total, where the hand-written
  // table simply assumed the key resolved.
  const platformTab = (BOT_PLATFORM_TABS.find((tab) => tab.key === platformTabKey) ?? BOT_PLATFORM_TABS[0])!
  const { label } = platformTab
  const platformBots = bots.filter((bot) => botMatchesPlatformTab(bot, platformTab))
  const shownBots = inUseOnly ? platformBots.filter((bot) => bot.agentIds.length > 0) : platformBots
  const rosterRows = botRosterRows(shownBots)
  // Per-tab totals stay UNFILTERED: they answer "where does this org have bots",
  // which the filter must not silently rewrite while you read across the strip.
  const tabCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tab of BOT_PLATFORM_TABS)
      counts.set(tab.key, bots.filter((bot) => botMatchesPlatformTab(bot, tab)).length)
    return counts
  }, [bots])

  // Runs before the bot effect below, so `?bot=` still wins when both are given:
  // an unknown platform is simply ignored rather than emptying the strip.
  const targetPlatformTabKey = BOT_PLATFORM_TABS.find((tab) => tab.platform === targetPlatform)?.key
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
  const RowActions = fragments?.lifecycleActions?.RowActions
  const CardNotice = fragments?.lifecycleActions?.CardNotice
  const CardProvider = fragments?.lifecycleActions?.CardProvider ?? PassThrough
  // The words the CARD writes into its own chrome (the revoked badge, the
  // Sharable cell, and `noun` — the "app"/"bot" heading, delete tooltip and
  // empty-state sentence). All of them used to be Slack's model rendered over
  // every platform's rows; the module supplies the wording, the host still
  // decides when and which arm to show.
  const rowCopy = botCardCopy(platformTab.platform)
  const noun = rowCopy.identityNoun

  return (
    <div className="card">
      <div className="cardhead gap-0 py-0">
        <div
          className="flex min-w-0 flex-1 gap-0 overflow-x-auto [scrollbar-width:none] desktop:overflow-x-visible [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Bot platform"
        >
          {BOT_PLATFORM_TABS.map((item) => {
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
          <span className="max-desktop:hidden">Show in use</span>
          <span className="desktop:hidden">In use</span>
          <Toggle checked={inUseOnly} onChange={setInUseOnly} />
        </label>
      </div>
      {/* gap must match the data rows' or the narrow tracks drift out of line. */}
      <div className={`row h ${BOT_GRID} gap-[11px]`}>
        {/* `.row.h` uppercases, so the module's lower-case noun renders as the
            heading did when the host picked between two literals. */}
        <span>{noun}</span>
        <span>Sharable</span>
        <span>Agents</span>
        <span className="whitespace-nowrap max-[479px]:hidden">Created by</span>
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
                  Workspace
                </span>
                <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">{row.label}</span>
              </div>
            )
          }
          const b = row.bot
          const free = b.agentIds.length === 0
          const open = openBotId === b.id
          const channels = open ? botChannels(b, integrations) : []
          const showDefaultDispatch = b.shareable && channels.length > 0
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
                  {b.prebuilt && <span className="badge bg-(--surface-active) text-(--text-tertiary)">builtin</span>}
                  {/* Workspace uninstalled the app / revoked its tokens (rc/bot-revoked):
                    the credential is dead until a re-install refreshes it. The
                    sentence is the module's (§10 `settingsFragments.copy`) — only
                    Slack can name the lifecycle event that put the bot here. */}
                  {b.revokedAt && (
                    <span className="badge bg-(--status-error-soft) text-(--status-error)" title={rowCopy.revokedHint}>
                      revoked
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
                      Always
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
                      {botSubline(b)}
                    </span>
                  )}
                </div>
                <span className="min-w-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) max-[479px]:hidden">
                  {b.createdBy ? creatorLabel(b.createdBy, me) : b.prebuilt ? 'AgentConnect' : '—'}
                </span>
                {/* The 100px action track: the module's own controls (refresh, provider
                  deep link) first, then the host's delete. */}
                <span className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  {RowActions && <RowActions bot={b} canWrite={canWrite} />}
                  {RowLinks && <RowLinks bot={b} />}
                  {free && canWrite ? (
                    <button className="iconbtn h-7 w-7 flex-none" title={`Delete ${noun}`} onClick={() => onDelete(b)}>
                      <Icon name="trash-2" size={14} />
                    </button>
                  ) : !free ? (
                    <span
                      title="Uninstall its integration first"
                      className="flex h-7 w-7 flex-none cursor-not-allowed items-center justify-center opacity-45"
                    >
                      <Icon name="trash-2" size={14} />
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
                  {channels.length > 0 ? (
                    <>
                      <div
                        className={`grid ${chanGrid} gap-[11px] px-3 pb-[7px] font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)`}
                      >
                        <span>Conversation</span>
                        {showDefaultDispatch && <span className="justify-self-end">Default dispatch</span>}
                      </div>
                      <div className="overflow-visible rounded-lg border border-(--border-subtle) bg-(--surface-card)">
                        {channels.map((c, index) => (
                          <Fragment key={c.channelId}>
                            {isDirectConversation(c.kind) && !isDirectConversation(channels[index - 1]?.kind) && (
                              <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                                Direct messages
                              </div>
                            )}
                            <div
                              className={`grid ${chanGrid} items-center gap-[11px] border-b border-(--border-subtle) px-3 py-2 last:border-b-0`}
                            >
                              <span className="mono flex min-w-0 items-center gap-[7px] text-[12px]">
                                <Icon
                                  name={c.kind === 'mpim' ? 'users' : c.kind === 'im' ? 'at-sign' : 'hash'}
                                  size={12}
                                  color="var(--text-tertiary)"
                                  className="flex-none"
                                />
                                <span className="sr-only">
                                  {c.kind === 'mpim' ? 'Group DM' : c.kind === 'im' ? 'Direct message' : 'Channel'}
                                  :{' '}
                                </span>
                                <span className="truncate">
                                  {isDirectConversation(c.kind) ? c.name.replace(/^@+/, '') : c.name}
                                </span>
                              </span>
                              {showDefaultDispatch && (
                                <DefaultDispatchPicker
                                  options={agentOptions}
                                  activeId={c.agentId ?? b.agentIds[0] ?? null}
                                  disabled={!canWrite || !c.integrationId}
                                  onPick={(agentId) => setChannelAgent(c.integrationId!, c.channelId, agentId)}
                                />
                              )}
                            </div>
                          </Fragment>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                      No conversations observed yet — invite the bot to a channel or message it directly.
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
            No {label} {noun} is installed on an agent — turn off &ldquo;Show in use&rdquo; to see the{' '}
            {platformBots.length} free {platformBots.length === 1 ? noun : `${noun}s`}.
          </div>
        ) : (
          <div className="px-4 py-7 text-center">
            <div className="font-sans text-[13px] font-semibold leading-normal">No {noun}s yet</div>
            <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              A {label} {noun} is registered when you add a {label} integration to an agent.
            </div>
          </div>
        ))}
    </div>
  )
}

// ── GitHub App card ─────────────────────────────────────────────────────────
// The deployment GitHub App powering github-app workspaces (repo picker +
// credential-free daemon git). Deployment-config opt-in: when the CP has no
// GITHUB_APP_* env the routes 404 and this card shows the disabled note.
// Installations are org-level infrastructure (like bots) — every member can
// see them; installing and syncing are writes (viewers don't get those buttons),
// while uninstalling the App from an account is owner-only.
function GithubCard({ canWrite, isOwner }: { canWrite: boolean; isOwner: boolean }) {
  // Gate the org-scoped fetch on the active org (same hard-refresh race as SlackCard):
  // before OrgProvider resolves, `orgBase()` throws → the catch would show "not enabled"
  // even when it IS. Re-fetch once the org resolves / on switch.
  const { activeOrg } = useOrgs()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [installs, setInstalls] = useState<GithubInstallationDto[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<GithubInstallationDto | null>(null)

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    setEnabled(null)
    fetchGithubInstallations()
      .then(({ enabled, installations }) => {
        if (!alive) return
        setEnabled(enabled)
        setInstalls(installations)
      })
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [activeOrg])

  // The install link mints a ONE-SHOT signed state — fetch fresh per click.
  const install = async () => {
    setErr(null)
    try {
      const url = await fetchGithubInstallUrl()
      if (url) window.open(url, '_blank', 'noopener')
      else setErr('Could not mint an install link.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  // Refresh the org's claimed installations after GitHub changes or an install
  // finished in the other tab just now.
  const sync = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      setInstalls(await syncGithubInstallations())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          <span className="flex h-[15px] w-[15px] items-center justify-center">
            <GithubMark color="var(--text-primary)" />
          </span>
          GitHub
        </span>
        {enabled === true && canWrite && (
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={sync}>
              <Icon name="refresh-cw" size={13} />
              {busy ? 'Syncing…' : 'Sync'}
            </Button>
            <Button onClick={install}>
              <Icon name="external-link" size={13} />
              Install on GitHub
            </Button>
          </span>
        )}
      </div>
      {enabled === null && <LoadingState size={22} padding={20} />}
      {enabled === false && (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          Not enabled on this deployment — the control plane has no GitHub App configured.
        </div>
      )}
      {enabled === true && installs.length === 0 && (
        <div className="px-4 py-7 text-center">
          <div className="font-sans text-[13px] font-semibold leading-normal">No installations yet</div>
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            Install the GitHub App on your org to pick private repositories when creating agents — the daemon then
            clones and pushes with short-lived tokens, no git credentials on the machine.
          </div>
        </div>
      )}
      {/* Desktop only: the row collapses to one stacked column below the
          breakpoint, where a two-track header would label nothing. */}
      {enabled === true && installs.length > 0 && (
        <div className="row h hidden grid-cols-[minmax(0,1fr)_auto] gap-[11px] desktop:grid">
          <span>Installation</span>
          <span>Repository access</span>
        </div>
      )}
      {enabled === true &&
        installs.map((i) => (
          <Fragment key={i.id}>
            <div className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]">
              <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                  <span className="flex h-[14px] w-[14px] items-center justify-center">
                    <GithubMark color="var(--text-primary)" />
                  </span>
                </span>
                <span className="mono min-w-0 truncate text-[12.5px]">{i.accountLogin}</span>
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                  {i.accountType === 'Organization' ? 'org' : 'user'}
                </span>
                {i.suspended && <span className="badge bg-(--status-error-soft) text-(--status-error)">suspended</span>}
                {i.permissionsStatus === 'outdated' && (
                  <span className="badge bg-(--status-paused-soft) text-(--amber-500)">needs update</span>
                )}
              </div>
              <span className="flex items-center justify-between gap-3 desktop:justify-end">
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}
                </span>
                {isOwner && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-(--status-error) hover:text-(--status-error)"
                    onClick={() => setUninstalling(i)}
                  >
                    <Icon name="unplug" size={13} />
                    Uninstall
                  </Button>
                )}
              </span>
            </div>
            {i.permissionsStatus === 'outdated' && (
              <div
                role="status"
                className="flex flex-col items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500) desktop:flex-row desktop:items-center desktop:justify-between desktop:gap-3"
              >
                <span className="flex min-w-0 items-start gap-2">
                  <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
                  <span>This installation&rsquo;s GitHub permissions need updating before all features will work.</span>
                </span>
                <a href={i.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk flex-none text-[12px]">
                  Update permissions
                  <Icon name="external-link" size={12} />
                </a>
              </div>
            )}
          </Fragment>
        ))}
      {err && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
      )}
      {uninstalling && (
        <div className="scrim" onClick={() => setUninstalling(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <UninstallGithubInstallationModal
              installation={uninstalling}
              onClose={() => setUninstalling(null)}
              onUninstalled={(id) => {
                setInstalls((current) => current.filter((installation) => installation.id !== id))
                setUninstalling(null)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
