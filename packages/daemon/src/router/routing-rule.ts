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
import type { RouteAssign, RouteUpdate } from '@agentconnect.md/protocol'

export type RoutingMatch = BindMatch

export interface RoutingRule {
  agentId: string
  integrationId: string
  botUserId: string // for `mention` matching ("" when unknown)
  scope: { channel?: string; thread?: string }
  match: RoutingMatch
  allowedUserIds?: string[]
  source: 'config' | 'cp'
  epoch?: number // cp layer only
  // Platform this rule belongs to ('slack' | 'telegram'). Undefined = matches any
  // platform (legacy/tests); rules built from integrations always set it, so a
  // Slack `dm`/`auto` rule can't route a Telegram message and vice-versa.
  platform?: string
}

/** Extract the platform-agnostic routing bits from a (discriminated) Integration.
 *  Exported for the daemon's conversation-gating ingress checks (§14). */
export function integrationRouting(int: Integration): {
  staticBotUserId?: string
  bindRules: BindRuleConfig[]
  allowedUserIds: string[]
  gated: boolean
} {
  if (int.platform === 'slack')
    return {
      staticBotUserId: int.slack.botUserId,
      bindRules: int.slack.bindRules,
      allowedUserIds: int.slack.allowedUserIds,
      gated: int.slack.gated
    }
  if (int.platform === 'discord')
    return {
      staticBotUserId: int.discord.botUserId,
      bindRules: int.discord.bindRules,
      allowedUserIds: int.discord.allowedUserIds,
      gated: int.discord.gated
    }
  if (int.platform === 'feishu')
    return {
      staticBotUserId: int.feishu.botOpenId,
      bindRules: int.feishu.bindRules,
      allowedUserIds: int.feishu.allowedUserIds,
      gated: int.feishu.gated
    }
  return {
    staticBotUserId: int.telegram.botUserId,
    bindRules: int.telegram.bindRules,
    allowedUserIds: int.telegram.allowedUserIds,
    gated: int.telegram.gated
  }
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
): { integrationId: string; botUserId: string; platform: string } | null {
  // Prefer an integration on the requested platform — an agent may bridge several (e.g.
  // Slack + Telegram). Delivering a reply/wake into a session on platform X must use X's
  // integration; otherwise the turn's output posts through the wrong platform's client
  // (e.g. a Telegram chat id sent via the Slack client → channel_not_found). Fall back to
  // the first integration only when the platform is unspecified or unmatched.
  const int =
    (platform ? agent?.integrations.find((i) => i.platform === platform) : undefined) ?? agent?.integrations[0]
  if (!int) return null
  const { staticBotUserId } = integrationRouting(int)
  return { integrationId: int.id, botUserId: botUserIds[int.id] ?? staticBotUserId ?? '', platform: int.platform }
}

/** Local layer: one resolved RoutingRule per bindRule of EACH integration (any
 *  platform), tagged with its platform so cross-platform messages can't collide. */
export function rulesFromAgent(agent: Agent, botUserIds: Record<string, string>): RoutingRule[] {
  const out: RoutingRule[] = []
  for (const int of agent.integrations) {
    const { staticBotUserId, bindRules, allowedUserIds } = integrationRouting(int)
    const botUserId = botUserIds[int.id] ?? staticBotUserId ?? ''
    for (const br of bindRules) {
      out.push({
        agentId: agent.id,
        integrationId: int.id,
        botUserId,
        scope: { ...(br.channel ? { channel: br.channel } : {}), ...(br.thread ? { thread: br.thread } : {}) },
        match: br.match,
        allowedUserIds,
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
  resolve: (agentId: string) => { integrationId: string; botUserId: string; platform: string } | null
): RoutingRule | null {
  const r = resolve(cp.agentId)
  if (!r) return null
  return {
    agentId: cp.agentId,
    integrationId: r.integrationId,
    botUserId: r.botUserId,
    scope: cp.scope,
    match: cp.match,
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
