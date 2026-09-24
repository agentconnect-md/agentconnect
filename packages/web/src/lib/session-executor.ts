// How the console NAMES a session's birth verdict — session-executors.md §7.
import type { SessionStayedHomeReason } from '@agentconnect.md/protocol'

/** One phrase under `Sessions.detail.stayedHome`; missing message keys do not compile. */
export type StayedHomeKey =
  | 'notOnGroup'
  | 'groupSwitchOff'
  | 'sharedSession'
  | 'noCandidate'
  | 'candidatesFull'
  | 'controlPlaneUnreachable'
  | 'holderLeastLoaded'

/** Keep suffixes short beside the daemon name; daemon-homed memory needs no suffix. */
const STAYED_HOME_KEYS: Record<SessionStayedHomeReason, StayedHomeKey | undefined> = {
  not_on_group: 'notOnGroup',
  group_switch_off: 'groupSwitchOff',
  shared_session: 'sharedSession',
  memory_daemon_homed: undefined,
  no_candidate: 'noCandidate',
  candidates_full: 'candidatesFull',
  control_plane_unreachable: 'controlPlaneUnreachable',
  holder_least_loaded: 'holderLeastLoaded'
}

/** Unknown reasons and reasons without useful detail have no suffix. */
export function stayedHomeReasonKey(reason: string | null | undefined): StayedHomeKey | undefined {
  return reason ? STAYED_HOME_KEYS[reason as SessionStayedHomeReason] : undefined
}
