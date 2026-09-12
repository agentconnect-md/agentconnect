/**
 * The pure lifecycle rules of a Gitea repository binding (gitea-integration.md §4.3, §4.4, §5, §6):
 * which states serve runtime credentials, which one authorizes a collaborator lookup, and how a
 * rejected token or an unverified test delivery moves a binding. Kept free of I/O so the saga, the
 * grant path and the authorization arm read one answer.
 */
import type { GiteaBindingState } from '../persistence/ports.js'

/** The reason a rejected token leaves on every binding of its connection (§4.3). */
export const TOKEN_REJECTED_REASON = 'token_rejected' as const
/** The reason a bot demoted below `admin` leaves on its binding (§4.4). */
export const ADMIN_LOST_REASON = 'admin_lost' as const
/** The warning a binding whose test delivery never reached the relay carries (§6 step 4). */
export const WEBHOOK_UNVERIFIED_REASON = 'webhook_unverified' as const
/** The subscription Gitea stored is missing names the union asked for (§7 read-back). */
export const WEBHOOK_EVENTS_UNSUPPORTED_REASON = 'webhook_events_unsupported' as const
/** A removal refused because a trigger, workspace or grant still names the repository (§6). */
export const REPOSITORY_IN_USE_REASON = 'repository_in_use' as const

/** Runtime keeps serving through an admin-plane fault; a rejected token or cleanup stops it (§4.4, §6). */
export function servesRuntime(state: GiteaBindingState): boolean {
  return state === 'provisioning' || state === 'ready' || state === 'admin_degraded'
}

/** The collaborator gate needs repository `admin`, so only a fully converged binding answers it (§4.4, §8). */
export function authorizesMembership(state: GiteaBindingState): boolean {
  return state === 'ready'
}

/** A binding entering cleanup leaves the relay pool; every other state's rule stays verifiable. */
export function compilesHookRule(state: GiteaBindingState): boolean {
  return state !== 'cleanup_pending'
}

/** A rejected token degrades every binding still owed convergence; cleanup keeps its own obligation (§4.3). */
export function afterTokenRejection(state: GiteaBindingState): GiteaBindingState {
  return state === 'cleanup_pending' ? state : 'runtime_degraded'
}

/** The outcome a converged webhook earns: `ready`, with the unverified warning when the relay never saw the test (§6). */
export function readyOutcome(deliveryVerified: boolean): { state: 'ready'; stateReason: string | null } {
  return { state: 'ready', stateReason: deliveryVerified ? null : WEBHOOK_UNVERIFIED_REASON }
}

/** A verified delivery clears exactly the unverified warning; every other reason is a fact it does not change. */
export function afterDeliveryVerified(
  state: GiteaBindingState,
  stateReason: string | null
): { state: GiteaBindingState; stateReason: string | null } {
  if (state === 'ready' && stateReason === WEBHOOK_UNVERIFIED_REASON) return { state, stateReason: null }
  return { state, stateReason }
}
