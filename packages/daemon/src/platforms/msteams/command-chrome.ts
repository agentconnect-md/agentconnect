// Teams' command chrome (§7.4): control replies and core notices as plain messages in the command's conversation.
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import { msTeamsTargetOf, type MsTeamsReplyPort } from './connection.js'

export const msTeamsCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: MSTEAMS_PLATFORM,
  // A group-chat command keys to its own fresh reply-chain thread, so commands resolve through the conversation's latest session.
  threadIdentifiesSession: false,
  reply(conn, msg, ctx, text) {
    const port = conn as MsTeamsReplyPort | undefined
    const target = msTeamsTargetOf(msg) ?? port?.targetFor(ctx.channel, ctx.replyThread)
    if (port && target) void port.postText(target, text).catch(() => undefined)
  },
  status(conn, msg, ctx, _info, link) {
    this.reply(conn, msg, ctx, link ? `[View this session](${link})` : 'View this session in the AgentConnect console.')
  },
  // Out of a turn there is no activity to read, so the conversation's recorded target is used; none recorded cannot post.
  async notice(conn, channel, thread, text) {
    const port = conn as MsTeamsReplyPort
    const target = port.targetFor(channel, thread)
    if (!target) throw new Error('no recorded Teams target for the notice')
    await port.postText(target, text)
  }
}
