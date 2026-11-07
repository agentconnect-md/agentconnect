// Azure DevOps's entry in the code-host registry (azure-devops-integration.md §5, §6.1, §7): a binding through one connection vouches, and its credential is proxy-only.
import {
  AZURE_DEVOPS_V1_FEATURE,
  azureDevOpsRepoAddress,
  normalizeGitUrl,
  type AzureDevOpsRepoRouting
} from '@agentconnect.md/protocol'
import {
  refuseWorkspaceCredential,
  type CodeHostProviderModule,
  type CodeHostRepoAuthorizationContext,
  type CodeHostWorkspaceDerivation,
  type DerivedWorkspace
} from '../codehost/provider.js'
import type { AgentRepoAuthDtoT } from '../http/dto/index.js'
import { AzureDevOpsApiError } from './api.js'
import { grantAccessMessage, type AzureDevOpsLocatedRepository } from './binding.service.js'
import { AzureDevOpsConnectDenied } from './connection.service.js'

/** A connection-level failure as the derivation's refusal; throttling and outages bubble for the routes' 429/502. */
function refuseFromConnection(e: unknown): never {
  if (e instanceof AzureDevOpsConnectDenied) refuseWorkspaceCredential(e.message)
  if (e instanceof AzureDevOpsApiError && e.code === 'SECRET_REJECTED') {
    refuseWorkspaceCredential(
      'Microsoft rejected the Azure DevOps connection’s client secret — replace it on the Integrations card'
    )
  }
  if (e instanceof AzureDevOpsApiError && e.code === 'ACCESS_REVOKED') {
    refuseWorkspaceCredential(`azure devops: ${e.message} — connect the organization again on the Integrations card`)
  }
  throw e
}

function routingOf(located: AzureDevOpsLocatedRepository): AzureDevOpsRepoRouting {
  return {
    organization: located.connection.organization,
    projectId: located.repository.projectId,
    repositoryId: located.repository.id
  }
}

/** git-workspace-model.md §6 for Azure DevOps: visible in a connected organization ⇒ managed, invisible ⇒ refused, unconnected ⇒ anonymous. */
async function deriveAzureDevOpsWorkspace(derivation: CodeHostWorkspaceDerivation): Promise<DerivedWorkspace | null> {
  const { deps, orgId, gitRepo, requestedAccess } = derivation
  const address = azureDevOpsRepoAddress(gitRepo)
  const azure = deps.azureDevOps
  if (!address || !azure) return null
  const label = `${address.organization}/${address.project}/${address.repository}`
  const connections = await azure.bindings.connectionsFor(orgId, address.organization)
  if (connections.length === 0) {
    if (requestedAccess === 'write') {
      refuseWorkspaceCredential(
        `Azure DevOps write access requires a connected organization — connect ${address.organization} on the Integrations card`
      )
    }
    return { kind: 'anonymous', gitRepo: normalizeGitUrl(gitRepo), access: 'read', host: 'azure-devops' }
  }
  let located: AzureDevOpsLocatedRepository | null
  try {
    located = await azure.bindings.locate(connections, address)
  } catch (e) {
    return refuseFromConnection(e)
  }
  if (!located) refuseWorkspaceCredential(grantAccessMessage(label, address.organization, false))
  let access: 'read' | 'write' = 'read'
  if (requestedAccess !== 'read') {
    // One permission evaluation (§12 item 7): a `write` request needs Contribute; an unstated one takes what the identity holds.
    let contribute: boolean
    try {
      contribute = await azure.bindings.canContribute(located)
    } catch (e) {
      return refuseFromConnection(e)
    }
    if (requestedAccess === 'write' && !contribute) {
      refuseWorkspaceCredential(grantAccessMessage(label, address.organization, true))
    }
    access = contribute ? 'write' : 'read'
  }
  const routing = routingOf(located)
  if (derivation.write) {
    let binding
    try {
      binding = await azure.bindings.ensureBound(located)
    } catch (e) {
      return refuseFromConnection(e)
    }
    return {
      kind: 'azure-devops',
      repoId: binding.repoId,
      connectionId: located.connection.id,
      azureDevOps: routing,
      gitRepo: binding.cloneUrl,
      defaultBranch: binding.defaultBranch ?? 'main',
      access
    }
  }
  return {
    kind: 'azure-devops',
    connectionId: located.connection.id,
    azureDevOps: routing,
    gitRepo: located.repository.cloneUrl,
    defaultBranch: located.repository.defaultBranch ?? 'main',
    access
  }
}

/** Raising a grant to `write` needs Contribute on the repository; `comment` reads only (§6.3), so it needs nothing more. */
async function upgradeAzureDevOpsGrant(ctx: CodeHostRepoAuthorizationContext): Promise<AgentRepoAuthDtoT | undefined> {
  const { deps, req, reply, orgId, agent, row, access, toDto } = ctx
  const refused = (status: 404 | 409 | 429 | 502, message: string): undefined => {
    const error = { 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 502: 'Bad Gateway' }[status]
    void reply.code(status).send({ error, statusCode: status, message })
    return undefined
  }
  const azure = deps.azureDevOps
  if (!azure || row.connectionId === undefined || row.azureDevOps === undefined) {
    return refused(409, 'the repository is not bound through an Azure DevOps connection in this organization')
  }
  if (access === 'write') {
    try {
      const located = await azure.bindings.byRepositoryId(orgId, row.connectionId, row.azureDevOps.repositoryId)
      if (!(await azure.bindings.canContribute(located))) {
        return refused(409, grantAccessMessage(row.repoFullName, row.azureDevOps.organization, true))
      }
    } catch (e) {
      if (e instanceof AzureDevOpsConnectDenied) return refused(e.status === 404 ? 404 : 409, e.message)
      if (e instanceof AzureDevOpsApiError)
        return refused(e.code === 'RATE_LIMITED' ? 429 : 502, `azure devops: ${e.message}`)
      throw e
    }
  }
  const updated = await deps.repos.agentRepoAuth.updateAccess(row.id, access)
  if (!updated) return refused(404, 'authorization not found')
  void deps.repos.audit
    .append({
      kind: 'agent_repo_change',
      orgId,
      agentId: agent.id,
      ...(req.principal ? { actorUserId: req.principal.userId } : {}),
      frameType: 'gitcred/grant',
      message: `azure devops repository ${updated.repoFullName} authorization upgraded (${row.access} → ${updated.access})`,
      details: {
        repoAuthId: updated.id,
        provider: 'azure-devops',
        repoFullName: updated.repoFullName,
        previousAccess: row.access,
        access: updated.access
      }
    })
    .catch(() => {})
  return toDto(updated)
}

export const azureDevOpsCodeHostProvider: CodeHostProviderModule = {
  provider: 'azure-devops',
  displayName: 'Azure DevOps',
  repositorySubject: 'repository',
  // §6.1: the token is organization-wide, so only the proxy may hold it.
  proxyOnly: true,
  features: {
    // One fixed host, so there is no instance axis anywhere.
    deploymentHost: () => undefined,
    specHost: () => undefined,
    ruleHost: () => undefined,
    required: () => [AZURE_DEVOPS_V1_FEATURE],
    requiredForInstance: () => []
  },
  workspace: {
    derive: deriveAzureDevOpsWorkspace,
    writeFromDerived: (derived) => {
      if (derived.kind !== 'azure-devops') return null
      // A persisting derivation always binds; one without an id is a preview that must never be written.
      if (derived.repoId === undefined) throw new Error('an azure-devops workspace is written only from a binding')
      return {
        credential: {
          provider: 'azure-devops',
          access: derived.access,
          connectionId: derived.connectionId,
          azureDevOps: derived.azureDevOps
        },
        workspaceRepoId: derived.repoId
      }
    },
    toDto: (credential, workspaceRepoId) =>
      credential.provider === 'azure-devops'
        ? {
            provider: 'azure-devops',
            access: credential.access,
            repoId: (workspaceRepoId ?? 0n).toString(),
            connectionId: credential.connectionId,
            azureDevOps: credential.azureDevOps
          }
        : null,
    // Frame-fatal on a daemon without azure-devops-v1; every projection path gates on the feature.
    toSpec: (credential, workspaceRepoId) =>
      credential.provider === 'azure-devops' && workspaceRepoId !== undefined
        ? {
            provider: 'azure-devops',
            repoId: workspaceRepoId.toString(),
            connectionId: credential.connectionId,
            azureDevOps: credential.azureDevOps
          }
        : null,
    // The host-neutral `git` arm predates Azure DevOps, so every peer that decodes it advertises workspace-git-v1.
    legacySpecArm: () => null
  },
  hooks: {
    // No hooks in v1 (§11): the create body admits no `azure-devops` arm and no row can store the kind.
    effects: (body) => ({
      reviewPolicy: body.reviewPolicy ?? 'off',
      reportingMode: body.reportingMode ?? 'off',
      gateMode: 'informational'
    }),
    // No webhook to converge: a binding is a catalog row and an identity (§5).
    convergeManagedRepository: () => {}
  },
  routing: {
    // Unreachable: no routing family is registered for this provider, so no routed scope names it.
    requiredFeatures: [AZURE_DEVOPS_V1_FEATURE],
    familyLabel: (family) => family,
    anyUpdateCadence: () => ({ events: [], commentFamilies: [], mentionOnly: false }),
    repositoryPath: async () => undefined
  },
  upgradeRepoAuthorization: upgradeAzureDevOpsGrant
}
