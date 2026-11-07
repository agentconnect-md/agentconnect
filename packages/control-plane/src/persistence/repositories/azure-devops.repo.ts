// Azure DevOps connections, repository identities and bindings (azure-devops-integration.md §3-§5); the claim is deployment-global, keyed by the surrogate id.
import type {
  AzureDevOpsConnection,
  AzureDevOpsRepositoryBinding,
  AzureDevOpsRepositoryIdentity,
  Prisma,
  PrismaClient
} from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { AzureDevOpsOrganizationTaken, AzureDevOpsRepositoryClaimConflict } from '../errors.js'
import type {
  AzureDevOpsBindingState,
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsConnectionSecretStore,
  AzureDevOpsConnectionState,
  AzureDevOpsCredentialSource,
  AzureDevOpsDegradedReason,
  AzureDevOpsRepositoryBindingRecord,
  AzureDevOpsRepositoryBindingRepo,
  AzureDevOpsRepositoryFacts,
  AzureDevOpsVerifiedIdentity
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { OrgId } from '../../domain/ids.js'

const PROVIDER = 'azure-devops'
const REASONS: readonly AzureDevOpsDegradedReason[] = ['secret_rejected', 'access_revoked', 'repository_unavailable']

function toReason(value: string | null): AzureDevOpsDegradedReason | null {
  if (value === null) return null
  return (REASONS as readonly string[]).includes(value) ? (value as AzureDevOpsDegradedReason) : 'secret_rejected'
}

function toConnectionRecord(r: AzureDevOpsConnection): AzureDevOpsConnectionRecord {
  // An unknown persisted state fails toward degraded, never toward connected.
  const state: AzureDevOpsConnectionState = r.state === 'connected' ? 'connected' : 'degraded'
  return {
    id: r.id,
    orgId: r.orgId,
    createdByUserId: r.createdByUserId,
    tenantId: r.tenantId,
    organization: r.organization,
    organizationInstanceId: r.organizationInstanceId,
    identityId: r.identityId,
    identityName: r.identityName,
    credentialSource: r.credentialSource === 'deployment' ? 'deployment' : 'own',
    clientId: r.clientId,
    credentialEpoch: r.credentialEpoch,
    state,
    stateReason: state === 'connected' ? null : (toReason(r.stateReason) ?? 'secret_rejected'),
    lastVerifiedAt: r.lastVerifiedAt,
    createdAt: r.createdAt
  }
}

function identityFacts(identity: AzureDevOpsVerifiedIdentity) {
  return {
    organization: identity.organization,
    identityName: identity.identityName,
    lastVerifiedAt: identity.verifiedAt
  }
}

/** Two organizations connecting one Azure DevOps organization at once serialize here. */
async function lockOrganizationInstance(tx: Prisma.TransactionClient, instanceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`azure-devops-organization:${instanceId}`}))`
}

export class PgAzureDevOpsConnectionRepo implements AzureDevOpsConnectionRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: {
    orgId: string
    createdByUserId?: string
    tenantId: string
    credentialSource: AzureDevOpsCredentialSource
    clientId: string | null
    identity: AzureDevOpsVerifiedIdentity
    sealedSecret: string
  }): Promise<AzureDevOpsConnectionRecord> {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganizationInstance(tx, input.identity.organizationInstanceId)
      const holder = await tx.azureDevOpsConnection.findFirst({
        where: { organizationInstanceId: input.identity.organizationInstanceId, orgId: { not: input.orgId } },
        select: { id: true }
      })
      if (holder) throw new AzureDevOpsOrganizationTaken()
      const row = await tx.azureDevOpsConnection.create({
        data: {
          orgId: input.orgId,
          createdByUserId: input.createdByUserId ?? null,
          tenantId: input.tenantId,
          organizationInstanceId: input.identity.organizationInstanceId,
          identityId: input.identity.identityId,
          credentialSource: input.credentialSource,
          clientId: input.clientId,
          state: 'connected',
          ...identityFacts(input.identity)
        }
      })
      await tx.azureDevOpsConnectionSecret.create({ data: { connectionId: row.id, clientSecret: input.sealedSecret } })
      return toConnectionRecord(row)
    })
  }

  async get(orgId: string, connectionId: string): Promise<AzureDevOpsConnectionRecord | null> {
    const row = await this.prisma.azureDevOpsConnection.findFirst({ where: { id: connectionId, orgId } })
    return row ? toConnectionRecord(row) : null
  }

  async getUnscoped(connectionId: string): Promise<AzureDevOpsConnectionRecord | null> {
    const row = await this.prisma.azureDevOpsConnection.findUnique({ where: { id: connectionId } })
    return row ? toConnectionRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<AzureDevOpsConnectionRecord[]> {
    const rows = await this.prisma.azureDevOpsConnection.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toConnectionRecord)
  }

  async listBySource(source: AzureDevOpsCredentialSource): Promise<AzureDevOpsConnectionRecord[]> {
    const rows = await this.prisma.azureDevOpsConnection.findMany({
      where: { credentialSource: source },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toConnectionRecord)
  }

  async holderOfInstance(organizationInstanceId: string): Promise<string | null> {
    const row = await this.prisma.azureDevOpsConnection.findFirst({
      where: { organizationInstanceId },
      select: { orgId: true }
    })
    return row?.orgId ?? null
  }

  async replaceSecret(
    orgId: string,
    connectionId: string,
    identity: AzureDevOpsVerifiedIdentity,
    sealedSecret: string
  ): Promise<AzureDevOpsConnectionRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      // The same identity in the same organization only (§3.5); a recovered secret returns the connection to connected.
      const res = await tx.azureDevOpsConnection.updateMany({
        where: {
          id: connectionId,
          orgId,
          identityId: identity.identityId,
          organizationInstanceId: identity.organizationInstanceId
        },
        data: {
          ...identityFacts(identity),
          state: 'connected',
          stateReason: null,
          credentialEpoch: { increment: 1n }
        }
      })
      if (res.count !== 1) return null
      await tx.azureDevOpsConnectionSecret.upsert({
        where: { connectionId },
        create: { connectionId, clientSecret: sealedSecret },
        update: { clientSecret: sealedSecret }
      })
      return toConnectionRecord(await tx.azureDevOpsConnection.findUniqueOrThrow({ where: { id: connectionId } }))
    })
  }

  async advanceEpoch(connectionId: string, sealedSecret: string): Promise<AzureDevOpsConnectionRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.azureDevOpsConnection.updateMany({
        where: { id: connectionId },
        data: { credentialEpoch: { increment: 1n } }
      })
      if (res.count !== 1) return null
      await tx.azureDevOpsConnectionSecret.upsert({
        where: { connectionId },
        create: { connectionId, clientSecret: sealedSecret },
        update: { clientSecret: sealedSecret }
      })
      return toConnectionRecord(await tx.azureDevOpsConnection.findUniqueOrThrow({ where: { id: connectionId } }))
    })
  }

  async setState(
    connectionId: string,
    state: AzureDevOpsConnectionState,
    stateReason: AzureDevOpsDegradedReason | null
  ): Promise<AzureDevOpsConnectionRecord | null> {
    const res = await this.prisma.azureDevOpsConnection.updateMany({
      where: { id: connectionId },
      data: { state, stateReason: state === 'connected' ? null : stateReason }
    })
    return res.count === 1 ? this.getUnscoped(connectionId) : null
  }

  async remove(orgId: string, connectionId: string): Promise<'removed' | 'referenced' | 'missing'> {
    return this.prisma.$transaction(async (tx) => {
      // Claims first, in the binding path's order, then the row: a racing reference either commits first and is counted, or finds the binding gone.
      const identities = await tx.azureDevOpsRepositoryBinding.findMany({
        where: { orgId, connectionId },
        select: { identityId: true },
        orderBy: { identityId: 'asc' }
      })
      for (const { identityId } of identities) await lockClaim(tx, orgId, identityId)
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "azure_devops_connection" WHERE "id" = ${connectionId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      if (locked.length === 0) return 'missing'
      await tx.$queryRaw`
        SELECT "id" FROM "azure_devops_repository_binding" WHERE "connectionId" = ${connectionId}::uuid FOR UPDATE`
      const workspaces = await tx.agent.count({ where: { workspaceConnectionId: connectionId } })
      const grants = await tx.agentRepoAuthorization.count({ where: { connectionId } })
      if (workspaces + grants > 0) return 'referenced'
      // Bindings and the sealed secret cascade; the delete trigger releases each binding's claim.
      await tx.azureDevOpsConnection.delete({ where: { id: connectionId } })
      return 'removed'
    })
  }
}

export class PgAzureDevOpsConnectionSecretStore implements AzureDevOpsConnectionSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async get(orgId: string, connectionId: string): Promise<string | null> {
    const row = await this.db.azureDevOpsConnectionSecret.findFirst({ where: { connectionId, connection: { orgId } } })
    return row ? this.cipher.open(row.clientSecret, orgScope(OrgId(orgId))) : null
  }
}

// ── §4/§5 identities and bindings ───────────────────────────────────────────

type BindingRow = AzureDevOpsRepositoryBinding & {
  identity: Pick<AzureDevOpsRepositoryIdentity, 'repositoryId' | 'projectId'>
}
const withIdentity = { identity: { select: { repositoryId: true, projectId: true } } } as const

function toBindingRecord(r: BindingRow): AzureDevOpsRepositoryBindingRecord {
  // An unknown persisted state fails toward degraded, never toward ready.
  const state: AzureDevOpsBindingState = r.state === 'ready' ? 'ready' : 'runtime_degraded'
  return {
    id: r.id,
    orgId: r.orgId,
    connectionId: r.connectionId,
    repoId: r.identityId,
    repositoryId: r.identity.repositoryId,
    projectId: r.identity.projectId,
    repoPath: r.repoPath,
    cloneUrl: r.cloneUrl,
    defaultBranch: r.defaultBranch,
    state,
    stateReason: state === 'ready' ? null : (toReason(r.stateReason) ?? 'repository_unavailable'),
    createdAt: r.createdAt
  }
}

/** The claim row, locked exclusively; the binding path locks it SHARED, so a removal and a bind never interleave. */
async function lockClaim(tx: Prisma.TransactionClient, orgId: string, identityId: bigint): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "code_host_repository_claim"
     WHERE "provider" = ${PROVIDER} AND "externalId" = ${identityId.toString()}::bigint AND "orgId" = ${orgId}
       FOR UPDATE`
}

/** Take or join the deployment-global claim (§4): one AgentConnect organization per repository. */
async function joinClaim(tx: Prisma.TransactionClient, orgId: string, identityId: bigint): Promise<void> {
  // A claim released between the insert and the lock is inserted again; three rounds outlast any real interleaving.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tx.$executeRaw`
      INSERT INTO "code_host_repository_claim" ("id", "provider", "externalId", "orgId", "state", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${PROVIDER}, ${identityId.toString()}::bigint, ${orgId}, 'active', now(), now())
      ON CONFLICT ("provider", "externalId") DO NOTHING`
    const held = await tx.$queryRaw<{ orgId: string }[]>`
      SELECT "orgId" FROM "code_host_repository_claim"
       WHERE "provider" = ${PROVIDER} AND "externalId" = ${identityId.toString()}::bigint
         FOR SHARE`
    const holder = held[0]?.orgId
    if (holder === undefined) continue
    if (holder !== orgId) throw new AzureDevOpsRepositoryClaimConflict(identityId)
    return
  }
  throw new AzureDevOpsRepositoryClaimConflict(identityId)
}

export class PgAzureDevOpsRepositoryBindingRepo implements AzureDevOpsRepositoryBindingRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async identitiesOf(repositoryIds: readonly string[]): Promise<Map<string, bigint>> {
    if (repositoryIds.length === 0) return new Map()
    const rows = await this.prisma.azureDevOpsRepositoryIdentity.findMany({
      where: { repositoryId: { in: [...repositoryIds] } },
      select: { id: true, repositoryId: true }
    })
    return new Map(rows.map((row) => [row.repositoryId, row.id]))
  }

  async bind(input: {
    orgId: string
    connectionId: string
    facts: AzureDevOpsRepositoryFacts
  }): Promise<{ binding: AzureDevOpsRepositoryBindingRecord; created: boolean }> {
    const { orgId, connectionId, facts } = input
    return this.prisma.$transaction(async (tx) => {
      // §4: allocated once per repository GUID and never reused; a project change is the one fact that moves.
      const identity = await tx.azureDevOpsRepositoryIdentity.upsert({
        where: { repositoryId: facts.repositoryId },
        create: {
          repositoryId: facts.repositoryId,
          projectId: facts.projectId,
          organizationInstanceId: facts.organizationInstanceId
        },
        update: { projectId: facts.projectId }
      })
      await joinClaim(tx, orgId, identity.id)
      await tx.codeHostRepository.upsert({
        where: { orgId_provider_externalId: { orgId, provider: PROVIDER, externalId: identity.id } },
        create: {
          orgId,
          provider: PROVIDER,
          externalId: identity.id,
          displayPath: facts.repoPath,
          cloneUrl: facts.cloneUrl,
          defaultBranch: facts.defaultBranch
        },
        update: { displayPath: facts.repoPath, cloneUrl: facts.cloneUrl, defaultBranch: facts.defaultBranch }
      })
      const key = { connectionId_identityId: { connectionId, identityId: identity.id } }
      const existing = await tx.azureDevOpsRepositoryBinding.findUnique({ where: key, select: { id: true } })
      // A rebind refreshes the facts and recovers a degraded binding: the identity just read the repository.
      const row = await tx.azureDevOpsRepositoryBinding.upsert({
        where: key,
        create: {
          orgId,
          connectionId,
          identityId: identity.id,
          repoPath: facts.repoPath,
          cloneUrl: facts.cloneUrl,
          defaultBranch: facts.defaultBranch,
          state: 'ready'
        },
        update: {
          repoPath: facts.repoPath,
          cloneUrl: facts.cloneUrl,
          defaultBranch: facts.defaultBranch,
          state: 'ready',
          stateReason: null
        },
        include: withIdentity
      })
      await tx.codeHostRepositoryClaim.updateMany({
        where: { provider: PROVIDER, externalId: identity.id, orgId, bindingRef: null },
        data: { bindingRef: row.id }
      })
      return { binding: toBindingRecord(row), created: existing === null }
    })
  }

  async get(orgId: string, bindingId: string): Promise<AzureDevOpsRepositoryBindingRecord | null> {
    const row = await this.prisma.azureDevOpsRepositoryBinding.findFirst({
      where: { id: bindingId, orgId },
      include: withIdentity
    })
    return row ? toBindingRecord(row) : null
  }

  async byRepo(
    orgId: string,
    connectionId: string,
    repoId: bigint
  ): Promise<AzureDevOpsRepositoryBindingRecord | null> {
    const row = await this.prisma.azureDevOpsRepositoryBinding.findFirst({
      where: { orgId, connectionId, identityId: repoId },
      include: withIdentity
    })
    return row ? toBindingRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<AzureDevOpsRepositoryBindingRecord[]> {
    const rows = await this.prisma.azureDevOpsRepositoryBinding.findMany({
      where: { orgId },
      include: withIdentity,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBindingRecord)
  }

  async listForConnection(orgId: string, connectionId: string): Promise<AzureDevOpsRepositoryBindingRecord[]> {
    const rows = await this.prisma.azureDevOpsRepositoryBinding.findMany({
      where: { orgId, connectionId },
      include: withIdentity,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBindingRecord)
  }

  async setStateForConnection(
    connectionId: string,
    state: AzureDevOpsBindingState,
    stateReason: AzureDevOpsDegradedReason | null,
    fromReasons?: readonly AzureDevOpsDegradedReason[]
  ): Promise<number> {
    const reason = state === 'ready' ? null : stateReason
    const res = await this.prisma.azureDevOpsRepositoryBinding.updateMany({
      where: {
        connectionId,
        NOT: { state, stateReason: reason },
        ...(fromReasons ? { stateReason: { in: [...fromReasons] } } : {})
      },
      data: { state, stateReason: reason }
    })
    return res.count
  }

  async setState(
    bindingId: string,
    state: AzureDevOpsBindingState,
    stateReason: AzureDevOpsDegradedReason | null
  ): Promise<AzureDevOpsRepositoryBindingRecord | null> {
    const res = await this.prisma.azureDevOpsRepositoryBinding.updateMany({
      where: { id: bindingId },
      data: { state, stateReason: state === 'ready' ? null : stateReason }
    })
    if (res.count !== 1) return null
    const row = await this.prisma.azureDevOpsRepositoryBinding.findUnique({
      where: { id: bindingId },
      include: withIdentity
    })
    return row ? toBindingRecord(row) : null
  }

  async remove(orgId: string, bindingId: string): Promise<'removed' | 'referenced' | 'missing'> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.azureDevOpsRepositoryBinding.findFirst({
        where: { id: bindingId, orgId },
        select: { connectionId: true, identityId: true }
      })
      if (!target) return 'missing'
      await lockClaim(tx, orgId, target.identityId)
      // Exclusive against the referencing writes' FOR SHARE: a reference either committed and is counted, or finds the row gone.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "azure_devops_repository_binding" WHERE "id" = ${bindingId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      if (locked.length === 0) return 'missing'
      const workspaces = await tx.agent.count({
        where: { workspaceConnectionId: target.connectionId, workspaceRepoId: target.identityId }
      })
      const grants = await tx.agentRepoAuthorization.count({
        where: { connectionId: target.connectionId, repoId: target.identityId }
      })
      if (workspaces + grants > 0) return 'referenced'
      // The delete trigger releases the claim once no binding of the organization names the repository.
      await tx.azureDevOpsRepositoryBinding.delete({ where: { id: bindingId } })
      return 'removed'
    })
  }
}
