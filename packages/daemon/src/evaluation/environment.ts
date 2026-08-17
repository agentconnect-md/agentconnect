/**
 * The Collaboration Arena's evaluation environment (docs/designs/collaboration-arena.md §4/§5/§7.1).
 *
 * Invariant: each {@link EffectiveIntegration} is projected BOTH into the agent's `integrations`
 * and into the daemon's connection maps, from the one record — so the two views cannot diverge.
 * Policy code (authorization, call policy, hop limits, session keys) never branches on
 * `if (evaluation)`; the topology compiles into ordinary production policy instead.
 */
import type { AgentAuthorshipClaim, ChannelAgentsOk, CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import { IntegrationSchema, type BindRuleConfig, type Integration } from '../agents/agent-schema.js'
import type { ChannelAgentsRequest, SessionContext } from '../mcp/ops.js'
import type { ToolDescriptor } from '../mcp/tools.js'
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

/** One game-owned structured action tool (collaboration-arena.md §6). Contract the daemon does
 *  NOT enforce and the game must uphold: the handler authorizes by role itself (the daemon only
 *  guarantees the caller identity in `sessionContext`), and is idempotent per
 *  (runId, phase, agentId, action), reporting `duplicate` rather than double-applying. */
export interface EvaluationToolDefinition {
  descriptor: ToolDescriptor
  /** Which agents see and may call the tool (e.g. only living players). */
  visibleTo(agentId: string): boolean
  handler(call: {
    runId: string
    agentId: string
    sessionContext: SessionContext
    input: Record<string, unknown>
  }): Promise<unknown>
}

export interface DaemonEvaluationEnvironment {
  integrations: readonly EffectiveIntegration[]
  /** Peer discovery (`listAgents`) answered from the evaluation peer directory
   *  instead of a live control plane. */
  listAgents(request: ChannelAgentsRequest): Promise<ChannelAgentsOk>
  /** Synthetic collaboration topology, loaded into the daemon's existing
   *  `CpCollabRoutes` — the same table a live CP would replace. */
  collaborationRoutes: CollabRoutesSnapshot
  /** §6 evaluation tool registry — game-owned structured action tools. */
  tools?: readonly EvaluationToolDefinition[]
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
  /** UNTRUSTED provider authorship claim exactly as a platform normalizer
   *  would surface it (send-message-routing-rework.md §4/§8.1) — the daemon's
   *  ingress promotes it only after full verification. */
  agentAuthorship?: AgentAuthorshipClaim
  /** The arrival tag a real normalizer sets on a response-FINALIZATION event, so a
   *  fixture reproduces the production shape: one Slack message, two arrivals, told
   *  apart here rather than by mangling the msgId (which also carries the platform ts). */
  ingressEventTag?: string
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
  const core = { mode: 'direct', bindRules: [...(eff.bindRules ?? [])] }
  switch (eff.platform) {
    case 'slack': {
      const conn = eff.connection as { botUserId?: string; appId?: string }
      return IntegrationSchema.parse({
        id: eff.integrationId,
        platform: 'slack',
        core,
        config: {
          botToken: `xoxb-evaluation-${seed}`,
          appToken: `xapp-evaluation-${seed}`,
          ...(conn.appId !== undefined ? { appId: conn.appId } : {}),
          ...(conn.botUserId !== undefined ? { botUserId: conn.botUserId } : {})
        }
      })
    }
    case 'telegram': {
      const conn = eff.connection as { botUserId?: string; botUsername?: string }
      return IntegrationSchema.parse({
        id: eff.integrationId,
        platform: 'telegram',
        core,
        config: {
          botToken: `${numericSeed(seed)}:evaluation-${seed}`,
          ...(conn.botUsername !== undefined ? { botUserId: conn.botUsername } : {})
        }
      })
    }
    case 'discord': {
      const conn = eff.connection as { botUserId?: string }
      return IntegrationSchema.parse({
        id: eff.integrationId,
        platform: 'discord',
        core,
        config: {
          botToken: `evaluation-${seed}`,
          ...(conn.botUserId !== undefined ? { botUserId: conn.botUserId } : {})
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
