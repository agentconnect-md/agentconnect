'use client'

// Slack's Settings → Bots fragments (§10 `settingsFragments`): the transport
// badge, the app-settings deep link, and the whole manifest-refresh /
// builtin-reinstall machinery that used to be ~180 lines of card-scoped state in
// SettingsView's `BotsCard`.
//
// 'use client' here, unlike the rest of this directory: these fragments are
// reached from a VIEW rather than from ModalProvider's tree, and they own state,
// effects and a context of their own.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
import { ApiError, type BotDto, type SlackBotRefreshDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import type { WebBotSettingsFragments } from '../contract'
import { slackApi } from './api'
import { SLACK_MISSING_SCOPES_REASON, slackMissingScopesMessage } from './install-failure'
import { slackAppSettingsUrl } from './manifest'
import { SlackMark } from './mark'
import { slackRefreshNoticeState } from './refresh-notice'

/** One bot's last refresh outcome — a result, an error, or (mid-flight) neither. */
type SlackRefreshEntry = { result?: SlackBotRefreshDto; error?: string }

/**
 * The Slack card's cross-row state. Card-scoped, not row-scoped, on purpose:
 * one refresh may be in flight per card and one reinstall poll per card, so the
 * busy ids are single values while the outcomes are a per-bot map.
 */
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
  const [reinstall, setReinstall] = useState<{ botId: string; installId: string } | null>(null)

  const refreshApp = useCallback(
    async (b: BotDto) => {
      if (refreshBusyId) return
      setRefreshBusyId(b.id)
      setEntries((current) => ({ ...current, [b.id]: {} }))
      try {
        const result = await slackApi.refreshBot(b.id)
        setEntries((current) => ({ ...current, [b.id]: { result } }))
        refresh()
      } catch (e) {
        setEntries((current) => ({
          ...current,
          [b.id]: { error: e instanceof Error ? e.message : String(e) }
        }))
      } finally {
        setRefreshBusyId(null)
      }
    },
    [refresh, refreshBusyId]
  )

  const reinstallBuiltin = useCallback(
    async (b: BotDto) => {
      if (reinstall || refreshBusyId) return
      setEntries((current) => {
        const result = current[b.id]?.result
        return { ...current, [b.id]: result ? { result } : {} }
      })
      try {
        const started = await slackApi.startPlatformInstall({ botId: b.id })
        setReinstall({ botId: b.id, installId: started.id })
        window.open(started.installUrl, '_blank', 'noopener,width=680,height=760')
      } catch (e) {
        setEntries((current) => {
          const result = current[b.id]?.result
          const error = e instanceof Error ? e.message : String(e)
          return { ...current, [b.id]: result ? { result, error } : { error } }
        })
      }
    },
    [refreshBusyId, reinstall]
  )

  // Poll the reinstall row to a terminal state, then re-read the app so the
  // notice reflects the freshly rotated authorization. The ROW is the signal, not
  // "did an integration appear": a reauthorization only rotates the token.
  useEffect(() => {
    if (!reinstall) return
    const { botId, installId } = reinstall
    let stopped = false

    const stop = () => {
      stopped = true
      clearInterval(timer)
    }
    const fail = (message: string) => {
      stop()
      setReinstall(null)
      setEntries((current) => {
        const result = current[botId]?.result
        return { ...current, [botId]: result ? { result, error: message } : { error: message } }
      })
    }
    const tick = async () => {
      try {
        const status = await slackApi.getPlatformInstall(installId)
        if (stopped || status.status === 'pending') return
        if (status.status === 'failed') {
          fail(
            status.failureReason === 'denied'
              ? 'The reinstall was cancelled in Slack.'
              : status.failureReason === 'workspace_mismatch'
                ? 'Slack authorized a different workspace. Try again and choose this bot’s workspace.'
                : // A reinstall is the remedy for a short permission grant, so a
                  // reinstall that is ITSELF short has to name what is still
                  // absent — the generic line below would hide exactly that.
                  status.failureReason === SLACK_MISSING_SCOPES_REASON
                  ? slackMissingScopesMessage(status.missingScopes)
                  : 'Slack could not complete the reinstall. Please try again.'
          )
          return
        }
        if (status.botId !== botId) {
          fail('Slack reauthorized a different bot. Please try again.')
          return
        }

        stop()
        setReinstall(null)
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
      } catch (e) {
        if (!stopped && e instanceof ApiError && e.status === 404) {
          fail('This reinstall link expired. Please try again.')
        }
      }
    }

    const timer = setInterval(() => void tick(), 2500)
    void tick()
    return stop
  }, [refresh, reinstall])

  const value = useMemo<SlackBotCardState>(
    () => ({
      entryFor: (botId) => entries[botId],
      refreshingBot: (botId) => refreshBusyId === botId || reinstall?.botId === botId,
      reinstallingBot: (botId) => reinstall?.botId === botId,
      refreshApp: (bot) => void refreshApp(bot),
      reinstallBuiltin: (bot) => void reinstallBuiltin(bot)
    }),
    [entries, refreshApp, refreshBusyId, reinstall, reinstallBuiltin]
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
  if (!bot.slackAppId) return null
  return (
    <a
      href={slackAppSettingsUrl(bot.slackAppId)}
      target="_blank"
      rel="noopener noreferrer"
      title="Configure on Slack"
      aria-label="Configure on Slack"
      className="iconbtn h-7 w-7 flex-none"
      onClick={(e) => e.stopPropagation()}
    >
      <Icon name="external-link" size={12} />
    </a>
  )
}

function SlackRowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const card = useSlackBotCard()
  if (!bot.slackAppId || !canWrite) return null
  const entry = card.entryFor(bot.id)
  const needsAttention = entry?.result ? slackRefreshNoticeState(entry.result).needsAttention : false
  const refreshing = card.refreshingBot(bot.id)
  return (
    <button
      className={`iconbtn h-7 w-7 flex-none ${
        needsAttention ? 'border-(--amber-500) bg-(--status-paused-soft) text-(--amber-500)' : ''
      } ${refreshing ? 'cursor-default opacity-60' : ''}`}
      title={needsAttention ? 'Slack app needs attention' : 'Refresh Slack app'}
      aria-label="Refresh Slack app"
      disabled={refreshing}
      onClick={() => card.refreshApp(bot)}
    >
      <Icon name={refreshing ? 'loader' : 'refresh-cw'} size={14} className={refreshing ? 'animate-spin' : undefined} />
    </button>
  )
}

/** The refresh outcome — the failure banner and the manifest/authorization
 *  notice, in the order they render under the row today. */
function SlackCardNotice({ bot }: { bot: BotDto }) {
  const card = useSlackBotCard()
  const entry = card.entryFor(bot.id)
  if (!entry) return null
  return (
    <>
      {entry.error && (
        <div
          role="alert"
          className="border-b border-(--border-subtle) bg-(--status-error-soft) px-4 py-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
        >
          Couldn&apos;t refresh this Slack app — {entry.error}
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
  const { needsAttention, message: defaultMessage, action } = slackRefreshNoticeState(result)
  const message =
    builtin && result.authorization === 'invalid'
      ? 'Slack rejected this workspace authorization. Reinstall the app to reconnect it.'
      : defaultMessage

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
        {result.missingScopes.length > 0 && (
          <span className="mono ml-1 text-[11px]">Missing: {result.missingScopes.join(', ')}</span>
        )}
      </span>
      {action?.label === 'Reinstall workspace' && onReinstall ? (
        <button
          type="button"
          className="lnk flex-none border-0 bg-transparent p-0"
          disabled={reinstalling}
          onClick={onReinstall}
        >
          {reinstalling ? 'Reinstalling…' : action.label}
        </button>
      ) : action ? (
        <a href={action.href} target="_blank" rel="noopener noreferrer" className="lnk flex-none">
          {action.label}
        </a>
      ) : null}
    </div>
  )
}

/** What deleting the bot here does NOT do — AgentConnect forgets the credentials,
 *  the Slack app itself keeps existing in the workspace. */
function SlackDeleteNotice({ bot }: { bot: BotDto }) {
  return (
    <>
      <div className="flex items-start gap-[9px]">
        <Icon name="info" size={15} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
        <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          The Slack app itself keeps existing in the workspace. To remove it completely, delete it on Slack under Basic
          Information → Delete App.
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
        Open on Slack
        <Icon name="arrow-up-right" size={13} />
      </a>
    </>
  )
}

export const slackSettingsFragments: WebBotSettingsFragments = {
  botCard: { RowBadges: SlackRowBadges, RowLinks: SlackRowLinks, DeleteNotice: SlackDeleteNotice },
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
    shareHint: {
      available: 'Allow several agents to share this bot across channels',
      unavailable: 'HTTP transport required to share'
    },
    identityNoun: 'app'
  }
}
