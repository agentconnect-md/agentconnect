import type { MessageGateway, SessionContext } from './context.js'

/** The deps every gateway-backed tool needs: resolve the live connection for one integration. */
export interface GatewayDeps {
  /** Resolve the live platform connection that owns this integration (may rotate). */
  gatewayFor: (integrationId: string) => MessageGateway | undefined
}

/** Returned by the history-backed tools when the agent has multiple bots on the target
 *  platform: the local store pools history by agent+platform, so ids can't be attributed
 *  to one bot, and a chat reached via one bot is not reachable by another. */
export const MULTI_INTEGRATION_NOTE =
  'This agent has multiple integrations on this platform; observed history is not tracked per bot, ' +
  'so it is suppressed to avoid returning ids that belong to another bot. Pass a specific `integrationId` to ' +
  'listChannels/listChannelMembers/getUserProfile to query a known target on a chosen bot.'

/** The agent's own integrations from the trusted session snapshot (never tool input),
 *  falling back to the session's single integration in minimal contexts. */
export function knownIntegrations(ctx: SessionContext): { id: string; platform: string }[] {
  return ctx.integrations && ctx.integrations.length > 0
    ? ctx.integrations
    : ctx.integrationId
      ? [{ id: ctx.integrationId, platform: ctx.platform }]
      : []
}

/** The agent's own integrations on one platform (0, 1, or many). >1 means a read
 *  tool can't attribute agent+platform-scoped history to a specific bot. */
export function integrationsOnPlatform(ctx: SessionContext, platform: string): { id: string; platform: string }[] {
  return knownIntegrations(ctx).filter((i) => i.platform === platform)
}

/**
 * Resolve the live gateway for one of the agent's OWN platforms, used by every
 * platform-neutral tool (send + reads). The candidate set is the trusted session
 * snapshot (never tool input); the caller can only reach its own integrations.
 * `wantIntegrationId` picks a specific bot; otherwise it prefers the current
 * session's integration on that platform (so a same-conversation call stays put)
 * and falls back to the first candidate for a genuine cross-platform target.
 * `sameConvo` reports whether the resolved target is this session's own integration.
 */
export function resolveGatewayForPlatform(
  ctx: SessionContext,
  deps: GatewayDeps,
  platform: string,
  wantIntegrationId?: string
): { gw: MessageGateway; integrationId: string; sameConvo: boolean } {
  const candidates = knownIntegrations(ctx).filter((i) => i.platform === platform)
  if (candidates.length === 0) throw new Error(`this agent has no ${platform} integration`)
  const target = wantIntegrationId
    ? candidates.find((i) => i.id === wantIntegrationId)
    : (candidates.find((i) => i.id === ctx.integrationId) ?? candidates[0])
  if (!target) throw new Error(`this agent has no ${platform} integration with id ${wantIntegrationId}`)
  const gw = deps.gatewayFor(target.id)
  if (!gw) throw new Error(`no live ${platform} connection for integration ${target.id}`)
  return { gw, integrationId: target.id, sameConvo: target.id === ctx.integrationId }
}
