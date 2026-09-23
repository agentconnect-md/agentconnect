'use client'

// The agent page's Slack card ({@link WebAgentIntegrationCardFacet}): a revoked or rejected app's repair in the header, its progress under it.

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { BotDto } from '@/lib/api'
import { credentialAttention, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { SlackReinstallButton, useSlackBuiltinReinstall } from './reinstall'
import { SlackReplaceTokenAction } from './replace-token'

interface SlackAgentCardState {
  /** The integration's bot, once the console has it. */
  bot: BotDto | undefined
  /** The Integrations page's rule for bot actions: a viewer gets none. */
  canWrite: boolean
  reinstalling: boolean
  /** The last reinstall's failure, as a sentence. */
  error: string | null
  reinstall(): void
}

const CardCtx = createContext<SlackAgentCardState | null>(null)

/** Card-scope state carrier, not chrome: one reinstall shared by the header button and the notice. */
export function SlackAgentCardProvider({
  integration,
  children
}: {
  integration: IntegrationRow
  children: ReactNode
}) {
  const { bots, refresh } = useConsoleData()
  const { myRole } = useOrgs()
  const bot = bots.find((b) => b.id === integration.botId)
  const [error, setError] = useState<string | null>(null)
  const flow = useSlackBuiltinReinstall({
    onStart: () => setError(null),
    onFailed: (_botId, message) => setError(message),
    // A reinstall restores the revoked installs, so a re-read turns the card back.
    onInstalled: () => void refresh()
  })
  const value = useMemo<SlackAgentCardState>(
    () => ({
      bot,
      canWrite: myRole !== 'viewer',
      reinstalling: flow.botId !== null,
      error,
      reinstall: () => {
        if (bot) flow.start(bot.id)
      }
    }),
    [bot, error, flow, myRole]
  )
  return <CardCtx.Provider value={value}>{children}</CardCtx.Provider>
}

/** A revoked or rejected app's repair beside the unlink: reinstall the built-in app, or paste a custom app's new token. */
export function SlackAgentCardHeaderActions({ integration }: { integration: IntegrationRow }) {
  const card = useContext(CardCtx)
  if (!card?.bot || !card.canWrite || !credentialAttention(integration)) return null
  if (!card.bot.prebuilt) return <SlackReplaceTokenAction bot={card.bot} attention />
  return <SlackReinstallButton busy={card.reinstalling} onClick={card.reinstall} />
}

/** The reinstall's progress or failure under the header; nothing while idle. */
export function SlackAgentCardNotice({ padX }: { integration: IntegrationRow; padX: number }) {
  const t = useTranslations('Platforms.slack.settings')
  const card = useContext(CardCtx)
  if (card?.error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-sunken) font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
        style={{ padding: `9px ${padX}px` }}
      >
        <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
        <span>{card.error}</span>
      </div>
    )
  }
  if (card?.reinstalling) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 border-t border-(--border-subtle) bg-(--surface-app) font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)"
        style={{ padding: `10px ${padX}px` }}
      >
        <Icon name="loader" size={14} className="mt-[3px] flex-none animate-spin" />
        <span>{t('reinstalling')}</span>
      </div>
    )
  }
  return null
}
