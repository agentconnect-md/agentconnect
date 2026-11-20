// No 'use client' here: rendered only inside the console views and ModalProvider's tree, both client trees.

import { useTranslations } from 'next-intl'
import type { BotDto } from '@/lib/api'
import type { IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import type { WebAgentIntegrationCardFacet, WebBotSettingsFragments } from '../contract'
import { AddressField, CopyAddressButton } from './fields'

/** The stored address is the bot's `externalAppId`; the row's name is the same address, for a bot not yet read. */
export function emailAddressOf(bot: Pick<BotDto, 'externalAppId' | 'name'> | undefined, fallback: string): string {
  return bot?.externalAppId || bot?.name || fallback
}

function HeaderActions({ integration }: { integration: IntegrationRow }) {
  const { bots } = useConsoleData()
  const bot = bots.find((candidate) => candidate.id === integration.botId)
  return <CopyAddressButton address={emailAddressOf(bot, integration.name)} />
}

/** Removing the integration retires its address for good (email-integration.md §3). */
function RemoveBody({ integration }: { integration: IntegrationRow }) {
  const t = useTranslations('Platforms.email')
  return t.rich('remove', { name: () => <span className="mono text-(--text-primary)">{integration.name}</span> })
}

export const emailAgentCard: WebAgentIntegrationCardFacet = { HeaderActions, RemoveBody }

function RowSettings({ bot }: { bot: BotDto; canWrite: boolean }) {
  return (
    <div className="p-4">
      <AddressField address={emailAddressOf(bot, bot.name)} />
    </div>
  )
}

function DeleteNotice() {
  const t = useTranslations('Platforms.email')
  return <p className="m-0 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">{t('retired')}</p>
}

export const emailSettingsFragments: WebBotSettingsFragments = {
  botCard: { RowSettings, DeleteNotice }
}
