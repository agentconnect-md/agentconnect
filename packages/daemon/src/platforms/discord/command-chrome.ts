/**
 * Discord's **command chrome surface** (§7.4).
 *
 * Two Discord facts drive this surface's existence:
 *
 *  - Slack's `<url|text>` link syntax renders LITERALLY on Discord, so `/status`
 *    carries its session deep link as a real link BUTTON row instead;
 *  - components cap at 25 buttons, so a select control over more options than
 *    that cannot render as a card — `selectCard` answers `false` and the caller
 *    falls back to the shared numbered text list.
 *
 * The select custom-id scheme (`ac_sel:<code>:<index>`) already lives with its
 * builder in `discord/render.ts`; this surface only dispatches to it.
 */
import type { DiscordConnection } from '../../discord/connection.js'
import {
  buildDiscordSelectComponents,
  buildLinkComponents,
  renderStatusText,
  type DiscordStatusInfo
} from '../../discord/render.js'
import type { CommandChromeContext, CommandChromeSurface, SelectCardSpec } from '../command-chrome.js'

export const discordCommandChrome: CommandChromeSurface<unknown, DiscordStatusInfo> = {
  platform: 'discord',
  // Discord now carries Slack-parity parent/thread coordinates, so a command in a
  // thread identifies that exact session rather than the channel's newest thread.
  threadIdentifiesSession: true,

  reply(conn: unknown, _msg: unknown, ctx: CommandChromeContext, text: string): void {
    void (conn as DiscordConnection).postMessage(ctx.channel, text, ctx.replyThread)
  },

  status(conn: unknown, _msg: unknown, ctx: CommandChromeContext, info: DiscordStatusInfo, link?: string): void {
    // Markdown line + a real "View session" link button.
    void (conn as DiscordConnection).postChrome(
      ctx.channel,
      renderStatusText(info),
      link ? { threadTs: ctx.replyThread, keyboard: buildLinkComponents(link) } : { threadTs: ctx.replyThread }
    )
  },

  selectCard(conn: unknown, _msg: unknown, ctx: CommandChromeContext, card: SelectCardSpec): boolean {
    const components = buildDiscordSelectComponents(card.kind, card.current, card.options)
    if (!components) return false
    // sessionKey = the resolved key, so a tapped button resolves back to it.
    void (conn as DiscordConnection).postChrome(ctx.channel, card.header, {
      threadTs: ctx.replyThread,
      keyboard: components,
      sessionKey: ctx.sessionKey
    })
    return true
  }
}
