import { z } from 'zod'

/**
 * Approval-DM routing control frames (slack-approval-dm.md §4.2), gated by
 * `approval-dm-route-v1`.
 *
 * One request/reply pair serves two questions. The ROUTE form ("whom should I
 * DM about this pending approval") is best-effort: no target means the daemon
 * keeps today's behavior. The VERIFY form (`verify` set — "does this Slack
 * pair, right now, map to the console user I addressed, and can that user
 * still edit this agent") authorizes an action and therefore fails closed:
 * `allowed: false` or an unanswerable exchange both refuse the click.
 *
 * Approval content never rides these frames — only ids, a Slack member id,
 * and a display name. Nothing here is `.strict()`, so an additive field
 * degrades per-value instead of making a frame undecodable.
 */

/** The chosen recipient: a Slack `(teamId, userId)` pair — never `userId`
 *  alone, per slack-identity.md — plus the console user it was verified
 *  against and the integration whose workspace anchored the match. */
export const ApprovalRouteTarget = z.object({
  integrationId: z.string().uuid(),
  teamId: z.string().min(1),
  userId: z.string().min(1),
  consoleUserId: z.string().min(1),
  displayName: z.string().min(1).optional()
})
export type ApprovalRouteTarget = z.infer<typeof ApprovalRouteTarget>

/** `agent/approval-route` (D→C REQ). */
export const AgentApprovalRoute = z.object({
  agentId: z.string().uuid(),
  requestId: z.string().uuid(),
  // The owning session, by its outward id — carries `ownerIdentity` for rung 2.
  sessionId: z.string().min(1).optional(),
  // Turn owner's Slack member id when the triggering turn came from Slack (rung 1).
  requesterId: z.string().min(1).optional(),
  // The agent's connected Slack integrations in the order to try, the session's
  // own bot first when the session is on Slack (§3: one workspace at a time).
  integrationIds: z.array(z.string().uuid()).min(1).max(8),
  // Decision-time revalidation (§6.3): the clicking actor's pair and the console
  // user the DM addressed. Present ⇒ the reply carries `allowed`, never `target`.
  verify: z
    .object({
      integrationId: z.string().uuid(),
      teamId: z.string().min(1),
      userId: z.string().min(1),
      consoleUserId: z.string().min(1)
    })
    .optional()
})
export type AgentApprovalRoute = z.infer<typeof AgentApprovalRoute>

/** `agent/approval-routed` (C→D REP). Route form: `target` or nothing ("no
 *  eligible recipient, keep today's behavior"). Verify form: `allowed`, with a
 *  fresh `displayName` for the decision record when allowed. */
export const AgentApprovalRouted = z.object({
  requestId: z.string().uuid(),
  target: ApprovalRouteTarget.optional(),
  allowed: z.boolean().optional(),
  displayName: z.string().min(1).optional()
})
export type AgentApprovalRouted = z.infer<typeof AgentApprovalRouted>
