// Azure DevOps has no hooks in v1 (azure-devops-integration.md §11): the fence refuses a delivery naming it, the rest decline.
import type { RdMsgHook } from '@agentconnect.md/protocol'
import { CODE_HOST_NOT_IMPLEMENTED, azureDevOpsNotImplemented } from './not-implemented.js'
import type { CodeHostEffectLease, CodeHostFinalPoster, CodeHostTurnFinal } from '../codehost/turn-final.js'

/** What Azure DevOps's members read back on the daemon. */
export interface AzureDevOpsTurnFinalHost {
  log: { warn: (message: string) => void }
}

/** No relay serves Azure DevOps ingress, so a delivery whose envelope names it is refused before a turn starts. */
function hostFence(msg: RdMsgHook, host: AzureDevOpsTurnFinalHost): string | undefined {
  if (msg.context?.source !== 'azure-devops') return undefined
  host.log.warn(`hook: fire ${msg.msgId} for agent "${msg.agentId}" names azure-devops, which this build cannot serve`)
  return CODE_HOST_NOT_IMPLEMENTED
}

export const azureDevOpsTurnFinal: CodeHostTurnFinal<'azure-devops'> = {
  provider: 'azure-devops',
  replyTarget: () => undefined,
  hostFence,
  worktreeCleanup: () => undefined,
  // Unreachable: both take a reply target, and this module produces none.
  effectLease: (): CodeHostEffectLease => azureDevOpsNotImplemented('effect leases'),
  finalPoster: (): CodeHostFinalPoster => azureDevOpsNotImplemented('final posters'),
  pullRequestContext: async () => undefined,
  reportsAbsentOutput: false
}
