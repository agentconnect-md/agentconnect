import { platformLabel, reachesPublicChannelsOnly } from '../../platforms/read-ports.js'
import type { MessageGateway, SessionContext } from './context.js'

/**
 * Which conversation a tool may reach BEYOND the one this session is in.
 *
 * On a platform that declares `publicChannelReach` (Slack), a public channel is open — the
 * connection joins it on first use — and nothing else is: a private channel, a DM or a group
 * DM is readable and writable only when it IS this session's conversation, i.e. the agent was
 * invoked there. Membership is not consent: the bot may have been invited to a private channel
 * for one purpose, and that must not make its history readable, or its members addressable,
 * from every other conversation the same agent is in.
 *
 * Decided from the platform's own description of the conversation (`conversations.info`),
 * never from the id's shape — Slack's `G…` ids are shared by legacy private channels and group
 * DMs. A conversation the platform will not describe (an unknown id, or a private one this bot
 * is not in) is let through so the call itself reports the platform's own refusal, which is
 * more precise than anything this gate could say. Platforms that declare nothing keep their
 * existing reach: whatever the bot is already in.
 */
export async function assertChannelReachable(
  ctx: SessionContext,
  gw: MessageGateway,
  platform: string,
  channel: string,
  tool: string
): Promise<void> {
  if (!reachesPublicChannelsOnly(platform)) return
  if (platform === ctx.platform && channel === ctx.channel) return
  const info = await gw.getChannelInfo(channel).catch(() => undefined)
  if (!info || !(info.isPrivate || info.isIm)) return
  throw new Error(
    `${tool}: ${channel} is a private ${platformLabel(platform)} conversation, and this session was not started ` +
      'there. A private channel or direct message is reachable only from a conversation the agent was invoked in; ' +
      'public channels are open.'
  )
}
