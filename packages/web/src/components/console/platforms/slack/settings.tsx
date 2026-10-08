'use client'

// Slack's Integrations-page bot fragments (§10 `settingsFragments`): the transport badge, the app-settings link, and the refresh/reinstall card state.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon, Toggle } from '@/components/ui'
import {
  PLATFORM_CONVERSATION_DEFAULTS,
  type BotConversationDefaults,
  type BotDto,
  type SlackBotRefreshDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import type { WebBotSettingsFragments } from '../contract'
import { slackApi } from './api'
import { slackAppSettingsUrl } from './manifest'
import { SlackMark } from './mark'
import { slackRefreshNoticeState } from './refresh-notice'
import { SlackReinstallButton, useSlackBuiltinReinstall } from './reinstall'
import { SlackReplaceTokenAction } from './replace-token'

/** One bot's last outcome — a refresh result or error, a reinstall failure, or (mid-flight) none of them. */
type SlackRefreshEntry = { result?: SlackBotRefreshDto; error?: string; reinstallError?: string }

/** Card-scoped on purpose: one refresh and one reinstall in flight per card, outcomes per bot. */
interface SlackBotCardState {
  entryFor(botId: string): SlackRefreshEntry | undefined
  refreshingBot(botId: string): boolean
  reinstallingBot(botId: string): boolean
  refreshApp(bot: BotDto): void
  reinstallBuiltin(bot: BotDto): void
}

const SlackBotCard = createContext<SlackBotCardState | null>(null)

/** Fragments render only inside {@link SlackBotCardProvider}; a null context is a
 *  wiring bug in the host, not a runtime state to design for. */
function useSlackBotCard(): SlackBotCardState {
  const card = useContext(SlackBotCard)
  if (!card) throw new Error('Slack bot-card fragment rendered outside its CardProvider')
  return card
}

function SlackBotCardProvider({ children }: { children: ReactNode }) {
  const { refresh } = useConsoleData()
  const [refreshBusyId, setRefreshBusyId] = useState<string | null>(null)
  const [entries, setEntries] = useState<Record<string, SlackRefreshEntry>>({})

  // Re-read one app and record the outcome — the refresh button and a finished reinstall both land here.
  const readApp = useCallback(
    async (botId: string) => {
      setRefreshBusyId(botId)
      try {
        const result = await slackApi.refreshBot(botId)
        setEntries((current) => ({ ...current, [botId]: { result } }))
        refresh()
      } catch (e) {
        setEntries((current) => ({
          ...current,
          [botId]: { error: e instanceof Error ? e.message : String(e) }
        }))
      } finally {
        setRefreshBusyId(null)
      }
    },
    [refresh]
  )

  const refreshApp = useCallback(
    (b: BotDto) => {
      if (refreshBusyId) return
      setEntries((current) => ({ ...current, [b.id]: {} }))
      void readApp(b.id)
    },
    [readApp, refreshBusyId]
  )

  // A reinstall's failure sits beside the bot's last refresh result rather than replacing it.
  const setReinstallError = useCallback((botId: string, reinstallError?: string) => {
    setEntries((current) => {
      const result = current[botId]?.result
      return { ...current, [botId]: { ...(result ? { result } : {}), ...(reinstallError ? { reinstallError } : {}) } }
    })
  }, [])

  const reinstall = useSlackBuiltinReinstall({
    onStart: (botId) => setReinstallError(botId),
    onFailed: setReinstallError,
    onInstalled: (botId) => void readApp(botId)
  })

  const value = useMemo<SlackBotCardState>(
    () => ({
      entryFor: (botId) => entries[botId],
      refreshingBot: (botId) => refreshBusyId === botId || reinstall.botId === botId,
      reinstallingBot: (botId) => reinstall.botId === botId,
      refreshApp,
      reinstallBuiltin: (bot) => {
        if (!refreshBusyId) reinstall.start(bot.id)
      }
    }),
    [entries, refreshApp, refreshBusyId, reinstall]
  )

  return <SlackBotCard.Provider value={value}>{children}</SlackBotCard.Provider>
}

/** The transport tag — it is what makes the Sharable column's disabled state
 *  self-explanatory: only an http bot may be shared. */
function SlackRowBadges({ bot }: { bot: BotDto }) {
  return (
    <span className="badge bg-(--surface-active) text-(--text-tertiary) max-[479px]:hidden">
      {bot.transport ?? 'socket'}
    </span>
  )
}

function SlackRowLinks({ bot }: { bot: BotDto }) {
  const t = useTranslations('Platforms.slack.settings')
  if (!bot.slackAppId) return null
  return (
    <a
      href={slackAppSettingsUrl(bot.slackAppId)}
      target="_blank"
      rel="noopener noreferrer"
      title={t('configure')}
      aria-label={t('configure')}
      className="iconbtn h-7 w-7 flex-none max-[479px]:hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <Icon name="external-link" size={12} />
    </a>
  )
}

function SlackRowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.slack.settings')
  const card = useSlackBotCard()
  if (!canWrite) return null
  const entry = card.entryFor(bot.id)
  const needsAttention = entry?.result
    ? slackRefreshNoticeState(entry.result, { builtin: bot.prebuilt }).needsAttention
    : false
  const refreshing = card.refreshingBot(bot.id)
  const reinstalling = card.reinstallingBot(bot.id)
  return (
    <>
      {/* A revoked or rejected built-in app is repaired by reinstalling it, straight from the row; a pending one can be restarted. */}
      {bot.prebuilt && (bot.revokedAt || bot.credentialRejectedAt) && (
        <SlackReinstallButton
          busy={reinstalling}
          disabled={refreshing && !reinstalling}
          onClick={() => card.reinstallBuiltin(bot)}
        />
      )}
      {/* A built-in app's token comes from its workspace install, so only a custom app takes a pasted one. */}
      {!bot.prebuilt && (
        <SlackReplaceTokenAction
          bot={bot}
          // A notice from before the replacement describes the old token, so re-read the app.
          onReplaced={() => {
            if (card.entryFor(bot.id)) card.refreshApp(bot)
          }}
        />
      )}
      {bot.slackAppId && (
        <button
          className={`iconbtn h-7 w-7 flex-none ${
            needsAttention ? 'border-(--amber-500) bg-(--status-paused-soft) text-(--amber-500)' : ''
          } ${refreshing ? 'cursor-default opacity-60' : ''}`}
          title={needsAttention ? t('needsAttention') : t('refresh')}
          aria-label={t('refresh')}
          disabled={refreshing}
          onClick={() => card.refreshApp(bot)}
        >
          <Icon
            name={refreshing ? 'loader' : 'refresh-cw'}
            size={14}
            className={refreshing ? 'animate-spin' : undefined}
          />
        </button>
      )}
    </>
  )
}

/** The refresh outcome — the failure banner and the manifest/authorization
 *  notice, in the order they render under the row today. */
function SlackCardNotice({ bot }: { bot: BotDto }) {
  const t = useTranslations('Platforms.slack.settings')
  const card = useSlackBotCard()
  const entry = card.entryFor(bot.id)
  if (!entry) return null
  // Only a refresh failure is framed as one; a reinstall failure is already its own sentence.
  const failure = entry.error ? t('refreshFailed', { error: entry.error }) : entry.reinstallError
  return (
    <>
      {failure && (
        <div
          role="alert"
          className="border-b border-(--border-subtle) bg-(--status-error-soft) px-4 py-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
        >
          {failure}
        </div>
      )}
      {entry.result && (
        <SlackRefreshNotice
          result={entry.result}
          builtin={bot.prebuilt}
          reinstalling={card.reinstallingBot(bot.id)}
          onReinstall={bot.prebuilt ? () => card.reinstallBuiltin(bot) : undefined}
        />
      )}
    </>
  )
}

function SlackRefreshNotice({
  result,
  builtin,
  reinstalling,
  onReinstall
}: {
  result: SlackBotRefreshDto
  builtin?: boolean
  reinstalling?: boolean
  onReinstall?: () => void
}) {
  const {
    needsAttention,
    message: defaultMessage,
    action,
    scopeFragment
  } = slackRefreshNoticeState(result, { builtin })
  const t = useTranslations('Platforms.slack.settings')
  const [copied, setCopied] = useState(false)
  const message = builtin && result.authorization === 'invalid' ? t('builtinRejected') : defaultMessage
  const copyScopes = async () => {
    if (!scopeFragment) return
    try {
      await navigator.clipboard.writeText(scopeFragment)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — the list stays selectable in the notice */
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-start gap-2 border-b border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] desktop:flex-row desktop:justify-between desktop:gap-3 ${
        needsAttention ? 'bg-(--status-paused-soft) text-(--amber-500)' : 'text-(--green-500)'
      }`}
    >
      <span className="min-w-0">
        <span>{message}</span>
        {result.manifestMissingScopes.length > 0 && (
          <span className="mono ml-1 text-[11px]">
            {t('manifestMissing', { scopes: result.manifestMissingScopes.join(', ') })}
          </span>
        )}
        {result.missingScopes.length > 0 && (
          <span className="mono ml-1 text-[11px]">{t('missing', { scopes: result.missingScopes.join(', ') })}</span>
        )}
      </span>
      {(scopeFragment || action) && (
        <span className="flex flex-none items-center gap-3">
          {scopeFragment && (
            <button type="button" className="lnk border-0 bg-transparent p-0" onClick={() => void copyScopes()}>
              {copied ? t('copied') : t('copyScopes')}
            </button>
          )}
          {action?.label === 'Reinstall workspace' && onReinstall ? (
            <button
              type="button"
              className="lnk border-0 bg-transparent p-0"
              disabled={reinstalling}
              onClick={onReinstall}
            >
              {reinstalling ? t('reinstalling') : action.label}
            </button>
          ) : action ? (
            <a href={action.href} target="_blank" rel="noopener noreferrer" className="lnk">
              {action.label}
            </a>
          ) : null}
        </span>
      )}
    </div>
  )
}

/** What deleting the bot here does NOT do — AgentConnect forgets the credentials,
 *  the Slack app itself keeps existing in the workspace. */
function SlackDeleteNotice({ bot }: { bot: BotDto }) {
  const t = useTranslations('Platforms.slack.settings')
  return (
    <>
      <div className="flex items-start gap-[9px]">
        <Icon name="info" size={15} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
        <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          {t('deleteNotice')}
        </span>
      </div>
      <a
        className="dsbtn sm dsbtn-secondary ml-6 mt-[10px] no-underline"
        href={slackAppSettingsUrl(bot.slackAppId)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="inline-flex h-[13px] w-[13px] items-center justify-center">
          <SlackMark />
        </span>
        {t('openOn')}
        <Icon name="arrow-up-right" size={13} />
      </a>
    </>
  )
}

/**
 * The bot's "join public channels on demand" switch (`PATCH /bots/:id` `joinPublicChannels`).
 * On, the daemon enters any PUBLIC channel the first time an agent reads or posts there
 * (`conversations.join`, `channels:join`) instead of waiting for an invite; off, the bot
 * reaches only the channels it was added to. Private channels are invitation-only either
 * way. Slack alone declares `publicChannelJoin`, so only its rows render this.
 */
function SlackJoinPublicChannels({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.slack.settings')
  const { setBotJoinPublicChannels } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enabled = bot.joinPublicChannels !== false
  const flip = async (next: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await setBotJoinPublicChannels(bot.id, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-(--border-subtle) bg-(--surface-card) px-3 py-2">
      <div className="min-w-0">
        <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)">
          {t('joinPublicChannels')}
        </div>
        {/* The scope is the point of this copy: a join is persistent, bot-wide membership, not a
            one-time read for the agent that asked (review on #2180). */}
        <div className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {enabled ? t('joinPublicChannelsEnabled') : t('joinPublicChannelsDisabled')}
        </div>
        {error && (
          <div className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">{error}</div>
        )}
      </div>
      <Toggle
        checked={enabled}
        disabled={!canWrite || busy}
        onChange={(next) => void flip(next)}
        ariaLabel={t('joinPublicChannels')}
      />
    </div>
  )
}

const DEFAULTS_FIELD =
  'rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] leading-normal text-(--text-primary) disabled:opacity-60'

/**
 * The bot's conversation defaults (`PATCH /bots/:id` `conversationDefaults`): what a channel or a
 * DM starts as until someone changes it on its own row below — trigger and session mode, for
 * every org-visible agent on the bot. Off is the fence a workspace with outside members wants: a
 * channel the bot is added to, or joins by itself, stays silent until an editor enables it there.
 * A private agent's conversations start Off regardless (resource-visibility.md §14).
 */
function SlackConversationDefaults({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.slack.settings')
  const { setBotConversationDefaults } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defaults = bot.conversationDefaults ?? PLATFORM_CONVERSATION_DEFAULTS
  const save = async (next: BotConversationDefaults) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await setBotConversationDefaults(bot.id, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const sessionModes = (
    <>
      <option value="createNew">{t('defaultSessionModes.createNew')}</option>
      <option value="append">{t('defaultSessionModes.append')}</option>
    </>
  )
  const label = (room: string, setting: string) => `${room} — ${setting}`
  return (
    <div className="mb-3 rounded-lg border border-(--border-subtle) bg-(--surface-card) px-3 py-2">
      <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)">
        {t('conversationDefaults')}
      </div>
      <div className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
        {t('conversationDefaultsHint')}
      </div>
      <div className="mt-2 grid grid-cols-[auto_1fr_1fr] items-center gap-x-3 gap-y-2 font-sans text-[12px] leading-normal text-(--text-secondary)">
        <span />
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-(--text-tertiary)">
          {t('defaultRespondTo')}
        </span>
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-(--text-tertiary)">
          {t('defaultSessionMode')}
        </span>
        <span>{t('channelsDefault')}</span>
        <select
          className={DEFAULTS_FIELD}
          aria-label={label(t('channelsDefault'), t('defaultRespondTo'))}
          value={defaults.channel.trigger}
          disabled={!canWrite || busy}
          onChange={(e) =>
            void save({
              ...defaults,
              channel: { ...defaults.channel, trigger: e.target.value as BotConversationDefaults['channel']['trigger'] }
            })
          }
        >
          <option value="off">{t('defaultTrigger.off')}</option>
          <option value="mention">{t('defaultTrigger.mention')}</option>
          <option value="any">{t('defaultTrigger.any')}</option>
        </select>
        <select
          className={DEFAULTS_FIELD}
          aria-label={label(t('channelsDefault'), t('defaultSessionMode'))}
          value={defaults.channel.sessionMode}
          disabled={!canWrite || busy}
          onChange={(e) =>
            void save({
              ...defaults,
              channel: {
                ...defaults.channel,
                sessionMode: e.target.value as BotConversationDefaults['channel']['sessionMode']
              }
            })
          }
        >
          {sessionModes}
        </select>
        <span>{t('dmsDefault')}</span>
        <select
          className={DEFAULTS_FIELD}
          aria-label={label(t('dmsDefault'), t('defaultRespondTo'))}
          value={defaults.dm.trigger}
          disabled={!canWrite || busy}
          onChange={(e) =>
            void save({
              ...defaults,
              dm: { ...defaults.dm, trigger: e.target.value as BotConversationDefaults['dm']['trigger'] }
            })
          }
        >
          <option value="off">{t('defaultTrigger.off')}</option>
          <option value="any">{t('defaultTrigger.dmOn')}</option>
        </select>
        <select
          className={DEFAULTS_FIELD}
          aria-label={label(t('dmsDefault'), t('defaultSessionMode'))}
          value={defaults.dm.sessionMode}
          disabled={!canWrite || busy}
          onChange={(e) =>
            void save({
              ...defaults,
              dm: { ...defaults.dm, sessionMode: e.target.value as BotConversationDefaults['dm']['sessionMode'] }
            })
          }
        >
          {sessionModes}
        </select>
      </div>
      {error && (
        <div className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">{error}</div>
      )}
    </div>
  )
}

/** The bot-level settings at the top of the expanded Slack row: the join switch and the conversation defaults. */
function SlackRowSettings({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  return (
    <>
      <SlackJoinPublicChannels bot={bot} canWrite={canWrite} />
      <SlackConversationDefaults bot={bot} canWrite={canWrite} />
    </>
  )
}

export const slackSettingsFragments: WebBotSettingsFragments = {
  botCard: {
    RowBadges: SlackRowBadges,
    RowLinks: SlackRowLinks,
    RowSettings: SlackRowSettings,
    DeleteNotice: SlackDeleteNotice
  },
  lifecycleActions: {
    CardProvider: SlackBotCardProvider,
    RowActions: SlackRowActions,
    CardNotice: SlackCardNotice
  },
  // The two host-rendered row sentences, which USED to be these exact strings
  // for every platform. Slack is the only module that declares either, and both
  // are unchanged: it is the only platform whose bots can be revoked
  // (`rc/bot-revoked` carries Slack's own `app_uninstalled`/`tokens_revoked`),
  // and the only one where sharing is real and gated on transport — the
  // socket↔http axis is immutable post-create, so "switch to HTTP" means
  // recreating the app, which is exactly what the CP's 409 says.
  //
  // `identityNoun` is Slack's for the same reason its wizard says "manifest":
  // what you install in a Slack workspace is an APP. It was the `noun: 'app'`
  // column of the host's hand-written tab table until the table became a
  // registry projection (audit §10.6 F14).
  copy: {
    revokedHint: 'The Slack workspace uninstalled this app or revoked its tokens — re-install to reconnect',
    // `invalid_auth` answers both a dead token and a caller outside the app's IP allowlist, so the sentence names both fixes.
    rejectedHint:
      'Slack rejected this app’s bot token — add AgentConnect’s addresses to the app’s IP allowlist, or re-install the app or replace its token',
    shareHint: {
      available: 'Allow several agents to share this bot across channels',
      unavailable: 'HTTP transport required to share'
    },
    identityNoun: 'app'
  }
}
