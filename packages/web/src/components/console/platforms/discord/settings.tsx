// No 'use client' here: pure, stateless adornments rendered inside SettingsView's
// client tree. Discord has no lifecycle machinery — nothing to refresh, no
// workspace authorization to rotate.

import { Icon } from '@/components/ui'
import type { BotDto } from '@/lib/api'
import type { WebBotSettingsFragments } from '../contract'
import { discordBotInviteUrl } from './invite'
import { DiscordMark } from './mark'

/** The ready-made invite — correct scopes and permissions already in the URL, so
 *  nobody has to hand-build one in the Developer Portal's URL Generator. */
function DiscordRowLinks({ bot }: { bot: BotDto }) {
  if (!bot.discordAppId) return null
  return (
    <a
      href={discordBotInviteUrl(bot.discordAppId)}
      target="_blank"
      rel="noopener noreferrer"
      title="Invite this bot to a Discord server — preset scopes &amp; permissions"
      aria-label="Add this bot to a Discord server"
      className="iconbtn h-7 w-7 flex-none"
      onClick={(e) => e.stopPropagation()}
    >
      <Icon name="external-link" size={12} />
    </a>
  )
}

/** What deleting the bot here does NOT do — the Discord application survives in
 *  the Developer Portal. Without a recorded application id there is no per-app
 *  page to point at, so the block stays off rather than guessing a URL. */
function DiscordDeleteNotice({ bot }: { bot: BotDto }) {
  if (!bot.discordAppId) return null
  return (
    <>
      <div className="flex items-start gap-[9px]">
        <Icon name="info" size={15} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
        <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          The Discord application itself keeps existing. To remove it completely, delete it in the Developer Portal
          under Settings → Delete App.
        </span>
      </div>
      <a
        className="dsbtn sm dsbtn-secondary ml-6 mt-[10px] no-underline"
        href={`https://discord.com/developers/applications/${encodeURIComponent(bot.discordAppId)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="inline-flex h-[13px] w-[13px] items-center justify-center">
          <DiscordMark />
        </span>
        Open on Discord
        <Icon name="arrow-up-right" size={13} />
      </a>
    </>
  )
}

export const discordSettingsFragments: WebBotSettingsFragments = {
  botCard: { RowLinks: DiscordRowLinks, DeleteNotice: DiscordDeleteNotice }
}
