// Presentation of the CP's server-side Slack identity read (GET /me/slack-identity).
// Kept out of the component so the label precedence is pinned by tests — the live
// path needs a configured Logto tenant, so this is the only place it can be.
import type { MySlackIdentityDto } from '@/lib/api'

/**
 * The workspace line for an account's Slack row: which Slack workspace this
 * account signs in from, named the way its members would recognize it.
 *
 * The raw `T…` id appears ONLY as a last resort. It was previously shown
 * alongside the name on the grounds that it is the field Slack always sends —
 * but this line is read by people managing their own sign-in methods, and to
 * them an opaque id is noise, not information. Anything that needs to match
 * accounts to workspaces reads the API, which still returns `teamId`.
 *
 * Undefined when there is nothing to say — not linked, or the read failed /
 * this deployment cannot do it. Callers render nothing in that case; the line
 * is an addition to the sign-in row, never a prerequisite for it.
 */
export function slackWorkspaceLine(slack: MySlackIdentityDto | undefined): string | undefined {
  if (!slack?.linked) return undefined
  return slack.teamName ?? (slack.teamDomain ? `${slack.teamDomain}.slack.com` : slack.teamId)
}
