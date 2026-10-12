import { platformLabel, reachesPublicChannelsOnly } from '../../platforms/read-ports.js'
import type { MessageGateway, SessionContext } from './context.js'

/** The platform's own "no such conversation" (Slack's `channel_not_found`): the one lookup failure that proves the post would fail too. */
function isUnknownConversation(err: unknown): boolean {
  const code = (err as { data?: { error?: unknown } } | undefined)?.data?.error
  return code === 'channel_not_found'
}

/** Where `sendMessage` may post beyond this session's conversation on a `publicChannelReach` platform: a public channel, by the platform's own description; fails closed. */
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
