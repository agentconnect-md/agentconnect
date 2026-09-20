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
 * DMs. FAIL-CLOSED: a description that cannot be obtained — a timeout, a rate limit, any error
 * — refuses, because the bot may well be a member of the private channel behind the id and the
 * downstream call would then succeed. The one exception is the platform saying it does not know
 * the conversation (`channel_not_found`, which is also Slack's answer for a private channel this
 * bot is not in): that proves the downstream call cannot succeed either, so it is let through to
 * report the platform's own, more precise refusal. Platforms that declare nothing keep their
 * existing reach: whatever the bot is already in.
 */
/** The platform's own "no such conversation" — Slack's `channel_not_found` (also its answer for a
 *  private channel the bot is not in). The only classification failure that proves the downstream
 *  call would fail identically. */
function isUnknownConversation(err: unknown): boolean {
  const code = (err as { data?: { error?: unknown } } | undefined)?.data?.error
  return code === 'channel_not_found'
}

export async function assertChannelReachable(
  ctx: SessionContext,
  gw: MessageGateway,
  platform: string,
  channel: string,
  tool: string
): Promise<void> {
  if (!reachesPublicChannelsOnly(platform)) return
  if (platform === ctx.platform && channel === ctx.channel) return
  let info: { isPrivate?: boolean; isIm?: boolean }
  try {
    info = await gw.getChannelInfo(channel)
  } catch (err) {
    if (isUnknownConversation(err)) return
    throw new Error(
      `${tool}: could not determine whether ${channel} is a private ${platformLabel(platform)} conversation, so ` +
        'it was not reached. Retry; if it keeps failing, ask in that conversation instead.'
    )
  }
  if (!(info.isPrivate || info.isIm)) return
  throw new Error(
    `${tool}: ${channel} is a private ${platformLabel(platform)} conversation, and this session was not started ` +
      'there. A private channel or direct message is reachable only from a conversation the agent was invoked in; ' +
      'public channels are open.'
  )
}
