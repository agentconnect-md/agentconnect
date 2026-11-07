// Azure DevOps's entry in the code-host registry: a known provider with no Control Plane state until A2 (azure-devops-integration.md §13).
import { AZURE_DEVOPS_V1_FEATURE } from '@agentconnect.md/protocol'
import type { CodeHostProviderModule } from '../codehost/provider.js'

export const azureDevOpsCodeHostProvider: CodeHostProviderModule = {
  provider: 'azure-devops',
  displayName: 'Azure DevOps',
  repositorySubject: 'repository',
  features: {
    // One fixed host, so there is no instance axis anywhere.
    deploymentHost: () => undefined,
    specHost: () => undefined,
    ruleHost: () => undefined,
    required: () => [AZURE_DEVOPS_V1_FEATURE],
    requiredForInstance: () => []
  },
  workspace: {
    // No connection or catalog exists before A2, so every address stays anonymous and no stored credential names this host.
    derive: async () => null,
    writeFromDerived: () => null,
    toDto: () => null,
    toSpec: () => null,
    legacySpecArm: () => null
  },
  hooks: {
    // No hooks in v1 (§11): the create body admits no `azure-devops` arm and no row can store the kind.
    effects: (body) => ({
      reviewPolicy: body.reviewPolicy ?? 'off',
      reportingMode: body.reportingMode ?? 'off',
      gateMode: 'informational'
    }),
    convergeManagedRepository: () => {}
  },
  routing: {
    // Unreachable: no routing family is registered for this provider, so no routed scope names it.
    requiredFeatures: [AZURE_DEVOPS_V1_FEATURE],
    familyLabel: (family) => family,
    anyUpdateCadence: () => ({ events: [], commentFamilies: [], mentionOnly: false }),
    repositoryPath: async () => undefined
  },

  /** Unreachable until A2: the grant route admits no `azure-devops` arm, so no row names this host. */
  async upgradeRepoAuthorization({ reply }) {
    void reply
      .code(409)
      .send({ error: 'Conflict', statusCode: 409, message: 'Azure DevOps repositories cannot be authorized yet' })
    return undefined
  }
}
