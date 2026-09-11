/**
 * Gitea's entry in the daemon turn-final seam (gitea-integration.md §10, §16).
 *
 * One member is real and load-bearing already: `hostFence`. A delivery carrying a Gitea member
 * cannot be answered by this build, and the fence is where that is said — a turn refuses instead of
 * being normalized by the generic webhook shaping or answered through another host's poster. The
 * rest decline: no reply target, no lifecycle pairing, and a lease and poster that only a target
 * this module never produces could reach.
 */
import { GITEA_DEFAULT_BASE_URL, type RdMsgHook } from '@agentconnect.md/protocol'
import { CODE_HOST_NOT_IMPLEMENTED, giteaNotImplemented } from './not-implemented.js'
import type {
  CodeHostDelivery,
  CodeHostEffectLease,
  CodeHostFinalPoster,
  CodeHostThreadWorktreeCleanup,
  CodeHostTurnFinal
} from '../codehost/turn-final.js'

/** What Gitea's members read back on the daemon; G4 widens this to the effect lease and the spec host. */
export interface GiteaTurnFinalHost {
  log: { warn: (message: string) => void }
}

/**
 * Refuse any Gitea-shaped delivery, by the same mechanism §24.4 refuses a GitLab delivery naming
 * the wrong instance: the turn never starts and is never re-targeted. The relay gates dispatch on
 * `gitea-v1`, which this build does not advertise, so this is the second fence rather than the first.
 */
function hostFence(msg: RdMsgHook, host: GiteaTurnFinalHost): string | undefined {
  if (msg.gitea === undefined) return undefined
  host.log.warn(`hook: fire ${msg.msgId} for agent "${msg.agentId}" carries gitea metadata this build cannot serve`)
  return CODE_HOST_NOT_IMPLEMENTED
}

export const giteaTurnFinal: CodeHostTurnFinal<'gitea'> = {
  provider: 'gitea',
  replyTarget: () => undefined,
  hostFence,
  worktreeCleanup: (_delivery: CodeHostDelivery): CodeHostThreadWorktreeCleanup | undefined => undefined,
  // Unreachable: both take a reply target, and this module produces none.
  effectLease: (): CodeHostEffectLease => ({
    token: () => Promise.reject(new Error(`${CODE_HOST_NOT_IMPLEMENTED}: gitea effect leases arrive in G4`)),
    invalidateToken: () => {},
    apiBaseUrl: () => `${GITEA_DEFAULT_BASE_URL}/api/v1`
  }),
  finalPoster: (): CodeHostFinalPoster => giteaNotImplemented('final posters'),
  reportsAbsentOutput: false
}
