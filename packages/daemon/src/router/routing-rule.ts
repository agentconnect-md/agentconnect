/**
 * The unified routing-rule model. Two layers produce `RoutingRule`s — the local
 * layer (from agent.json bindRules) and the CP layer (from route/*). The router
 * (`routeRules`) consumes the merged, resolved set.
 *
 * A `CpRule` is the stored CP-layer shape (no integration yet); `resolveCpRule`
 * resolves it to a `RoutingRule` at merge time (so a hot-added agent makes a
 * previously-unservable rule servable). `agent.id` IS the CP `agentId`.
 */
import type { Agent, BindMatch, BindRuleConfig, Integration } from '../agents/agent-schema.js'
import { configuredBotSelfId, integrationCore } from '../platforms/integration-config.js'
import type { ActivationRule } from '@agentconnect.md/activation-policy'
import type { RouteAssign, RouteUpdate } from '@agentconnect.md/protocol'

export type RoutingMatch = BindMatch

/**
 * The daemon's resolved routing rule — the policy package's `ActivationRule`
 * (field docs live there) with the daemon's own `BindMatch` as the match
 * vocabulary. `extends` is the compile-time guarantee that what this module
 * BUILDS stays consumable by the pure ladder without adaptation; if either
 * shape drifts, this declaration breaks instead of the routing behavior.
 */
export interface RoutingRule extends ActivationRule {
  match: RoutingMatch
}

/**
 * The routing bits of an Integration, with no knowledge of which platform it is.
 * Exported for the daemon's conversation-gating ingress checks (§14).
 *
 * This used to be a four-arm switch on `int.platform` that only ever reached
 * identically-named fields. §6.4 says those knobs are the CORE ENVELOPE, so this
 * is an envelope read (`platforms/integration-config.ts`) plus the one genuinely
 * per-platform value — the bot's own id, which each platform names in its own
 * vocabulary. Same values as before, and a new platform is now routable without
 * editing the router.
 */
export function integrationRouting(int: Integration): {
  staticBotUserId?: string
  bindRules: BindRuleConfig[]
  mutedChannels: string[]
  gated: boolean
} {
  const { bindRules, mutedChannels, gated } = integrationCore(int)
  return { staticBotUserId: configuredBotSelfId(int), bindRules, mutedChannels, gated }
}

/**
 * Is this conversation open to `int` at all? Two independent fences, both applying
 * to the channel coordinate (the enclosing configurable channel on every platform):
 *
 *  - Off — the operator muted this channel. Applies to every integration.
 *  - Gating (resource-visibility.md §14) — a restricted agent's integration admits
 *    ONLY conversations that carry a scoped rule, so an unknown one is refused too.
 *
 * The routing ladder enforces both through the rule set itself; this is for the
 * paths that resolve a target OUTSIDE it (control commands, message shortcuts, the
 * relay's pre-addressed hand-off), which would otherwise reach a silenced channel.
 */
export function conversationAdmitted(
  routing: Pick<ReturnType<typeof integrationRouting>, 'bindRules' | 'mutedChannels' | 'gated'>,
  channel: string
): boolean {
  const covers = (candidate: string | undefined): boolean => candidate === channel
  if (routing.mutedChannels.some((muted) => covers(muted))) return false
  return !routing.gated || routing.bindRules.some((rule) => covers(rule.channel))
}

/** Stored CP-layer rule — integration resolved lazily at merge time. */
export interface CpRule {
  agentId: string
  scope: { channel?: string; thread?: string }
  match: RoutingMatch
  epoch?: number
}

/**
 * Resolve an agent to an integration's `{ integrationId, botUserId, platform }`. When
 * `platform` is given, prefer the integration on that platform (a multi-platform agent may
 * bridge Slack + Telegram); otherwise — or if none matches — use the first integration.
 * Pure: `botUserIds` (integrationId → resolved bot user id / Telegram @username) overrides
 * the static config id. Returns null when there is no agent or no integration (unservable).
 */
export function resolveAgentIntegration(
  agent: Agent | undefined,
  botUserIds: Record<string, string>,
  platform?: string
): { integrationId: string; botUserId: string; platform: string; mutedChannels: string[] } | null {
  // Prefer an integration on the requested platform — an agent may bridge several (e.g.
  // Slack + Telegram). Delivering a reply/wake into a session on platform X must use X's
  // integration; otherwise the turn's output posts through the wrong platform's client
  // (e.g. a Telegram chat id sent via the Slack client → channel_not_found). Fall back to
  // the first integration only when the platform is unspecified or unmatched.
  //
  // This comparison STAYS platform-keyed on purpose (audit Appendix A,
  // router/routing-rule.ts:124, classified "routing"): it is a platform-vs-platform
  // equality with no literal in it, so it is already correct for every platform an
  // open `PlatformId` can name and there is nothing here to extract.
  const int =
    (platform ? agent?.integrations.find((i) => i.platform === platform) : undefined) ?? agent?.integrations[0]
  if (!int) return null
  const { staticBotUserId, mutedChannels } = integrationRouting(int)
  return {
    integrationId: int.id,
    botUserId: botUserIds[int.id] ?? staticBotUserId ?? '',
    platform: int.platform,
    mutedChannels
  }
}

/** Local layer: one resolved RoutingRule per bindRule of EACH integration (any
 *  platform), tagged with its platform so cross-platform messages can't collide. */
export function rulesFromAgent(agent: Agent, botUserIds: Record<string, string>): RoutingRule[] {
  const out: RoutingRule[] = []
  for (const int of agent.integrations) {
    const { staticBotUserId, bindRules, mutedChannels } = integrationRouting(int)
    const botUserId = botUserIds[int.id] ?? staticBotUserId ?? ''
    for (const br of bindRules) {
      out.push({
        agentId: agent.id,
        integrationId: int.id,
        botUserId,
        scope: { ...(br.channel ? { channel: br.channel } : {}), ...(br.thread ? { thread: br.thread } : {}) },
        match: br.match,
        mutedChannels,
        source: 'config',
        platform: int.platform
      })
    }
  }
  return out
}

/** Resolve a stored CP rule to a RoutingRule; null if the agent is unservable. */
export function resolveCpRule(
  cp: CpRule,
  resolve: (
    agentId: string
  ) => { integrationId: string; botUserId: string; platform: string; mutedChannels?: string[] } | null
): RoutingRule | null {
  const r = resolve(cp.agentId)
  if (!r) return null
  return {
    agentId: cp.agentId,
    integrationId: r.integrationId,
    botUserId: r.botUserId,
    scope: cp.scope,
    match: cp.match,
    // A CP session placement is scoped to a conversation the operator may since have
    // switched off; it carries its integration's fence for the same reason a local rule does.
    ...(r.mutedChannels ? { mutedChannels: r.mutedChannels } : {}),
    source: 'cp',
    platform: r.platform,
    ...(cp.epoch !== undefined ? { epoch: cp.epoch } : {})
  }
}

/** Canonical sessionKey string — matches the protocol's `${platform}:${channel}:${thread ?? "-"}`. */
export function sessionKeyStr(sk: { platform: string; channel: string; thread?: string }): string {
  return `${sk.platform}:${sk.channel}:${sk.thread ?? '-'}`
}

/** route/assign → stored CP rules scoped to its sessionKey (integration resolved later). */
export function cpRulesFromAssign(a: RouteAssign, epoch?: number): CpRule[] {
  return a.bindRules.map((br) => ({
    agentId: a.agentId,
    scope: { channel: a.sessionKey.channel, ...(a.sessionKey.thread ? { thread: a.sessionKey.thread } : {}) },
    match: br.match,
    ...(epoch !== undefined ? { epoch } : {})
  }))
}

/** route/update → global (unscoped) CP rules. Malformed match entries are skipped. */
export function cpRulesFromUpdate(u: RouteUpdate): CpRule[] {
  const out: CpRule[] = []
  for (const r of u.rules) {
    const m = r.match as { kind?: string; value?: unknown }
    if (m?.kind === 'mention' || m?.kind === 'dm' || m?.kind === 'auto') {
      out.push({ agentId: r.agentId, scope: {}, match: { kind: m.kind } as RoutingMatch, epoch: u.routingEpoch })
    } else if (m?.kind === 'keyword' && typeof m.value === 'string') {
      out.push({ agentId: r.agentId, scope: {}, match: { kind: 'keyword', value: m.value }, epoch: u.routingEpoch })
    }
  }
  return out
}
