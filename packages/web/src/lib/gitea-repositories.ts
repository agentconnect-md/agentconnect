/**
 * How the console words a Gitea repository at the point where one is picked — a
 * hook subscription, an agent workspace, an additional-repository grant — plus
 * the vocabulary the Integrations card uses for the repositories it manages.
 *
 * The shape is `gitlab-projects.ts` with Gitea's two differences. The picker
 * offers one list of two kinds of row — a repository this organization already
 * added and one the connection's bot administers — and picking either is the
 * whole flow: the write that names an unadded one (the trigger, the workspace,
 * the grant) binds it on the way (§6). And the candidate list is the bot's own
 * `admin` set (§4.4), not a search: a repository the bot only has `write` on is
 * never offered, because binding it could not install the managed webhook.
 *
 * The state vocabulary is the one GitLab uses (gitea-integration.md §12), so a
 * reader who manages both hosts reads one set of badges; the host-specific
 * sentence lives in the reason line under the badge.
 */

import type {
  GiteaRepositoryBindingDto,
  GiteaRepositoryBindingState,
  GiteaRepositoryDto,
  GiteaWebhookState
} from './api'

export const GITEA_REPOSITORY_STATE: Record<GiteaRepositoryBindingState, { label: string; badge: string }> = {
  provisioning: { label: 'setting up', badge: 'bg-(--status-info-soft) text-(--status-info)' },
  ready: { label: 'ready', badge: 'bg-(--status-online-soft) text-(--status-online)' },
  admin_degraded: { label: 'setup incomplete', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  runtime_degraded: { label: 'bot access degraded', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  cleanup_pending: { label: 'removal incomplete', badge: 'bg-(--status-error-soft) text-(--status-error)' }
}

// Only the two webhook states a person can act on are worth saying, exactly as on the GitLab
// card: a webhook that is not needed — no enabled trigger points at the repository — and a
// healthy one are both silence, and badging either turns a resting state into an alarm.
const GITEA_WEBHOOK_ATTENTION: Partial<Record<GiteaWebhookState, { label: string; badge: string }>> = {
  repairing: { label: 'webhook repairing', badge: 'bg-(--status-info-soft) text-(--status-info)' },
  failed: { label: 'webhook failed', badge: 'bg-(--status-error-soft) text-(--status-error)' }
}

/** The webhook badge for a repository row, or null when there is nothing worth saying. */
export function giteaWebhookBadge(state: GiteaWebhookState): { label: string; badge: string } | null {
  return GITEA_WEBHOOK_ATTENTION[state] ?? null
}

/** The default value of the instance axis (gitea-integration.md §3) — what an unset base URL means. */
export const GITEA_DEFAULT_INSTANCE_URL = 'https://gitea.com'

/** The instance this deployment talks to, as a badge reads it: host and any
 *  non-default port, without the scheme or an install path prefix (§3). */
export function giteaInstanceHost(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host
  } catch {
    return instanceUrl
  }
}

/** The bot user's profile page on the configured instance. Composed by CONCATENATION
 *  onto the base (§3): a prefixed install root is part of every path under it. */
export function giteaProfileUrl(instanceUrl: string, username: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}/${username}`
}

/** One bound repository's page on the configured instance — the same concatenation rule. */
export function giteaRepositoryUrl(instanceUrl: string, repoPath: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}/${repoPath}`
}

// The Control Plane records a machine category in `stateReason`; these are the ones a reader can
// act on, in Gitea's words. An unmapped category is an implementation identifier and never
// reaches this surface — the badge stands alone instead.
export const GITEA_STATE_REASON: Record<string, string> = {
  token_rejected: 'Gitea rejected the bot token — replace it on the connection above, then run Repair',
  admin_lost:
    'The bot no longer has Admin on this repository, so its webhook cannot be repaired — grant it Admin again as a collaborator or through a team, then run Repair',
  webhook_unverified:
    'The webhook is installed, but Gitea never delivered the test event. Add this deployment’s relay address to ALLOWED_HOST_LIST under [webhook] in app.ini if it resolves to a private address, then run Repair',
  webhook_events_unsupported:
    'This Gitea version stored fewer event types than the trigger asked for — some events will never arrive. Upgrade the instance, then run Repair',
  repository_not_accessible: 'The repository is no longer reachable through this connection',
  repository_path_unreadable: 'Gitea did not report this repository’s owner and name',
  no_managed_webhook: 'This repository has no managed webhook to rotate — run Repair first',
  signing_key_missing: 'The webhook signing key is missing — run Repair to install a fresh one',
  relay_url_unconfigured: 'This deployment has no public webhook address configured',
  claim_fence_lost: 'Setup was interrupted — run Repair again',
  provisioning_in_progress: 'Setup is already running',
  provisioning_or_cleanup_in_progress: 'Setup or removal is already running',
  cleanup_failed:
    'Removal did not finish, so the webhook may still be on the repository — replace the token or delete the webhook in Gitea, then remove again',
  gitea_unavailable: 'Gitea could not be reached — run Repair once it is back'
}

/** User-facing copy for a state reason, or null to show nothing but the state badge. */
export function giteaStateReasonText(reason: string | null): string | null {
  if (!reason) return null
  return GITEA_STATE_REASON[reason] ?? null
}

/** One pickable repository: `binding` null means the write that picks it binds it (§6). */
export interface GiteaRepositoryChoice {
  repoId: string
  repoPath: string
  defaultBranch: string | null
  /** Private at the provider — the picker's lock glyph, never an authorization fact. */
  private: boolean
  binding: GiteaRepositoryBindingDto | null
}

/** Whether a binding may be attached to an agent workspace, a grant, or a hook. */
export function giteaRepositorySelectable(state: GiteaRepositoryBindingState): boolean {
  return state === 'ready' || state === 'admin_degraded' || state === 'runtime_degraded'
}

/** An unadded repository is always selectable — the save that follows binds it. */
export function giteaChoiceSelectable(choice: GiteaRepositoryChoice): boolean {
  return choice.binding === null || giteaRepositorySelectable(choice.binding.state)
}

/** Added repositories first, then what the bot could still add. A candidate that is
 *  already added stays the binding's row, never a second one. */
export function mergeGiteaRepositoryChoices(
  bindings: readonly GiteaRepositoryBindingDto[],
  candidates: readonly GiteaRepositoryDto[]
): GiteaRepositoryChoice[] {
  const added = new Set(bindings.map((binding) => binding.repoId))
  const candidateById = new Map(candidates.map((candidate) => [candidate.repoId, candidate]))
  return [
    ...bindings.map((binding) => ({
      repoId: binding.repoId,
      repoPath: binding.repoPath,
      defaultBranch: binding.defaultBranch,
      private: candidateById.get(binding.repoId)?.private ?? false,
      binding
    })),
    ...candidates
      .filter((candidate) => !added.has(candidate.repoId))
      .map((candidate) => ({
        repoId: candidate.repoId,
        repoPath: candidate.path,
        defaultBranch: candidate.defaultBranch,
        private: candidate.private,
        binding: null
      }))
  ]
}

/** Filter a choice list by the picker's search box — path substring, case-insensitive. */
export function matchGiteaRepositories(
  choices: readonly GiteaRepositoryChoice[],
  query: string
): GiteaRepositoryChoice[] {
  const wanted = query.trim().toLowerCase()
  return choices.filter((choice) => !wanted || choice.repoPath.toLowerCase().includes(wanted))
}
