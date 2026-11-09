// Azure DevOps connections, repository identities and bindings (azure-devops-integration.md §3-§5); the claim is deployment-global, keyed by the surrogate id.
import type {
  AzureDevOpsConnection,
  AzureDevOpsHookSecret,
  AzureDevOpsHookSubscription,
  AzureDevOpsRepositoryBinding,
  AzureDevOpsRepositoryIdentity,
  Prisma,
  PrismaClient
} from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { AZURE_DEVOPS_DELIVERY_KINDS, type AzureDevOpsDeliveryKind } from '@agentconnect.md/protocol'
import { AzureDevOpsOrganizationTaken, AzureDevOpsRepositoryClaimConflict } from '../errors.js'
import { toDbHookKind } from '../hook-kind.js'
import type {
  AzureDevOpsBindingState,
  AzureDevOpsConnectionCredential,
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsConnectionSecretStore,
  AzureDevOpsConnectionState,
  AzureDevOpsCredentialSource,
  AzureDevOpsDegradedReason,
  AzureDevOpsHookKeys,
  AzureDevOpsHookReason,
  AzureDevOpsHookRepo,
  AzureDevOpsHookSubscriptionRecord,
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
    createdAt: r.createdAt,
    secretFingerprint: r.secretFingerprint
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
    credential: AzureDevOpsConnectionCredential
  }): Promise<AzureDevOpsConnectionRecord> {
    const { credential } = input
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
          secretFingerprint: 'secretFingerprint' in credential ? credential.secretFingerprint : null,
          ...identityFacts(input.identity)
        }
      })
      if ('sealedSecret' in credential) {
        await tx.azureDevOpsConnectionSecret.create({
          data: { connectionId: row.id, clientSecret: credential.sealedSecret }
        })
      }
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

  async advanceEpoch(connectionId: string, secretFingerprint: string): Promise<AzureDevOpsConnectionRecord | null> {
    const res = await this.prisma.azureDevOpsConnection.updateMany({
      where: { id: connectionId },
      data: { credentialEpoch: { increment: 1n }, secretFingerprint }
    })
    return res.count === 1 ? this.getUnscoped(connectionId) : null
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
    hookReason: toHookReason(r.hookReason),
    lastVerifiedDeliveryAt: r.lastVerifiedDeliveryAt,
    createdAt: r.createdAt
  }
}

const HOOK_REASONS: readonly AzureDevOpsHookReason[] = [
  'webhook_unverified',
  'triggers_not_allowed',
  'relay_url_unconfigured',
  'subscriptions_failed'
]

// An unknown persisted reason still reads as a failure, never as healthy.
function toHookReason(value: string | null): AzureDevOpsHookReason | null {
  if (value === null) return null
  return (HOOK_REASONS as readonly string[]).includes(value) ? (value as AzureDevOpsHookReason) : 'subscriptions_failed'
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
  }): Promise<{ binding: AzureDevOpsRepositoryBindingRecord; created: boolean; pathChanged: boolean }> {
    // Two first binds through one connection can still race on the catalog or binding row: the loser retries once and refreshes.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.bindOnce(input)
      } catch (e) {
        const unique = typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'P2002'
        if (!unique || attempt > 0) throw e
      }
    }
  }

  private async bindOnce(input: {
    orgId: string
    connectionId: string
    facts: AzureDevOpsRepositoryFacts
  }): Promise<{ binding: AzureDevOpsRepositoryBindingRecord; created: boolean; pathChanged: boolean }> {
    const { orgId, connectionId, facts } = input
    return this.prisma.$transaction(async (tx) => {
      // §4: allocated once per GUID, never reused; ON CONFLICT keeps two first binds from racing into a unique violation.
      const [allocated] = await tx.$queryRaw<{ id: bigint }[]>`
        INSERT INTO "azure_devops_repository_identity" ("repositoryId", "projectId", "organizationInstanceId", "createdAt", "updatedAt")
        VALUES (${facts.repositoryId}::uuid, ${facts.projectId}::uuid, ${facts.organizationInstanceId}::uuid, now(), now())
        ON CONFLICT ("repositoryId") DO UPDATE SET "projectId" = EXCLUDED."projectId", "updatedAt" = now()
        RETURNING "id"`
      const identity = { id: allocated!.id }
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
      const existing = await tx.azureDevOpsRepositoryBinding.findUnique({
        where: key,
        select: { id: true, repoPath: true, cloneUrl: true }
      })
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
      const pathChanged =
        existing !== null && (existing.repoPath !== facts.repoPath || existing.cloneUrl !== facts.cloneUrl)
      return { binding: toBindingRecord(row), created: existing === null, pathChanged }
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
        // A repository-level verdict is the picker's to clear; a connection-level change leaves it as it is.
        AND: [
          fromReasons
            ? { stateReason: { in: fromReasons.filter((r) => r !== 'repository_unavailable') } }
            : { OR: [{ stateReason: null }, { stateReason: { not: 'repository_unavailable' } }] }
        ]
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

  async listForRepo(orgId: string, repoId: bigint): Promise<AzureDevOpsRepositoryBindingRecord[]> {
    const rows = await this.prisma.azureDevOpsRepositoryBinding.findMany({
      where: { orgId, identityId: repoId },
      include: withIdentity,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBindingRecord)
  }

  async listForRepoUnscoped(repoId: bigint): Promise<AzureDevOpsRepositoryBindingRecord[]> {
    const rows = await this.prisma.azureDevOpsRepositoryBinding.findMany({
      where: { identityId: repoId },
      include: withIdentity,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBindingRecord)
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

// ── §11.2 service hooks: keys, recorded subscriptions, and the binding's hook state ──

const DELIVERY_KINDS: ReadonlySet<string> = new Set(AZURE_DEVOPS_DELIVERY_KINDS)

function toSubscriptionRecord(r: AzureDevOpsHookSubscription): AzureDevOpsHookSubscriptionRecord | null {
  // A kind this build does not know is left alone, as a subscription the Control Plane never made.
  if (!DELIVERY_KINDS.has(r.kind)) return null
  return {
    id: r.id,
    bindingId: r.bindingId,
    subscriptionId: r.subscriptionId,
    kind: r.kind as AzureDevOpsDeliveryKind,
    status: r.status,
    keyGeneration: r.keyGeneration
  }
}

export class PgAzureDevOpsHookRepo implements AzureDevOpsHookRepo {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: SecretCipher
  ) {}

  private async open(orgId: string, row: AzureDevOpsHookSecret): Promise<AzureDevOpsHookKeys> {
    const scope = orgScope(OrgId(orgId))
    return {
      current: await this.cipher.open(row.signingKey, scope),
      generation: row.keyGeneration,
      next: row.nextSigningKey === null ? null : await this.cipher.open(row.nextSigningKey, scope),
      previous: row.previousSigningKey === null ? null : await this.cipher.open(row.previousSigningKey, scope),
      previousExpiresAt: row.previousExpiresAt
    }
  }

  async keys(orgId: string, bindingId: string): Promise<AzureDevOpsHookKeys | null> {
    const row = await this.prisma.azureDevOpsHookSecret.findFirst({ where: { bindingId, binding: { orgId } } })
    return row ? this.open(orgId, row) : null
  }

  async ensureKeys(orgId: string, bindingId: string, current: string): Promise<AzureDevOpsHookKeys> {
    if ((await this.prisma.azureDevOpsRepositoryBinding.count({ where: { id: bindingId, orgId } })) === 0) {
      throw new Error('azure devops hook key write outside its organization')
    }
    const signingKey = await this.cipher.seal(current, orgScope(OrgId(orgId)))
    await this.prisma.azureDevOpsHookSecret.upsert({
      where: { bindingId },
      create: { bindingId, signingKey },
      update: {}
    })
    return (await this.keys(orgId, bindingId))!
  }

  async beginRotation(orgId: string, bindingId: string, next: string): Promise<AzureDevOpsHookKeys> {
    const sealed = await this.cipher.seal(next, orgScope(OrgId(orgId)))
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ nextSigningKey: string | null }>>`
        SELECT s."nextSigningKey" FROM "azure_devops_hook_secret" s
          JOIN "azure_devops_repository_binding" b ON b."id" = s."bindingId"
         WHERE s."bindingId" = ${bindingId}::uuid AND b."orgId" = ${orgId}
           FOR UPDATE OF s`
      const row = rows[0]
      if (!row) throw new Error('azure devops hook keys missing')
      // A rotation under way keeps its sealed key: no subscription is re-keyed twice under different secrets.
      if (row.nextSigningKey === null)
        await tx.azureDevOpsHookSecret.update({ where: { bindingId }, data: { nextSigningKey: sealed } })
    })
    return (await this.keys(orgId, bindingId))!
  }

  async promoteIfSwitched(
    orgId: string,
    bindingId: string,
    previousExpiresAt: Date
  ): Promise<AzureDevOpsHookKeys | null> {
    const promoted = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<AzureDevOpsHookSecret[]>`
        SELECT s.* FROM "azure_devops_hook_secret" s
          JOIN "azure_devops_repository_binding" b ON b."id" = s."bindingId"
         WHERE s."bindingId" = ${bindingId}::uuid AND b."orgId" = ${orgId}
           FOR UPDATE OF s`
      const row = rows[0]
      if (!row || row.nextSigningKey === null) return false
      const nextGeneration = BigInt(row.keyGeneration) + 1n
      // The barrier: there is a recorded subscription, and every one acknowledged the next key.
      const total = await tx.azureDevOpsHookSubscription.count({ where: { bindingId } })
      const behind = await tx.azureDevOpsHookSubscription.count({
        where: { bindingId, keyGeneration: { lt: nextGeneration } }
      })
      if (total === 0 || behind > 0) return false
      await tx.azureDevOpsHookSecret.update({
        where: { bindingId },
        data: {
          signingKey: row.nextSigningKey,
          keyGeneration: nextGeneration,
          nextSigningKey: null,
          // The old key verifies queued retries until it expires.
          previousSigningKey: row.signingKey,
          previousExpiresAt
        }
      })
      return true
    })
    return promoted ? this.keys(orgId, bindingId) : null
  }

  async dropExpiredPrevious(orgId: string, bindingId: string, now: Date): Promise<boolean> {
    const res = await this.prisma.azureDevOpsHookSecret.updateMany({
      where: { bindingId, binding: { orgId }, previousExpiresAt: { lte: now } },
      data: { previousSigningKey: null, previousExpiresAt: null }
    })
    return res.count > 0
  }

  async deleteKeys(orgId: string, bindingId: string): Promise<void> {
    await this.prisma.azureDevOpsHookSecret.deleteMany({ where: { bindingId, binding: { orgId } } })
  }

  async subscriptions(bindingId: string): Promise<AzureDevOpsHookSubscriptionRecord[]> {
    const rows = await this.prisma.azureDevOpsHookSubscription.findMany({
      where: { bindingId },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toSubscriptionRecord).filter((row): row is AzureDevOpsHookSubscriptionRecord => row !== null)
  }

  async recordSubscription(input: {
    bindingId: string
    subscriptionId: string
    kind: AzureDevOpsDeliveryKind
    status: string | null
    keyGeneration: bigint
  }): Promise<AzureDevOpsHookSubscriptionRecord> {
    const row = await this.prisma.azureDevOpsHookSubscription.create({
      data: {
        bindingId: input.bindingId,
        subscriptionId: input.subscriptionId.toLowerCase(),
        kind: input.kind,
        status: input.status,
        keyGeneration: input.keyGeneration
      }
    })
    return toSubscriptionRecord(row)!
  }

  async updateSubscription(id: string, patch: { status?: string | null; keyGeneration?: bigint }): Promise<void> {
    await this.prisma.azureDevOpsHookSubscription.updateMany({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.keyGeneration !== undefined ? { keyGeneration: patch.keyGeneration } : {})
      }
    })
  }

  async removeSubscription(id: string): Promise<void> {
    await this.prisma.azureDevOpsHookSubscription.deleteMany({ where: { id } })
  }

  async setHookState(
    bindingId: string,
    patch: { hookReason?: AzureDevOpsHookReason | null; lastVerifiedDeliveryAt?: Date | null }
  ): Promise<void> {
    await this.prisma.azureDevOpsRepositoryBinding.updateMany({
      where: { id: bindingId },
      data: {
        ...(patch.hookReason !== undefined ? { hookReason: patch.hookReason } : {}),
        ...(patch.lastVerifiedDeliveryAt !== undefined ? { lastVerifiedDeliveryAt: patch.lastVerifiedDeliveryAt } : {})
      }
    })
  }

  async acquireLease(bindingId: string, owner: string, until: Date, now: Date): Promise<boolean> {
    const res = await this.prisma.azureDevOpsRepositoryBinding.updateMany({
      where: { id: bindingId, OR: [{ hookLeaseUntil: null }, { hookLeaseUntil: { lt: now } }] },
      data: { hookLeaseOwner: owner, hookLeaseUntil: until }
    })
    return res.count === 1
  }

  async releaseLease(bindingId: string, owner: string): Promise<void> {
    await this.prisma.azureDevOpsRepositoryBinding.updateMany({
      where: { id: bindingId, hookLeaseOwner: owner },
      data: { hookLeaseOwner: null, hookLeaseUntil: null }
    })
  }

  async markConvergeOwed(bindingId: string, at: Date | null): Promise<void> {
    await this.prisma.azureDevOpsRepositoryBinding.updateMany({
      where: { id: bindingId },
      data: { hookConvergeOwedAt: at }
    })
  }

  async listHooked(limit: number): Promise<AzureDevOpsRepositoryBindingRecord[]> {
    // An enabled hook keeps its repository in the sweep even with no subscriptions yet, so a repaired configuration recovers.
    const hooked = await this.prisma.hookDef.findMany({
      where: { kind: toDbHookKind('azure-devops'), enabled: true, repoId: { not: null } },
      select: { orgId: true, repoId: true },
      distinct: ['orgId', 'repoId']
    })
    const rows = await this.prisma.azureDevOpsRepositoryBinding.findMany({
      where: {
        OR: [
          { subscriptions: { some: {} } },
          { hookConvergeOwedAt: { not: null } },
          ...hooked.map((hook) => ({ orgId: hook.orgId, identityId: hook.repoId! }))
        ]
      },
      include: withIdentity,
      orderBy: [{ updatedAt: 'asc' }],
      take: limit
    })
    return rows.map(toBindingRecord)
  }
}
