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
  GitlabProjectAccountDto,
  GitlabProjectBindingDto,
  GitlabProjectBindingState,
  GitlabProjectDto
} from './api'

export const GITLAB_PROJECT_STATE: Record<GitlabProjectBindingState, { label: string; badge: string }> = {
  provisioning: { label: 'setting up', badge: 'bg-(--status-info-soft) text-(--status-info)' },
  ready: { label: 'ready', badge: 'bg-(--status-online-soft) text-(--status-online)' },
  admin_degraded: { label: 'setup incomplete', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  runtime_degraded: { label: 'bot access degraded', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  cleanup_pending: { label: 'removal incomplete', badge: 'bg-(--status-error-soft) text-(--status-error)' }
}

/** gitlab.com is pinned in v1 — no host override exists to thread through here. */
export function gitlabProfileUrl(username: string): string {
  return `https://gitlab.com/${username}`
}

// The CP records a machine category in `stateReason`; these are the ones a user can act on, in GitLab
// vocabulary. Every rotation_* variant collapses to one line — the tail (rotation_gitlab_<status>) is open-ended.
// A project binding and an agent's own bot account share this vocabulary, so both translate one set.
export const GITLAB_STATE_REASON: Record<string, string> = {
  project_not_accessible: 'GitLab project is no longer accessible',
  personal_namespace_unsupported: 'Projects in a personal namespace are not supported',
  project_namespace_unknown: 'GitLab did not report the group this project belongs to',
  service_account_create_forbidden: 'Not allowed to create a project bot on GitLab',
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
  provisioning_in_progress: 'Setup is already running',
  provisioning_or_cleanup_in_progress: 'Setup or removal is already running'
}

/** User-facing copy for a state reason, or null to show nothing but the state badge — an
 *  unmapped category is an implementation identifier and never belongs on this surface. */
export function gitlabStateReasonText(reason: string | null): string | null {
  if (!reason) return null
  if (reason.startsWith('rotation_')) return 'The project bot credential needs repair'
  // The gitlab_<status> family is open-ended; the actionable part is the same for all of it.
  if (reason.startsWith('gitlab_')) {
    return 'GitLab refused the last administration request — reconnect the account that manages this project, or transfer it to your own'
  }
  return GITLAB_STATE_REASON[reason] ?? null
}

/** The bot an agent acts as on a bound project — the member row the project list already carries,
 *  which is where the console names an agent's GitLab identity (§18.1). */
export function gitlabAgentBot(
  bindings: readonly GitlabProjectBindingDto[],
  project: { projectId?: string | null; projectPath?: string | null },
  agentId: string
): GitlabProjectAccountDto | null {
  // The numeric id survives a project rename; the path is display-only, so it answers for a row carrying no id.
  const path = project.projectPath?.toLowerCase()
  const binding = bindings.find((candidate) =>
    project.projectId
      ? candidate.projectId === project.projectId
      : path !== undefined && candidate.projectPath.toLowerCase() === path
  )
  return binding?.accounts.find((account) => account.agentId === agentId) ?? null
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
