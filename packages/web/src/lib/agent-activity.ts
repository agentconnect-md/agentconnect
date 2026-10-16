// Which of an agent's Activity the console offers (assistant-mode.md §5.11): all of it in assistant mode, else what every agent has where its daemon serves it.

/** The daemon serves Activity's background work, drafts and permission requests outside assistant mode (protocol `ACTIVITY_EVERY_AGENT_V1_FEATURE`). */
export const ACTIVITY_EVERY_AGENT_FEATURE = 'activity-every-agent-v1'

/** The daemon reads one task by its session and ends a follow-up by its id (protocol `ASSISTANT_TASK_HANDLE_FEATURE`). */
export const ASSISTANT_TASK_HANDLE_FEATURE = 'assistant-task-handle-v1'

/** `assistant` has every section, `every-agent` only background work and what waits for approval, null no Activity at all. */
export type ActivityScope = 'assistant' | 'every-agent' | null

export function activityScope(assistantMode: boolean, features: readonly string[] | undefined): ActivityScope {
  if (assistantMode) return 'assistant'
  return features?.includes(ACTIVITY_EVERY_AGENT_FEATURE) ? 'every-agent' : null
}
