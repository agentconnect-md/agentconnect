// Why a Slack install ended without connecting — the ONE copy of that vocabulary.
//
// Two surfaces report it and used to keep near-identical maps of the same reason
// codes: the create modal's wizard body (`./Body.tsx`) and the getting-started
// card's platform-install poll (`./use-platform-install.ts`). They drifted the
// moment a new outcome was added, which is exactly what happened when the CP
// learned to refuse a SHORT PERMISSION GRANT.
//
// Short grant, in one line: Slack's initial authorization does not reliably apply
// every bot permission an app declares. The app installs cleanly and nothing
// looks wrong until, much later, a scoped call answers `missing_scope` and
// conversations quietly stop being visible. Both CP install funnels now refuse
// that install up front and say WHICH scopes are absent — which is the whole
// point of failing rather than warning, so these messages must carry the list.

import { ApiError } from '@/lib/api'

/** The CP's machine-readable refusal code on the config-token funnel's finalize
 *  (`POST /integrations/slack/app/:id/finalize`) when the workspace
 *  authorization granted fewer bot scopes than the app requires. */
export const SLACK_MISSING_SCOPES_CODE = 'SLACK_MISSING_SCOPES'

/** The same outcome on the platform-app callback, where it reaches the console as
 *  the polled install row's `failureReason` rather than as a request error. */
export const SLACK_MISSING_SCOPES_REASON = 'missing_scopes'

/**
 * The withheld scopes behind a finalize failure, or null when the failure was
 * something else. Returns a (possibly empty) list only for the CP's short-grant
 * refusal, so callers can branch on "is this the scope failure" without
 * inspecting messages.
 */
export function slackMissingScopesFromError(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== SLACK_MISSING_SCOPES_CODE) return null
  const missing = err.details?.missingScopes
  return Array.isArray(missing) ? missing.filter((scope): scope is string => typeof scope === 'string') : []
}

/** The remedy, in one sentence, for surfaces that can only show a string. The
 *  wizard renders the same facts structurally instead (see `./Body.tsx`). */
export function slackMissingScopesMessage(missingScopes: readonly string[]): string {
  const remedy =
    'Slack didn’t grant every permission AgentConnect needs. Reinstall the app in your Slack workspace to grant them, then try again.'
  return missingScopes.length > 0 ? `${remedy} Missing: ${missingScopes.join(', ')}` : remedy
}

/** Keyed by the CP's short reason code — the same note its OAuth close page shows. */
const PLATFORM_INSTALL_FAILURES: Record<string, string> = {
  denied: 'The install was cancelled in Slack.',
  expired: 'This install link expired — start again.',
  workspace_taken: 'That Slack workspace is already connected to another organization.',
  workspace_mismatch: 'Slack authorized a different workspace. Start again and choose the expected workspace.',
  agent_taken: 'That Slack workspace is already connected to another agent here. Remove that integration first.',
  error: 'Slack could not complete the install. Please try again.'
}

/**
 * Render a platform-app install row's terminal failure. `missingScopes` is the
 * list the CP persisted alongside a `missing_scopes` reason; every other outcome
 * ignores it.
 */
export function slackPlatformInstallFailure(
  failureReason: string | null | undefined,
  missingScopes: readonly string[] = []
): string {
  if (failureReason === SLACK_MISSING_SCOPES_REASON) return slackMissingScopesMessage(missingScopes)
  return PLATFORM_INSTALL_FAILURES[failureReason ?? ''] ?? 'The Slack install did not complete.'
}

/** The 'expired' copy, for the callers that reach it without a row (a TTL-reaped
 *  install polls as a 404, not as a settled failure). */
export const SLACK_INSTALL_EXPIRED = PLATFORM_INSTALL_FAILURES.expired!
