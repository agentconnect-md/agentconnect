import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import type { WeixinReplyPort } from './turn-output.js'

export const WeixinCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: 'weixin',
  // iLink's thread coordinate is the constant 'dm' — the channel, not the
  // thread, names the conversation.
  threadIdentifiesSession: false,
  reply(conn, msg, _ctx, text) {
    void (conn as WeixinReplyPort).sendText(msg.channel, text).catch(() => undefined)
  },
  status(conn, msg, ctx, _info, link) {
    this.reply(conn, msg, ctx, link ? `查看会话: ${link}` : '请在 AgentConnect 控制台查看会话。')
  }
}
