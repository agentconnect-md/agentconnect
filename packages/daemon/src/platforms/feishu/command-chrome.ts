/**
 * Feishu / Lark's **command chrome surface** (§7.4).
 *
 * The smallest of the four: v1 has no interactive cards or link buttons on this
 * path, so `/status` is a plain-text line with a `🔗 <url>` tail and there is no
 * select card (the caller's numbered text list serves).
 */
import type { FeishuConnection } from '../../feishu/connection.js'
import { renderStatusReply, type FeishuStatusInfo } from '../../feishu/render.js'
import type { CommandChromeContext, CommandChromeSurface } from '../command-chrome.js'

export const feishuCommandChrome: CommandChromeSurface<unknown, FeishuStatusInfo> = {
  platform: 'feishu',
  // Commands resolve through the channel's latest session, as before this seam.
  threadIdentifiesSession: false,

  reply(conn: unknown, _msg: unknown, ctx: CommandChromeContext, text: string): void {
    void (conn as FeishuConnection).postMessage(ctx.channel, text, ctx.replyThread)
  },

  status(conn: unknown, _msg: unknown, ctx: CommandChromeContext, info: FeishuStatusInfo, link?: string): void {
    void (conn as FeishuConnection).postChrome(ctx.channel, renderStatusReply(info, link))
  }
}
