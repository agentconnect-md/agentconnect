/** The assistant-mode sub-session coordinate's reserved prefix (assistant-mode.md §5.6), shared so the Control Plane recognizes one from its `thread`. */
export const SUBSESSION_COORDINATE_PREFIX = 'subsession:'

/** Whether a session's thread segment is a sub-session coordinate rather than a platform thread. */
export function isSubsessionCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(SUBSESSION_COORDINATE_PREFIX)
}
