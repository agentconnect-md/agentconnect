/**
 * The `append` session coordinate (channel-session-mode.md §3.2).
 *
 * A reserved shape, not a platform value: it occupies the `thread` segment of a session
 * key for a conversation whose mode is `append`, where the session deliberately belongs to
 * no single platform thread. It cannot collide with a real coordinate — a platform thread
 * id is a provider timestamp, a snowflake, or a numeric message id, never `append:`-prefixed
 * — and it follows the precedent of Telegram's continuous-DM literal `dm` in `thread-keys.ts`.
 *
 * The payload is a timestamp rather than a counter because a counter has to be derived from
 * something that survives, and retention deletes session rows while leaving transcript rows
 * behind: a counter would reset and re-mint a coordinate whose transcript is still on disk,
 * so the successor would inherit the retired conversation's history. The clock only moves
 * forward, so a coordinate minted after a purge is one that has never been used.
 */

const PREFIX = 'append:'

/** The coordinate for a given mint time. */
export function appendCoordinate(ts: number): string {
  return `${PREFIX}${ts}`
}

/** Whether a session's thread segment is an append coordinate rather than a platform thread. */
export function isAppendCoordinate(thread: string | undefined): boolean {
  return thread !== undefined && thread.startsWith(PREFIX)
}

/** The mint time a coordinate carries; undefined when it is not one, or its payload is not a timestamp. */
export function appendCoordinateTs(thread: string | undefined): number | undefined {
  if (!isAppendCoordinate(thread)) return undefined
  // Digits only, and at least one: `Number('')` is 0, which would read an empty payload as
  // a valid coordinate minted at the epoch and let it win every comparison.
  const payload = thread!.slice(PREFIX.length)
  if (!/^\d+$/.test(payload)) return undefined
  const ts = Number(payload)
  return Number.isSafeInteger(ts) ? ts : undefined
}

/**
 * The next coordinate after `current`, minted monotonically.
 *
 * `max(now, current + 1)` so a clock moved backwards cannot mint below the coordinate in
 * force, which would make `!new` silently no-op — the rotation would appear to succeed
 * while every later message still resolved to the coordinate it was meant to retire.
 */
export function nextAppendCoordinate(current: string | undefined, now: number): string {
  const currentTs = appendCoordinateTs(current)
  return appendCoordinate(currentTs === undefined ? now : Math.max(now, currentTs + 1))
}
