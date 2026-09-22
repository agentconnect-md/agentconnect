// How the console NAMES a session's birth verdict — session-executors.md §7.
import type { SessionStayedHomeReason } from '@agentconnect.md/protocol'

/** One phrase under `Sessions.detail.stayedHome`. A literal union, so a key that is not in the
 *  messages does not compile. */
export type StayedHomeKey =
  | 'notOnGroup'
  | 'groupSwitchOff'
  | 'sharedSession'
  | 'memoryDaemonHomed'
  | 'noCandidate'
  | 'candidatesFull'
  | 'controlPlaneUnreachable'
  | 'holderLeastLoaded'

/** The `Sessions.detail.stayedHome` key for each recorded reason. Its phrases are short on purpose:
 *  this reads beside the daemon's name, and `holderLeastLoaded` is the ordinary outcome of the
 *  placement rule, not a failure — a session whose holder had the fewest sessions simply won. */
const STAYED_HOME_KEYS: Record<SessionStayedHomeReason, StayedHomeKey> = {
  not_on_group: 'notOnGroup',
  group_switch_off: 'groupSwitchOff',
  shared_session: 'sharedSession',
  memory_daemon_homed: 'memoryDaemonHomed',
  no_candidate: 'noCandidate',
  candidates_full: 'candidatesFull',
  control_plane_unreachable: 'controlPlaneUnreachable',
  holder_least_loaded: 'holderLeastLoaded'
}

/** The message key for a recorded reason, or undefined when there is none to say. The lookup is
 *  total rather than exhaustive-by-type: the enum is closed on the wire, but a newer Control Plane
 *  can name a value this console has no phrase for, and a missing phrase must not throw at render. */
export function stayedHomeReasonKey(reason: string | null | undefined): StayedHomeKey | undefined {
  return reason ? STAYED_HOME_KEYS[reason as SessionStayedHomeReason] : undefined
}
