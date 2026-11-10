// WeChat's command chrome (§7.4): control replies as plain text into the bot's one chat.
import { WECHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import type { WeChatReplyPort } from './connection.js'

export const weChatCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: WECHAT_PLATFORM,
  // The one chat's thread is constant, so commands resolve through the chat's latest session.
  threadIdentifiesSession: false,
  // Only the bound person writes here and nobody can @mention the bot, so a mute would just swallow their next message.
  stopLatchesMute: false,
  reply(conn, msg, _ctx, text) {
    void (conn as WeChatReplyPort | undefined)?.sendText(msg.channel, text).catch(() => undefined)
  },
  status(conn, msg, ctx, _info, link) {
    this.reply(conn, msg, ctx, link ? `View this session: ${link}` : 'View this session in the AgentConnect console.')
  }
}
