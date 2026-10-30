/** The background work coordinate's reserved prefix (assistant-mode.md §5.6), shared so the Control Plane recognizes one from its `thread`. */
export const SUBSESSION_COORDINATE_PREFIX = 'subsession:'

/** A follow-up's checks (assistant-mode.md §5.12); a getting-to-know task's segment extends it. */
export const CHECK_COORDINATE_PREFIX = `${SUBSESSION_COORDINATE_PREFIX}check-`

/** An approved proposal's run (assistant-mode.md §5.10). */
export const APPROVED_TASK_COORDINATE_PREFIX = `${SUBSESSION_COORDINATE_PREFIX}task-`

/** Organization research (assistant-mode.md §5.15). */
export const RESEARCH_COORDINATE_PREFIX = `${SUBSESSION_COORDINATE_PREFIX}research-`

/** Whether a session's thread segment is a background work coordinate rather than a platform thread. */
export function isSubsessionCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(SUBSESSION_COORDINATE_PREFIX)
}

/** Whether a background coordinate is a task `delegateTask` opened (auto-session-mode.md §6.2): not a follow-up's check, an approved proposal or research. */
export function isDelegatedTaskCoordinate(thread: string | null | undefined): boolean {
  return (
    isSubsessionCoordinate(thread) &&
    !thread!.startsWith(CHECK_COORDINATE_PREFIX) &&
    !thread!.startsWith(APPROVED_TASK_COORDINATE_PREFIX) &&
    !thread!.startsWith(RESEARCH_COORDINATE_PREFIX)
  )
}
