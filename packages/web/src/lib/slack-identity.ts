// Presentation of the CP's server-side Slack identity read (GET /me/slack-identity).
// Kept out of the component so the label precedence is pinned by tests — the live
// path needs a configured Logto tenant, so this is the only place it can be.
import type { MySlackIdentityDto } from '@/lib/api'

/**
 * The workspace line for an account's Slack row. Prefers the human label Slack
 * sent, falls back to the workspace domain, and always keeps the `T…` id
 * visible: it is what someone matching this account against a Slack workspace
 * actually needs, and it is the only field Slack always sends.
 *
 * Undefined when there is nothing to say — not linked, or the read failed /
 * this deployment cannot do it. Callers render nothing in that case; the line
 * is an addition to the sign-in row, never a prerequisite for it.
 */
export function slackWorkspaceLine(slack: MySlackIdentityDto | undefined): string | undefined {
  if (!slack?.linked) return undefined
  const label = slack.teamName ?? (slack.teamDomain ? `${slack.teamDomain}.slack.com` : undefined)
  return label ? `${label} · ${slack.teamId}` : slack.teamId
}
