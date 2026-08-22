/**
 * How the console words a managed GitLab project binding, shared by the
 * Connections card and the pickers that pick one (a workspace, a hook).
 *
 * The vocabulary names the broken half in GitLab terms, never the internal
 * state id, and the selectability rule is the one product answer: a project is
 * pickable once it exists on GitLab, even when its setup finished only partly.
 * Setup and removal are transient — offering either would attach an agent to a
 * project that is about to change underneath it.
 */

import type { GitlabProjectBindingDto, GitlabProjectBindingState } from './api'

export const GITLAB_PROJECT_STATE: Record<GitlabProjectBindingState, { label: string; badge: string }> = {
  provisioning: { label: 'setting up', badge: 'bg-(--status-info-soft) text-(--status-info)' },
  ready: { label: 'ready', badge: 'bg-(--status-online-soft) text-(--status-online)' },
  admin_degraded: { label: 'setup incomplete', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  runtime_degraded: { label: 'bot access degraded', badge: 'bg-(--status-paused-soft) text-(--amber-500)' },
  cleanup_pending: { label: 'removal incomplete', badge: 'bg-(--status-error-soft) text-(--status-error)' }
}

/** Whether a binding may be attached to an agent workspace or a hook. */
export function gitlabProjectSelectable(state: GitlabProjectBindingState): boolean {
  return state === 'ready' || state === 'admin_degraded' || state === 'runtime_degraded'
}

/** Filter a project list by the picker's search box — path substring, case-insensitive. */
export function matchGitlabProjects(
  projects: readonly GitlabProjectBindingDto[],
  query: string
): GitlabProjectBindingDto[] {
  const wanted = query.trim().toLowerCase()
  return projects.filter((project) => !wanted || project.projectPath.toLowerCase().includes(wanted))
}
