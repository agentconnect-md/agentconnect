/**
 * `linearcred/request` handler — D→C REQ → `linearcred/grant` REP
 * (docs/designs/linear-integration.md §4.4, §7.3).
 *
 * The split the design names: CORE owns the frame family and the scope check — the named
 * integration must be a Linear one of the frame's org, and the requesting daemon must currently
 * serve its agent — while the PROVIDER's token service owns the work (single-flight refresh,
 * durable persist of the rotated pair before it answers). Nothing here re-implements either.
 *
 * DATA-PLANE path, exactly as `gitcred` is (resource-visibility §9 exemption): the reads are the
 * viewer-free point reads plus a placement comparison, never canView / visibilityWhere. A
 * restricted-but-active agent still posts activities into its workspace.
 *
 * Retransmit idempotency comes from the same place gitcred's does — the daemon re-sends one frame
 * id and the CP does not dedupe, so duplicates are absorbed by the token service's single-flight
 * and collapse onto one upstream rotate.
 *
 * A rotation invalidates the token EVERY member's `agent.json` holds, so a rotated grant rides
 * `integrationConverge` — the same re-push a gating flip takes, whose http-bot arm re-broadcasts
 * the workspace bot and re-pushes its specs. Best-effort: a failed push self-heals from the
 * reconcile roster on the daemon's next connect, and must never fail the grant that already landed.
 *
 * The grant payload carries the token MATERIAL — never log it.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { linearConnectionIdentity } from '../../platforms/linear/provider.js'
import { AgentId, IntegrationId } from '../../domain/ids.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleLinearCredRequest: Handler = async (frame, conn, deps) => {
  if (!isFrame('linearcred/request')(frame)) return
  const { integrationId } = frame.payload

  if (!deps.linearTokens || !deps.bot) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'linear workspaces are not enabled on this control plane', false)
    return
  }

  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }

  // Org-fenced, so a foreign-org integration is indistinguishable from a missing one. A non-linear
  // row is refused rather than resolved: the grant would be a credential for another platform.
  const integration = await deps.integration.get(orgId, IntegrationId(integrationId))
  if (!integration || integration.platform !== 'linear') {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'not a linear integration of this organization', false)
    return
  }

  // Service scope (§7.3): the requesting daemon must serve the integration's agent — its placement,
  // or a duty it holds. One that lost it gets a terminal SCOPE_DENIED and stops asking.
  const agent = await deps.agent.get(orgId, AgentId(integration.agentId))
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }

  // The grant belongs to the connection identity, not the bot row (§4.4) — an incomplete D6 pair is
  // an install that never finished, which only an operator reconnect repairs.
  const bot = await deps.bot.get(orgId, integration.botId)
  const identity = bot ? linearConnectionIdentity(bot) : null
  if (!identity) {
    conn.sendError(frame.id, 'LEASE_DENIED', 'this Linear workspace connection is incomplete', false)
    return
  }

  let resolution
  try {
    resolution = await deps.linearTokens.accessToken(identity)
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'linear token resolution failed', true)
    return
  }
  if (!resolution.ok) {
    // `unreachable` is a blip, never proof the grant is dead — retryable, and it leaves the daemon
    // running on the token it still has. The other two need an operator reconnect.
    if (resolution.reason === 'unreachable') {
      conn.sendError(frame.id, 'INTERNAL', 'linear is unreachable', true)
      return
    }
    conn.sendError(frame.id, 'LEASE_DENIED', 'this Linear workspace needs reconnecting', false)
    return
  }

  conn.replyTo(frame, 'linearcred/grant', {
    accessToken: resolution.accessToken,
    expiresAt: resolution.expiresAt.toISOString()
  })

  if (resolution.rotated && deps.integrationConverge) {
    try {
      await deps.integrationConverge(agent)
    } catch (err) {
      deps.log.error({ integrationId, err: (err as Error).message }, 'linearcred: spec re-push failed')
    }
  }
}
