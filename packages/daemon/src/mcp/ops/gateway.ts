import type { MessageGateway, SessionContext } from './context.js'

/** The deps every gateway-backed tool needs: resolve the live connection for one integration. */
export interface GatewayDeps {
  /** Resolve the live platform connection that owns this integration (may rotate). */
  gatewayFor: (integrationId: string) => MessageGateway | undefined
}

/** Returned by the history-backed reads when the agent has several bots on the target platform, NONE of them this session's, and the host could not be asked which one to read: observed history belongs to one bot at a time, and a chat reached via one bot is not reachable by another. */
export const MULTI_INTEGRATION_NOTE =
  'This agent has multiple integrations on this platform and none of them owns this conversation, so the bot whose ' +
  'observed history to read could not be determined; it is suppressed rather than returning ids another bot cannot ' +
  'reach. Pass a specific `integrationId` to listChannels/listChannelMembers/getUserProfile to scope the read to one bot.'

/** The agent's own integrations from the trusted session snapshot (never tool input),
 *  falling back to the session's single integration in minimal contexts. */
export function knownIntegrations(ctx: SessionContext): { id: string; platform: string }[] {
  return ctx.integrations && ctx.integrations.length > 0
    ? ctx.integrations
    : ctx.integrationId
      ? [{ id: ctx.integrationId, platform: ctx.platform }]
      : []
}

/** The agent's own integrations on one platform (0, 1, or many). */
export function integrationsOnPlatform(ctx: SessionContext, platform: string): { id: string; platform: string }[] {
  return knownIntegrations(ctx).filter((i) => i.platform === platform)
}

/** The integrations {@link resolveGatewayForPlatform} would silently pick the FIRST of: two or more of the agent's own bots on the target platform, none of them this session's. Empty when nothing is guessed — at most one candidate, or the session's own integration qualifies. THE shared guard for "which bot?": this session's own bot is the trusted tiebreak, and it is the bot an unqualified `sendMessage` resolves to, so the ids a history-backed read returns stay reachable. */
export function ambiguousIntegrations(ctx: SessionContext, platform: string): { id: string; platform: string }[] {
  const candidates = integrationsOnPlatform(ctx, platform)
  if (candidates.length < 2) return []
  return candidates.some((i) => i.id === ctx.integrationId) ? [] : candidates
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
