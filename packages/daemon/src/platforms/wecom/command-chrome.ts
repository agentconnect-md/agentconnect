// WeCom's command chrome (§7.4): control replies and notices as Markdown messages into the command's conversation.
import { WECOM_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import type { WeComConnection } from './connection.js'

type WeComChromePort = Pick<WeComConnection, 'sendText'>

export const weComCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: WECOM_PLATFORM,
  // A group's one session may sit at an append coordinate, so commands resolve through the conversation's latest session.
  threadIdentifiesSession: false,
  reply(conn, msg, _ctx, text) {
    void (conn as WeComChromePort | undefined)?.sendText(msg.channel, text).catch(() => undefined)
  },
  status(conn, msg, ctx, _info, link) {
    this.reply(conn, msg, ctx, link ? `View this session: ${link}` : 'View this session in the AgentConnect console.')
  },
  // WeCom has no threads, so core's notice is a message in the conversation.
  async notice(conn, channel, _thread, text) {
    if (!(await (conn as WeComChromePort).sendText(channel, text))) throw new Error('WeCom did not accept the notice')
  }
}
