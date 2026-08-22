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

import type { GitlabProjectBindingDto, GitlabProjectBindingState, GitlabProjectDto } from './api'

export const GITLAB_PROJECT_STATE: Record<GitlabProjectBindingState, { label: string; badge: string }> = {
  provisioning: { label: 'setting up', badge: 'bg-(--status-info-soft) text-(--status-info)' },
  ready: { label: 'ready', badge: 'bg-(--status-online-soft) text-(--status-online)' },
  admin_degraded: { label: 'setup incomplete', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  runtime_degraded: { label: 'bot access degraded', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  cleanup_pending: { label: 'removal incomplete', badge: 'bg-(--status-error-soft) text-(--status-error)' }
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
