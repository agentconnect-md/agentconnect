// No 'use client' here: pure, stateless adornments rendered inside SettingsView's
// client tree.

import { Icon } from '@/components/ui'
import type { BotDto } from '@/lib/api'
import type { WebBotSettingsFragments } from '../contract'
import { feishuBrand, feishuConsoleAppUrl, feishuRegionOf } from './region'
import { FeishuMark } from './mark'

/** The bot's own developer-console page, on the cloud it was registered against.
 *  The region comes off the BOT, never off the active tab: a bot minted on one
 *  cloud is invisible to the other's console, so a tab-derived host would send
 *  the user to a 404. */
function FeishuRowLinks({ bot }: { bot: BotDto }) {
  const region = feishuRegionOf(bot)
  const brand = feishuBrand(region)
  return (
    <a
      href={feishuConsoleAppUrl(bot.feishuAppId, region)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Configure on ${brand}`}
      aria-label={`Configure on ${brand}`}
      className="iconbtn h-7 w-7 flex-none"
      onClick={(e) => e.stopPropagation()}
    >
      <Icon name="external-link" size={12} />
    </a>
  )
}

/** What deleting the bot here does NOT do — the app survives in its cloud's
 *  developer console. */
function FeishuDeleteNotice({ bot }: { bot: BotDto }) {
  const region = feishuRegionOf(bot)
  const brand = feishuBrand(region)
  return (
    <>
      <div className="flex items-start gap-[9px]">
        <Icon name="info" size={15} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
        <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          The {brand} app itself keeps existing. To remove it completely, delete it in the {brand} developer console.
        </span>
      </div>
      <a
        className="dsbtn sm dsbtn-secondary ml-6 mt-[10px] no-underline"
        href={feishuConsoleAppUrl(bot.feishuAppId, region)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="inline-flex h-[13px] w-[13px] items-center justify-center">
          <FeishuMark />
        </span>
        Open on {brand}
        <Icon name="arrow-up-right" size={13} />
      </a>
    </>
  )
}

export const feishuSettingsFragments: WebBotSettingsFragments = {
  botCard: { RowLinks: FeishuRowLinks, DeleteNotice: FeishuDeleteNotice }
}
