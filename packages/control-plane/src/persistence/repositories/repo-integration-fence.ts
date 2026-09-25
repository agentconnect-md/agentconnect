// The tier a GitHub hook's review and Checks actions need from the row or installation grant they resolve through, checked under the hook writes' advisory scopes.
import type { Prisma } from '../../generated/prisma/client.js'
import type { AgentId } from '../../domain/ids.js'
import type { RepoAccess } from '../ports.js'
import { AgentRepoIntegrationConflict } from '../errors.js'
import { accessBelow, githubEffectsNeed } from '../../domain/repo-access.js'

const WRITE_REQUIRING: Prisma.HookDefWhereInput = {
  OR: [{ reviewPolicy: { not: 'off' } }, { reportingMode: { not: 'off' } }]
}

// The resolver takes a github workspace's own tier before any row or grant (github/service.ts).
async function githubWorkspaceRepoId(tx: Prisma.TransactionClient, agentId: AgentId): Promise<bigint | null> {
  const agent = await tx.agent.findUnique({
    where: { id: agentId },
    select: { workspaceRepoId: true, gitCredentialProvider: true }
  })
  return agent?.gitCredentialProvider === 'github' ? agent.workspaceRepoId : null
}

/** Refuse `access` on the agent's github row for `repoId` while an enabled hook there needs more; the caller holds the agent lifecycle and agent/repo scopes. */
export async function assertRowServesGithubHooks(
  tx: Prisma.TransactionClient,
  agentId: AgentId,
  repoId: bigint,
  access: RepoAccess
): Promise<void> {
  if (access === 'write' || (await githubWorkspaceRepoId(tx, agentId)) === repoId) return
  const hooks = await tx.hookDef.findMany({
    where: { agentId, kind: 'github', enabled: true, repoId, ...WRITE_REQUIRING },
    select: { reviewPolicy: true, reportingMode: true }
  })
  if (hooks.some((hook) => accessBelow(access, githubEffectsNeed(hook)))) {
    throw new AgentRepoIntegrationConflict(repoId, 'repository')
  }
}

/** Refuse `access` on a grant while an enabled hook needs more on a repository the grant alone covers; the caller holds the agent lifecycle scope. */
export async function assertInstallationGrantServesGithubHooks(
  tx: Prisma.TransactionClient,
  agentId: AgentId,
  installationId: bigint,
  access: RepoAccess
): Promise<void> {
  if (access === 'write') return
  const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { orgId: true } })
  // The resolver's coverage: the hook's owner names this live installation of the agent's organization.
  const installation = agent
    ? await tx.githubInstallation.findFirst({
        where: { installationId, orgId: agent.orgId, revokedAt: null },
        select: { accountLogin: true }
      })
    : null
  if (!installation) return
  const account = installation.accountLogin.toLowerCase()
  const workspaceRepoId = await githubWorkspaceRepoId(tx, agentId)
  const rows = await tx.agentRepoAuthorization.findMany({
    where: { agentId, provider: 'github' },
    select: { repoId: true }
  })
  const ownTier = new Set(rows.map((row) => row.repoId))
  const hooks = await tx.hookDef.findMany({
    where: { agentId, kind: 'github', enabled: true, repoId: { not: null }, ...WRITE_REQUIRING },
    select: { repoId: true, repoFullName: true, reviewPolicy: true, reportingMode: true }
  })
  const blocking = hooks.find(
    (hook) =>
      hook.repoId !== null &&
      hook.repoId !== workspaceRepoId &&
      !ownTier.has(hook.repoId) &&
      hook.repoFullName?.split('/')[0]?.toLowerCase() === account &&
      accessBelow(access, githubEffectsNeed(hook))
  )
  if (blocking && blocking.repoId !== null) throw new AgentRepoIntegrationConflict(blocking.repoId, 'installation')
}

/** The row or installation grant a github hook's effects resolve through off the workspace, as the resolver picks it; null when neither authorizes the repository. */
export async function githubAdditionalTier(
  tx: Prisma.TransactionClient,
  orgId: string,
  agentId: AgentId,
  repoId: bigint,
  repoFullName: string | undefined
): Promise<{ access: RepoAccess; via: 'repository' | 'installation' } | null> {
  const row = await tx.agentRepoAuthorization.findFirst({
    where: { agentId, provider: 'github', repoId },
    select: { access: true }
  })
  if (row) return { access: row.access as RepoAccess, via: 'repository' }
  const owner = repoFullName?.split('/')[0]
  if (!owner) return null
  const installation = await tx.githubInstallation.findFirst({
    where: { orgId, revokedAt: null, accountLogin: { equals: owner, mode: 'insensitive' } },
    select: { installationId: true }
  })
  if (!installation) return null
  const grant = await tx.agentInstallationAuthorization.findFirst({
    where: { agentId, provider: 'github', installationId: installation.installationId },
    select: { access: true }
  })
  return grant ? { access: grant.access as RepoAccess, via: 'installation' } : null
}
