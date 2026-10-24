import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import { QQConnection, QQReplyId } from './connection.js'

export const QQCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: 'qq',
  threadIdentifiesSession: true,
  reply(conn, msg, _ctx, text) {
    const replyId = QQReplyId(msg)
    if (replyId) void (conn as QQConnection).sendText(msg.channel, replyId, text).catch(() => undefined)
  },
  status(conn, msg, ctx, _info, link) {
    this.reply(conn, msg, ctx, link ? `View this session: ${link}` : 'View this session in the AgentConnect console.')
  },
  // QQ only answers passively, so the notice replies to the message that raised it.
  async notice(conn, channel, _thread, text, msg) {
    const replyId = QQReplyId(msg)
    if (!replyId) throw new Error('QQ notice has no message to reply to')
    await (conn as QQConnection).sendText(channel, replyId, text)
  }
}
