/**
 * How the console words a GitLab project at the point where one is picked — a
 * hook subscription, an agent workspace — plus the shared vocabulary the
 * Integrations card uses for the projects it already manages.
 *
 * A picker offers two kinds of row: a project this organization already added,
 * and a project the connected account could add. They are one `choice` list so
 * the flow reads as "pick a project", never "go set one up elsewhere first".
 * The vocabulary names the broken half in GitLab terms, never the internal
 * state id, and the selectability rule is the one product answer: a project is
 * pickable once it exists on GitLab, even when its setup finished only partly.
 * Setup and removal are transient — offering either would attach an agent to a
 * project that is about to change underneath it.
 */

import type {
  GitlabAgentAccountState,
  GitlabProjectBindingDto,
  GitlabProjectBindingState,
  GitlabProjectDto,
  GitlabWebhookState
} from './api'

export const GITLAB_PROJECT_STATE: Record<GitlabProjectBindingState, { label: string; badge: string }> = {
  provisioning: { label: 'setting up', badge: 'bg-(--status-info-soft) text-(--status-info)' },
  ready: { label: 'ready', badge: 'bg-(--status-online-soft) text-(--status-online)' },
  admin_degraded: { label: 'setup incomplete', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  runtime_degraded: { label: 'bot access degraded', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  cleanup_pending: { label: 'removal incomplete', badge: 'bg-(--status-error-soft) text-(--status-error)' }
}

/** An agent's own bot account carries one state a project binding cannot: §24.3's
 *  withdrawn creation authority, which is not "setup incomplete" — the bot that
 *  exists keeps working, and what is missing is a permission on the instance. */
export const GITLAB_ACCOUNT_STATE: Record<GitlabAgentAccountState, { label: string; badge: string }> = {
  ...GITLAB_PROJECT_STATE,
  service_account_creation_forbidden: {
    label: 'not allowed on GitLab',
    badge: 'bg-(--status-paused-soft) text-(--amber-500)'
  }
}

// Only the two webhook states a person can act on are worth saying. A webhook that is not
// needed — the project has no trigger — and a healthy one are both silence: badging either
// turns a normal resting state into an alarm.
const GITLAB_WEBHOOK_ATTENTION: Partial<Record<GitlabWebhookState, { label: string; badge: string }>> = {
  repairing: { label: 'webhook repairing', badge: 'bg-(--status-info-soft) text-(--status-info)' },
  failed: { label: 'webhook failed', badge: 'bg-(--status-error-soft) text-(--status-error)' }
}

/** The webhook badge for a project row, or null when there is nothing worth saying. */
export function gitlabWebhookBadge(state: GitlabWebhookState): { label: string; badge: string } | null {
  return GITLAB_WEBHOOK_ATTENTION[state] ?? null
}

/** Account convergence runs behind hook and workspace CRUD; this is how often we ask whether it landed. */
export const GITLAB_CONVERGENCE_POLL_MS = 5_000

/** The default value of the host axis (§24.1) — what an unset base URL means. */
export const GITLAB_DEFAULT_INSTANCE_URL = 'https://gitlab.com'

/** The instance this deployment talks to, as a badge reads it: host and any
 *  non-default port, without the scheme or an install path prefix (§24.1). */
export function gitlabInstanceHost(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host
  } catch {
    return instanceUrl
  }
}

/** A bot account's page on the configured instance. Composed by CONCATENATION
 *  onto the base (§24.1): a prefixed install root is part of every path under it. */
export function gitlabProfileUrl(instanceUrl: string, username: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}/${username}`
}

/** §24.3: authority to create service accounts is not API-readable, so the copy
 *  has to name every way an operator can grant it — the tier-gated delegation
 *  setting, the administrator connection, and why Admin Mode defeats the latter. */
const CREATION_AUTHORITY_REMEDY =
  'Connect an instance administrator — whose API token cannot act as one while Admin Mode is enabled — or, on Premium and Ultimate, turn on “Allow top-level group Owners to create service accounts” in Admin → Settings → General → Account and limit. Then run Repair.'

// The CP records a machine category in `stateReason`; these are the ones a user can act on, in GitLab
// vocabulary. Every rotation_* variant collapses to one line — the tail (rotation_gitlab_<status>) is open-ended.
// A project binding and an agent's own bot account share this vocabulary, so both translate one set.
export const GITLAB_STATE_REASON: Record<string, string> = {
  project_not_accessible: 'GitLab project is no longer accessible',
  personal_namespace_unsupported: 'Projects in a personal namespace are not supported',
  project_namespace_unknown: 'GitLab did not report the group this project belongs to',
  service_account_creation_forbidden: `This GitLab instance does not let the connected account create bot accounts. ${CREATION_AUTHORITY_REMEDY}`,
  rotation_service_account_creation_forbidden: `This GitLab instance stopped letting AgentConnect renew this bot's credentials — it keeps working until they expire. ${CREATION_AUTHORITY_REMEDY}`,
  pat_lifetime_exceeds_instance_maximum:
    'This GitLab instance refuses a credential as long-lived as AgentConnect asks for — raise the maximum allowable access token lifetime in Admin → Settings → General → Account and limit, then run Repair',
  service_account_quota:
    'This GitLab group has reached its limit of bot accounts — remove one that is no longer used, then run Repair',
  service_account_create_failed: 'GitLab refused to create the bot account — run Repair to try again',
  no_admin_connection: 'No connected GitLab account can manage this project — transfer it to your own account',
  admin_unavailable:
    'The GitLab account that set this project up can no longer manage it — reconnect that account, or transfer the project to your own',
  cleanup_failed:
    'Removal did not finish because no connected GitLab account could reach the project — reconnect it or transfer the project, then remove again',
  claim_fence_lost: 'Setup was interrupted — run Repair again',
  relay_url_unconfigured: 'This deployment has no public webhook address configured',
  deletion_pending: 'GitLab is still deleting the bot account — this finishes on its own',
  account_retiring: 'The previous bot account for this agent is still being removed — this finishes on its own',
  account_cleanup_incomplete: 'Removal did not finish cleaning up the bot accounts — remove the project again',
  provisioning_in_progress: 'Setup is already running',
  provisioning_or_cleanup_in_progress: 'Setup or removal is already running',
  account_busy: 'Another setup for this bot account is already running — this finishes on its own',
  account_membership_contended: 'Another setup for this bot account is already running — this finishes on its own'
}

/** User-facing copy for a state reason, or null to show nothing but the state badge — an
 *  unmapped category is an implementation identifier and never belongs on this surface. */
export function gitlabStateReasonText(reason: string | null): string | null {
  if (!reason) return null
  // A named category wins over its family: `rotation_service_account_creation_forbidden`
  // is the one reason an operator can act on, and the family line would bury it.
  const named = GITLAB_STATE_REASON[reason]
  if (named) return named
  if (reason.startsWith('rotation_')) return 'The project bot credential needs repair'
  // The gitlab_<status> family is open-ended; the actionable part is the same for all of it.
  if (reason.startsWith('gitlab_')) {
    return 'GitLab refused the last administration request — reconnect the account that manages this project, or transfer it to your own'
  }
  return null
}

/** One pickable project: `binding` null means picking it sets it up first. */
export interface GitlabProjectChoice {
  projectId: string
  projectPath: string
  defaultBranch: string | null
  binding: GitlabProjectBindingDto | null
}

/** Whether a binding may be attached to an agent workspace or a hook. */
export function gitlabProjectSelectable(state: GitlabProjectBindingState): boolean {
  return state === 'ready' || state === 'admin_degraded' || state === 'runtime_degraded'
}

/** An unadded project is always selectable — setup is what picking it does. */
export function gitlabChoiceSelectable(choice: GitlabProjectChoice): boolean {
  return choice.binding === null || gitlabProjectSelectable(choice.binding.state)
}

/** Added projects first, then what the connection could still add. A candidate
 *  that is already added stays the binding's row, never a second one. */
export function mergeGitlabProjectChoices(
  bindings: readonly GitlabProjectBindingDto[],
  candidates: readonly GitlabProjectDto[]
): GitlabProjectChoice[] {
  const added = new Set(bindings.map((binding) => binding.projectId))
  return [
    ...bindings.map((binding) => ({
      projectId: binding.projectId,
      projectPath: binding.projectPath,
      defaultBranch: binding.defaultBranch,
      binding
    })),
    ...candidates
      .filter((candidate) => !added.has(candidate.projectId))
      .map((candidate) => ({
        projectId: candidate.projectId,
        projectPath: candidate.path,
        defaultBranch: candidate.defaultBranch,
        binding: null
      }))
  ]
}

/** Filter a choice list by the picker's search box — path substring, case-insensitive. */
export function matchGitlabProjects(choices: readonly GitlabProjectChoice[], query: string): GitlabProjectChoice[] {
  const wanted = query.trim().toLowerCase()
  return choices.filter((choice) => !wanted || choice.projectPath.toLowerCase().includes(wanted))
}
