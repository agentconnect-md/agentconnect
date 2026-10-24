// DingTalk's command chrome (§7.4): control replies as plain text into the command's conversation.
import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import type { DingTalkReplyPort } from './connection.js'

export const dingTalkCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: DINGTALK_PLATFORM,
  // A command keys to its own fresh reply-chain thread, so commands resolve through the conversation's latest session.
  threadIdentifiesSession: false,
  reply(conn, msg, _ctx, text) {
    void (conn as DingTalkReplyPort | undefined)?.sendText(msg.channel, text).catch(() => undefined)
  },
  status(conn, msg, ctx, _info, link) {
    this.reply(conn, msg, ctx, link ? `View this session: ${link}` : 'View this session in the AgentConnect console.')
  },
  // A reply chain has no thread to post into, so core's notice is a plain message in the conversation.
  async notice(conn, channel, _thread, text) {
    if ((await (conn as DingTalkReplyPort).sendText(channel, text)) === undefined)
      throw new Error('DingTalk did not accept the notice')
  }
}
