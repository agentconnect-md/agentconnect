/**
 * The viewer's identity set for session visibility (session-visibility.md §2).
 *
 * `identitySetOf` gives every caller their console identity (`user:<userId>`);
 * this resolver is the BFF-side expansion the design reserves for identity
 * linking (§7): it adds the caller's verified Slack identity as the same
 * three-part tuple ingest persists into `ownerIdentity`
 * (`slack:<teamId>:<userId>`), so a private Slack DM session lights up for the
 * console user behind it — retroactively, with no session backfill.
 *
 * The identity is trusted because the provider verified it: it exists in Logto
 * only after a Slack OIDC sign-in, or an Account API link driven by the user's
 * own authenticated session. It is read (never persisted) per §2's Slack
 * keying rule — the workspace + user PAIR, matching the daemon-reported
 * `transportScope` (the Slack team id); see docs/designs/slack-identity.md.
 *
 * Boundaries, all fail-closed:
 *  - Only a REAL OIDC session carries `req.oidcSubject` — devAuth and personal
 *    API keys never reach the provider, so their set stays console-only.
 *  - A Logto miss or error NARROWS the set to the console identity (the caller
 *    momentarily sees fewer sessions, never someone else's) and is logged.
 */
import type { FastifyRequest } from 'fastify'
import { identitySetOf } from '../authorization/policy.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import { ctxOf } from './rbac.js'

/** The one provider read this needs — injectable so tests stay offline. */
export type SlackIdentityReader = Pick<LogtoIdentityService, 'slackIdentityFor'>

export type ViewerIdentitySetResolver = (req: FastifyRequest) => Promise<Set<string>>

/** Build the per-request identity-set resolver the session routes share.
 *  `logtoIdentity` absent (LOGTO_MGMT_* unset) ⇒ console identity only. */
export function makeViewerIdentitySet(logtoIdentity?: SlackIdentityReader): ViewerIdentitySetResolver {
  return async (req) => {
    const identitySet = identitySetOf(ctxOf(req))
    const sub = req.oidcSubject
    if (!sub || !logtoIdentity) return identitySet
    try {
      const slack = await logtoIdentity.slackIdentityFor(sub)
      if (slack) identitySet.add(`slack:${slack.teamId}:${slack.userId}`)
    } catch (err) {
      req.log.warn({ err }, 'viewer identity: slack lookup failed — matching on the console identity only')
    }
    return identitySet
  }
}
