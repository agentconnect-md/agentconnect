// Azure DevOps has no hooks in v1, so no reply target selects this adapter; its refusal is caught as a lost reaction.
import type { CodeHostAckAdapter } from '../codehost/ack.js'
import { azureDevOpsNotImplemented } from './not-implemented.js'

export const azureDevOpsAck: CodeHostAckAdapter = {
  provider: 'azure-devops',
  request: () => azureDevOpsNotImplemented('turn-start reactions')
}
