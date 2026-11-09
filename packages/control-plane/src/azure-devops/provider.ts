// Azure DevOps's entry in the code-host registry (azure-devops-integration.md §5, §6.1, §7): a binding through one connection vouches, and its credential is proxy-only.
import {
  AZURE_DEVOPS_HOOKS_V1_FEATURE,
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

// A managed workspace requires both the application's visibility and the acting person's access.
async function deriveAzureDevOpsWorkspace(derivation: CodeHostWorkspaceDerivation): Promise<DerivedWorkspace | null> {
  const { deps, orgId, actorUserId, gitRepo, requestedAccess } = derivation
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
  let userAccess
  try {
    userAccess = await azure.userAuthz.assertAccess(actorUserId, located, requestedAccess ?? 'read')
  } catch (e) {
    return refuseFromConnection(e)
  }
  let access: 'read' | 'write' = 'read'
  if (requestedAccess !== 'read') {
    // Inferred access is the common ceiling; explicit write requires both parties' Contribute permission.
    let contribute: boolean
    try {
      contribute = await azure.bindings.canContribute(located)
    } catch (e) {
      return refuseFromConnection(e)
    }
    if (requestedAccess === 'write' && !contribute) {
      refuseWorkspaceCredential(grantAccessMessage(label, address.organization, true))
    }
    access = contribute && userAccess.write ? 'write' : 'read'
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
      attestedByUserId: actorUserId ?? null,
      azureDevOps: routing,
      gitRepo: binding.cloneUrl,
      defaultBranch: binding.defaultBranch ?? 'main',
      access
    }
  }
  return {
    kind: 'azure-devops',
    connectionId: located.connection.id,
    attestedByUserId: actorUserId ?? null,
    azureDevOps: routing,
    gitRepo: located.repository.cloneUrl,
    defaultBranch: located.repository.defaultBranch ?? 'main',
    access
  }
}

// Every increase rechecks the human; write additionally requires the application's Contribute permission.
async function upgradeAzureDevOpsGrant(ctx: CodeHostRepoAuthorizationContext): Promise<AgentRepoAuthDtoT | undefined> {
  const { deps, req, reply, orgId, agent, row, access, toDto } = ctx
  const refused = (status: 403 | 404 | 409 | 429 | 502, message: string): undefined => {
    const error = { 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 502: 'Bad Gateway' }[
      status
    ]
    void reply.code(status).send({ error, statusCode: status, message })
    return undefined
  }
  const azure = deps.azureDevOps
  if (!azure || row.connectionId === undefined || row.azureDevOps === undefined) {
    return refused(409, 'the repository is not bound through an Azure DevOps connection in this organization')
  }
  try {
    const located = await azure.bindings.byRepositoryId(orgId, row.connectionId, row.azureDevOps.repositoryId)
    await azure.userAuthz.assertAccess(req.principal?.userId, located, access)
    if (access === 'write' && !(await azure.bindings.canContribute(located))) {
      return refused(409, grantAccessMessage(row.repoFullName, row.azureDevOps.organization, true))
    }
  } catch (e) {
    if (e instanceof AzureDevOpsConnectDenied)
      return refused(e.status === 403 || e.status === 404 ? e.status : 409, e.message)
    if (e instanceof AzureDevOpsApiError)
      return refused(e.code === 'RATE_LIMITED' ? 429 : 502, `azure devops: ${e.message}`)
    throw e
  }
  const result = await deps.repos.agentRepoAuth.raiseAttested(row.id, access, {
    userId: req.principal!.userId,
    at: new Date(deps.clock.now())
  })
  if (!result) return refused(404, 'authorization not found')
  if (result.restored) ctx.specChanged()
  const updated = result.row
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
    requiredForInstance: () => [],
    // A relay serves service hooks under its own string; it never runs the proxy `azure-devops-v1` names (§11.9).
    ruleRequired: () => [AZURE_DEVOPS_HOOKS_V1_FEATURE]
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
          attestedByUserId: derived.attestedByUserId,
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
    // Run state is a pull-request status, informational by construction (§11.7): an administrator makes it a gate.
    effects: (body) => ({
      reviewPolicy: body.reviewPolicy ?? 'off',
      reportingMode: body.reportingMode ?? 'off',
      gateMode: 'informational'
    }),
    // §11.2: the repository's subscriptions follow the union of its enabled hooks' kinds, and its rules are recompiled.
    convergeManagedRepository: (deps, orgId, repoId, onError) => {
      const hooks = deps.azureDevOps?.hooks
      if (!hooks || repoId === null) return
      return hooks.convergeRepository(orgId, repoId).catch(onError)
    }
  },
  routing: {
    // Unreachable: Decision routing is not offered for Azure DevOps (§11.3), so no routed scope names it.
    requiredFeatures: [AZURE_DEVOPS_V1_FEATURE],
    familyLabel: (family) => family,
    anyUpdateCadence: () => ({ events: [], commentFamilies: [], mentionOnly: false }),
    repositoryPath: async () => undefined
  },
  upgradeRepoAuthorization: upgradeAzureDevOpsGrant
}
