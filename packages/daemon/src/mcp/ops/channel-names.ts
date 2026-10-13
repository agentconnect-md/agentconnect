import type { MessageGateway, SessionContext } from './context.js'
import { ambiguousIntegrations, resolveGatewayForPlatform, type GatewayDeps } from './gateway.js'

/** The tools whose `channel` names a conversation the place rules judge; `sendMessage` alone is routed by `platform`. */
const CHANNEL_TOOLS: ReadonlySet<string> = new Set([
  'getChannelHistory',
  'getThreadHistory',
  'getReactions',
  'listBookmarks',
  'sendMessage',
  'scheduleMessage',
  'addReaction',
  'deleteMessage',
  'addBookmark',
  'removeBookmark',
  'createCanvas'
])
const PLATFORM_ROUTED: ReadonlySet<string> = new Set(['sendMessage'])

/** A `channel` given by name becomes its id once, on the bot the call acts as, so the rules and the call see one conversation. */
export async function resolveChannelArg(
  ctx: SessionContext,
  tool: string,
  args: Record<string, unknown>,
  deps: GatewayDeps
): Promise<Record<string, unknown>> {
  const channel = args.channel
  if (!CHANNEL_TOOLS.has(tool) || typeof channel !== 'string' || channel === '') return args
  const platform = PLATFORM_ROUTED.has(tool) && typeof args.platform === 'string' ? args.platform : ctx.platform
  const named = typeof args.integrationId === 'string' ? args.integrationId : undefined
  // A bot the call may ask a person to choose resolves nothing, so no name is read off a guessed bot.
  if (named === undefined && ambiguousIntegrations(ctx, platform).length > 0) return args
  let gw: MessageGateway
  try {
    gw = resolveGatewayForPlatform(ctx, deps, platform, named).gw
  } catch {
    // No such bot, or none live: the call itself reports it.
    return args
  }
  const id = await gw.resolveChannelName?.(channel).catch(() => undefined)
  return id ? { ...args, channel: id } : args
}
