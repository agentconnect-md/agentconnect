/**
 * The Collaboration Arena's evaluation environment — the ONE authoritative
 * effective-integration registry (docs/designs/collaboration-arena.md §5) plus
 * the delivery-lifecycle contracts of §7.1 and the ingress payloads of §4.
 *
 * Composition rule (§5): each {@link EffectiveIntegration} is materialized as
 * BOTH an entry in the agent's `integrations` (so MCP session construction,
 * tool gating, and `sendMessage` platform advertising see it) AND a virtual
 * connection in the daemon's per-integration connection maps (so reply
 * resolution, transport scope, and tenant classification see the same object).
 * One registry, two projections — they cannot diverge because both derive from
 * the same record. Authorization, coordinate-integrity, call-policy, hop-limit,
 * deduplication, and session-key code stay unchanged; the benchmark compiles
 * its topology into production collaboration policy and never branches on
 * `if (evaluation)` inside policy code.
 */
import type { ChannelAgentsOk, CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import { IntegrationSchema, type BindRuleConfig, type Integration } from '../agents/agent-schema.js'
import type { ChannelAgentsRequest } from '../mcp/ops.js'
import type { VirtualPlatform, VirtualPlatformConnection } from './virtual-connections.js'

/** One synthetic integration, projected into both `agent.integrations` and the
 *  connection maps at daemon composition. */
export interface EffectiveIntegration {
  integrationId: string
  agentId: string
  platform: VirtualPlatform
  /** Physical-bot identity seed. The daemon derives the session-key transport
   *  scope from the integration's credential exactly as in production; this
   *  value seeds that synthetic credential, so equal seeds consolidate onto one
   *  scope and distinct seeds stay distinct. */
  transportScope: string
  /** Virtual tenant metadata (e.g. Slack workspaceId) for audience/session
   *  classification. */
  tenant?: { workspaceId?: string }
  /** Routing reach of this integration — compiled by the topology compiler from
   *  room membership. The daemon's ordinary bind-rule router consumes these; no
   *  evaluation-specific routing layer exists. */
  bindRules?: readonly BindRuleConfig[]
  connection: VirtualPlatformConnection
}

export interface DaemonEvaluationEnvironment {
  integrations: readonly EffectiveIntegration[]
  /** Peer discovery (`listAgents`) answered from the evaluation peer directory
   *  instead of a live control plane. */
  listAgents(request: ChannelAgentsRequest): Promise<ChannelAgentsOk>
  /** Synthetic collaboration topology, loaded into the daemon's existing
   *  `CpCollabRoutes` — the same table a live CP would replace. */
  collaborationRoutes: CollabRoutesSnapshot
}

// ─── §4 ingress payloads ────────────────────────────────────────────────────

/** Platform-shaped raw-ish event: everything the platform normalizer needs.
 *  `sender.kind: 'agent'` does not exist on this surface — injected events
 *  carry human or bot platform senders exactly as a platform would (§4.1). */
export interface EvaluationPlatformPayload {
  channel: string
  thread?: string
  messageId: string
  text: string
  sender: { id: string; name?: string; isBot?: boolean; appId?: string }
  /** Bot user ids mentioned in the message (the router's mention rung input). */
  mentions?: string[]
  isDm?: boolean
}

export interface EvaluationPlatformEvent {
  integrationId: string
  payload: EvaluationPlatformPayload
}

/** Trusted, pre-addressed game control (§4.2): role assignments, private
 *  prompts, canonical phase updates. Skips trigger routing (the target is
 *  authoritative) but still runs session addressing, the serial gate,
 *  SessionManager, and ACP. */
export interface RefereeEvent {
  targetAgentId: string
  platform: 'slack' | 'telegram' | 'discord' | 'feishu' | 'webchat'
  integrationId?: string
  channel: string
  thread?: string
  messageId: string
  text: string
  isDm: boolean
  /** Platform sender identity of the referee persona (defaults to a stable
   *  synthetic human user). */
  sender?: { id: string; isBot?: boolean }
}

// ─── §7.1 delivery handles ──────────────────────────────────────────────────

export type DeliveryRejectionReason = 'deduplicated' | 'suppressed' | 'unrouted' | 'gated' | 'queue_full' | 'error'

export type DeliveryAdmission =
  | { admitted: true; agentId: string; sessionKey: string; turnId: string }
  | { admitted: false; reason: DeliveryRejectionReason }

export type DeliveryCompletion =
  | { status: 'completed'; sessionId: string; turnId: string }
  | { status: 'failed' | 'cancelled' | 'timeout'; sessionId: string | null; turnId: string; error?: string }
  | { status: 'not_admitted' }

export interface DeliveryHandle {
  /** Settles at the admission decision: routed/admitted, or rejected with the
   *  production reason. */
  admission: Promise<DeliveryAdmission>
  /** Settles when the resulting turn (if any) reaches a terminal state. */
  completion: Promise<DeliveryCompletion>
}

// ─── registry → agent.integrations projection ───────────────────────────────

/**
 * Compile one {@link EffectiveIntegration} into a production-shaped
 * `Integration` record for `agent.integrations`. Synthetic credentials are
 * derived from the `transportScope` seed (never real tokens), so the daemon's
 * production transport-scope hashing yields a deterministic per-seed scope.
 */
export function compileEvaluationIntegration(eff: EffectiveIntegration): Integration {
  const seed = eff.transportScope
  const bindRules = [...(eff.bindRules ?? [])]
  switch (eff.platform) {
    case 'slack': {
      const conn = eff.connection as { botUserId?: string; appId?: string }
      return IntegrationSchema.parse({
        id: eff.integrationId,
        platform: 'slack',
        slack: {
          mode: 'direct',
          botToken: `xoxb-evaluation-${seed}`,
          appToken: `xapp-evaluation-${seed}`,
          ...(conn.appId !== undefined ? { appId: conn.appId } : {}),
          ...(conn.botUserId !== undefined ? { botUserId: conn.botUserId } : {}),
          bindRules
        }
      })
    }
    case 'telegram': {
      const conn = eff.connection as { botUserId?: string; botUsername?: string }
      return IntegrationSchema.parse({
        id: eff.integrationId,
        platform: 'telegram',
        telegram: {
          botToken: `${numericSeed(seed)}:evaluation-${seed}`,
          ...(conn.botUsername !== undefined ? { botUserId: conn.botUsername } : {}),
          bindRules
        }
      })
    }
    case 'discord': {
      const conn = eff.connection as { botUserId?: string }
      return IntegrationSchema.parse({
        id: eff.integrationId,
        platform: 'discord',
        discord: {
          botToken: `evaluation-${seed}`,
          ...(conn.botUserId !== undefined ? { botUserId: conn.botUserId } : {}),
          bindRules
        }
      })
    }
  }
}

/** The routing identity the daemon should bind for this integration — what the
 *  live connect handshake would have resolved (`auth.test` user id / Telegram
 *  @username / Discord numeric id). */
export function evaluationBotRoutingIdentity(eff: EffectiveIntegration): string {
  const conn = eff.connection as { botUserId?: string; botUsername?: string }
  if (eff.platform === 'telegram') return conn.botUsername ?? ''
  return conn.botUserId ?? ''
}

function numericSeed(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return String(100_000_000 + (hash % 900_000_000))
}
