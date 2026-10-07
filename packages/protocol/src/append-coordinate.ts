/**
 * The `append` session coordinate's reserved prefix (channel-session-mode.md §3.2), shared
 * so the Control Plane can recognize an `append` session from the `thread` it records. The
 * daemon mints and parses coordinates in `packages/daemon/src/session/append-coordinate.ts`.
 */
export const APPEND_COORDINATE_PREFIX = 'append:'

/** Whether a session's thread segment is an append coordinate rather than a platform thread. */
export function isAppendCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(APPEND_COORDINATE_PREFIX)
}
