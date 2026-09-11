import { platformLabel } from '../../platforms/read-ports.js'
import { askHost, type AskDeps } from '../ask.js'
import type { MessageGateway, SessionContext } from './context.js'

/** The deps every gateway-backed tool needs: resolve the live connection for one integration, plus the optional ask port {@link resolveGatewayForPlatform} uses instead of guessing which bot. */
export interface GatewayDeps extends AskDeps {
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

/** The ask key of "which of the agent's bots on this platform?" — ONE question per platform per tool call, SHARED by {@link resolveGatewayForPlatform} and the history-backed reads, so a tool that resolves a gateway and then falls back to observed history asks the human once rather than twice (the bridge allows two rounds per call, so a second question would fail outright). */
function integrationAskKey(platform: string): string {
  return `integrationId.${platform}`
}

/** #1965 Gap A: ask the agent's own host which of several same-platform bots to act as, over the trusted enum from the session snapshot (never tool input). `purpose` is the verb phrase the card names — the key is shared, but the message is read only on the round that mints it, so each caller says what it is for. Undefined ⇒ the host cannot render an ask, a human declined or cancelled, or the answer named an id we never offered — each leaves the caller's own fallback standing. Throws {@link AskRequired} when the question has not been put yet, so the caller must be positioned BEFORE any observable work: the answer arrives on a fresh tool call that re-runs the handler from the top. */
export function askWhichIntegration(
  deps: AskDeps,
  platform: string,
  ids: string[],
  purpose = 'this call act as'
): string | undefined {
  const label = platformLabel(platform)
  const asked = askHost(deps.ask, integrationAskKey(platform), {
    message: `None of this agent's ${label} bots owns this conversation. Which one should ${purpose}?`,
    fields: {
      integrationId: {
        kind: 'choice',
        title: `${label} integration`,
        description:
          'The bot this call acts as; a chat reached via one bot is not reachable by another, and neither is its observed history.',
        options: ids.map((id) => ({ value: id }))
      }
    },
    required: ['integrationId']
  })
  if (asked.state !== 'answered') return undefined
  const chosen = asked.content.integrationId
  // The answer comes from the host, so it is untrusted input: only an OFFERED id is accepted.
  return typeof chosen === 'string' && ids.includes(chosen) ? chosen : undefined
}

/** How {@link resolveGatewayForPlatform} may ask. OPT-IN: only `ask: true` puts a card in front of a human, so a call site that says nothing keeps the first-candidate pick by construction rather than by remembering a gate. `purpose` is the verb phrase the card names. */
export interface GatewayAskOpts {
  ask?: boolean
  purpose?: string
}

/** Opt in ONLY when a `channel` was named, for a call whose channel otherwise defaults in from this session's own bot: with no channel named, NO answer can repair it — the ask fires exactly when no candidate owns this conversation, which is exactly when `channel` becomes required — so asking would spend a human interruption, and one of the two rounds the bridge allows, to reach the same repairable error. */
export function askOnlyWithChannel(channel: string | undefined, purpose: string): GatewayAskOpts {
  return { ask: channel !== undefined, purpose }
}

/** Resolve the live gateway for one of the agent's OWN platforms, for every platform-neutral tool (send + reads); the candidate set is the trusted session snapshot, never tool input. */
// `wantIntegrationId` picks a specific bot, else this session's integration on that platform keeps a same-conversation call put.
// No tiebreak means `candidates[0]`, silently — so a call site that has a human worth asking opts in with `ask: true` (#1965 Gap A), and keeps that pick only when the ask cannot be made or is refused. `sameConvo` reports whether the target is this session's own integration.
export function resolveGatewayForPlatform(
  ctx: SessionContext,
  deps: GatewayDeps,
  platform: string,
  wantIntegrationId?: string,
  opts?: GatewayAskOpts
): { gw: MessageGateway; integrationId: string; sameConvo: boolean } {
  const candidates = knownIntegrations(ctx).filter((i) => i.platform === platform)
  if (candidates.length === 0) throw new Error(`this agent has no ${platform} integration`)
  // The ask sits here, not at the ~16 call sites: `AskRequired` is a typed sentinel `McpControlServer` already catches centrally, so a synchronous helper stays synchronous.
  const ambiguous = wantIntegrationId === undefined && opts?.ask === true ? ambiguousIntegrations(ctx, platform) : []
  // Never offer a bot that cannot act: a down connection fails the answering round with `no live connection`. Fewer than two live ⇒ no question worth a human, and today's pick (and its error) stands.
  const askable = ambiguous.filter((i) => deps.gatewayFor(i.id) !== undefined).map((i) => i.id)
  const want =
    wantIntegrationId ?? (askable.length > 1 ? askWhichIntegration(deps, platform, askable, opts?.purpose) : undefined)
  const target = want
    ? candidates.find((i) => i.id === want)
    : (candidates.find((i) => i.id === ctx.integrationId) ?? candidates[0])
  if (!target) throw new Error(`this agent has no ${platform} integration with id ${want}`)
  const gw = deps.gatewayFor(target.id)
  if (!gw) throw new Error(`no live ${platform} connection for integration ${target.id}`)
  return { gw, integrationId: target.id, sameConvo: target.id === ctx.integrationId }
}
