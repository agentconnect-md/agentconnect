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

import {
  APPEND_COORDINATE_PREFIX,
  COORDINATOR_COORDINATE_PREFIX,
  isAppendCoordinate,
  isCoordinatorCoordinate
} from '@agentconnect.md/protocol'

// The prefixes and their tests live in the protocol package so the Control Plane and the console recognize these sessions too.
export { APPEND_COORDINATE_PREFIX, COORDINATOR_COORDINATE_PREFIX, isAppendCoordinate, isCoordinatorCoordinate }

const PREFIX = APPEND_COORDINATE_PREFIX

/** The coordinate for a given mint time. */
export function appendCoordinate(ts: number): string {
  return `${PREFIX}${ts}`
}

/** The coordinator session's coordinate for a given mint time (auto-session-mode.md §4). */
export function coordinatorCoordinate(ts: number): string {
  return `${COORDINATOR_COORDINATE_PREFIX}${ts}`
}

/** Which session a conversation coordinate names: the one `append` session or the `auto` coordinator. */
export type ConversationCoordinateKind = 'append' | 'coordinator'

/** The kind of session a conversation coordinate names. */
export function coordinateKind(thread: string | undefined): ConversationCoordinateKind {
  return isCoordinatorCoordinate(thread) ? 'coordinator' : 'append'
}

/** The mint time a coordinate carries; undefined when it is not one, or its payload is not a timestamp. */
export function appendCoordinateTs(thread: string | undefined): number | undefined {
  if (!isAppendCoordinate(thread)) return undefined
  // Digits only, and at least one: `Number('')` is 0, an epoch coordinate that would win every comparison.
  const payload = thread!.slice(isCoordinatorCoordinate(thread) ? COORDINATOR_COORDINATE_PREFIX.length : PREFIX.length)
  if (!/^\d+$/.test(payload)) return undefined
  const ts = Number(payload)
  return Number.isSafeInteger(ts) ? ts : undefined
}

/** The next coordinate after `current`, of its kind unless told: `max(now, current + 1)`, so a clock moved back cannot make `!new` a no-op. */
export function nextAppendCoordinate(
  current: string | undefined,
  now: number,
  kind: ConversationCoordinateKind = coordinateKind(current)
): string {
  const currentTs = appendCoordinateTs(current)
  const ts = currentTs === undefined ? now : Math.max(now, currentTs + 1)
  return kind === 'coordinator' ? coordinatorCoordinate(ts) : appendCoordinate(ts)
}
