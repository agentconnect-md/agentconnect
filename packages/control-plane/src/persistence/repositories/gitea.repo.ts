/**
 * Gitea connection and repository binding persistence (gitea-integration.md §4, §5, §6).
 *
 * Three stores: the organization's bot connection with its sealed token (SecretCipher, per-org
 * scope — BotSecret discipline), the managed repository bindings over the deployment-global
 * `CodeHostRepositoryClaim`, and the sealed webhook signing keys. The claim lease, cleanup and
 * removal transitions are the GitLab binding's, keyed on provider `gitea`.
 */
import type { GiteaConnection, GiteaRepositoryBinding, PrismaClient } from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { GiteaBotAlreadyBound, GiteaConnectionExists, GiteaRepositoryClaimConflict } from '../errors.js'
import type {
  GiteaBindingState,
  GiteaConnectionRecord,
  GiteaConnectionRepo,
  GiteaConnectionSecretStore,
  GiteaConnectionState,
  GiteaRepositoryBindingRecord,
  GiteaRepositoryBindingRepo,
  GiteaVerifiedBot,
  GiteaWebhookSecretStore,
  GiteaWebhookSigningKeys
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { OrgId } from '../../domain/ids.js'
import { joinGiteaAxisFence } from './gitea-axis.js'

const CONNECTION_STATES: readonly GiteaConnectionState[] = ['connected', 'token_rejected', 'disconnecting']

/** An unknown persisted state fails toward "needs a replacement token", never toward connected. */
function toConnectionState(value: string): GiteaConnectionState {
  return (CONNECTION_STATES as readonly string[]).includes(value) ? (value as GiteaConnectionState) : 'token_rejected'
}

function toConnectionRecord(r: GiteaConnection): GiteaConnectionRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    createdByUserId: r.createdByUserId,
    botUserId: r.botUserId,
    botUsername: r.botUsername,
    botDisplayName: r.botDisplayName,
    credentialEpoch: r.credentialEpoch,
    instanceVersion: r.instanceVersion,
    state: toConnectionState(r.state),
    lastVerifiedAt: r.lastVerifiedAt,
    createdAt: r.createdAt
  }
}

function botFacts(bot: GiteaVerifiedBot) {
  return {
    botUsername: bot.botUsername,
    botDisplayName: bot.botDisplayName,
    instanceVersion: bot.instanceVersion,
    lastVerifiedAt: bot.verifiedAt
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

export class PgGiteaConnectionRepo implements GiteaConnectionRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: {
    orgId: string
    createdByUserId?: string
    bot: GiteaVerifiedBot
    sealedToken: string
    axisBaseUrl: string
  }): Promise<GiteaConnectionRecord> {
    try {
      // Metadata and the sealed token land in ONE transaction: no reader sees a connected row without its token.
      return await this.prisma.$transaction(async (tx) => {
        await joinGiteaAxisFence(tx, input.axisBaseUrl)
        // One connection per organization (§4.1); the bot-user uniqueness is the index's below.
        if ((await tx.giteaConnection.count({ where: { orgId: input.orgId } })) > 0) throw new GiteaConnectionExists()
        const row = await tx.giteaConnection.create({
          data: {
            orgId: input.orgId,
            createdByUserId: input.createdByUserId ?? null,
            botUserId: input.bot.botUserId,
            state: 'connected',
            ...botFacts(input.bot)
          }
        })
        await tx.giteaConnectionSecret.create({ data: { connectionId: row.id, token: input.sealedToken } })
        return toConnectionRecord(row)
      })
    } catch (e) {
      if (isUniqueViolation(e)) throw new GiteaBotAlreadyBound()
      throw e
    }
  }

  async get(orgId: string, connectionId: string): Promise<GiteaConnectionRecord | null> {
    const row = await this.prisma.giteaConnection.findFirst({ where: { id: connectionId, orgId } })
    return row ? toConnectionRecord(row) : null
  }

  async forOrg(orgId: string): Promise<GiteaConnectionRecord | null> {
    const row = await this.prisma.giteaConnection.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } })
    return row ? toConnectionRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<GiteaConnectionRecord[]> {
    const rows = await this.prisma.giteaConnection.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toConnectionRecord)
  }

  async byBotUserId(botUserId: bigint): Promise<GiteaConnectionRecord | null> {
    const row = await this.prisma.giteaConnection.findUnique({ where: { botUserId } })
    return row ? toConnectionRecord(row) : null
  }

  async replaceToken(
    orgId: string,
    connectionId: string,
    bot: GiteaVerifiedBot,
    sealedToken: string
  ): Promise<GiteaConnectionRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      // The same bot only (§4.3): the numeric user id is the identity a replacement must keep.
      const res = await tx.giteaConnection.updateMany({
        where: { id: connectionId, orgId, botUserId: bot.botUserId },
        data: { ...botFacts(bot), state: 'connected', credentialEpoch: { increment: 1n } }
      })
      if (res.count !== 1) return null
      await tx.giteaConnectionSecret.upsert({
        where: { connectionId },
        create: { connectionId, token: sealedToken },
        update: { token: sealedToken }
      })
      const row = await tx.giteaConnection.findUniqueOrThrow({ where: { id: connectionId } })
      return toConnectionRecord(row)
    })
  }

  async update(
    orgId: string,
    connectionId: string,
    patch: Partial<{ state: GiteaConnectionState; instanceVersion: string | null; lastVerifiedAt: Date | null }>
  ): Promise<GiteaConnectionRecord | null> {
    const res = await this.prisma.giteaConnection.updateMany({ where: { id: connectionId, orgId }, data: patch })
    if (res.count !== 1) return null
    return this.get(orgId, connectionId)
  }

  async remove(orgId: string, connectionId: string): Promise<'removed' | 'blocked' | 'missing'> {
    // Lock, count, delete in ONE transaction: a binding created meanwhile waits on the row lock and then fails its key.
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "gitea_connection" WHERE "id" = ${connectionId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      if (locked.length === 0) return 'missing'
      if ((await tx.giteaRepositoryBinding.count({ where: { orgId, connectionId } })) > 0) return 'blocked'
      await tx.giteaConnection.delete({ where: { id: connectionId } })
      return 'removed'
    })
  }
}

export class PgGiteaConnectionSecretStore implements GiteaConnectionSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async get(orgId: string, connectionId: string): Promise<string | null> {
    const row = await this.db.giteaConnectionSecret.findFirst({ where: { connectionId, connection: { orgId } } })
    return row ? this.cipher.open(row.token, orgScope(OrgId(orgId))) : null
  }
}

// ── §5/§6 repository bindings ────────────────────────────────────────────────

const BINDING_STATES: readonly GiteaBindingState[] = [
  'provisioning',
  'ready',
  'admin_degraded',
  'runtime_degraded',
  'cleanup_pending'
]

/** Unknown persisted state fails toward "needs runtime repair", never toward ready. */
function toBindingState(value: string): GiteaBindingState {
  return (BINDING_STATES as readonly string[]).includes(value) ? (value as GiteaBindingState) : 'runtime_degraded'
}

function toBindingRecord(r: GiteaRepositoryBinding): GiteaRepositoryBindingRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    connectionId: r.connectionId,
    repoId: r.repoId,
    repoPath: r.repoPath,
    cloneUrl: r.cloneUrl,
    defaultBranch: r.defaultBranch,
    webhookId: r.webhookId,
    desiredEventsHash: r.desiredEventsHash,
    lastVerifiedDeliveryAt: r.lastVerifiedDeliveryAt,
    convergeOwedAt: r.convergeOwedAt,
    state: toBindingState(r.state),
    stateReason: r.stateReason,
    createdAt: r.createdAt
  }
}

/** The binding states a rejected token degrades; cleanup keeps its own obligation. */
const DEGRADABLE_STATES: readonly GiteaBindingState[] = ['provisioning', 'ready', 'admin_degraded', 'runtime_degraded']

export class PgGiteaRepositoryBindingRepo implements GiteaRepositoryBindingRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async createWithClaim(input: {
    orgId: string
    connectionId: string
    repoId: bigint
    repoPath: string
    cloneUrl?: string
    defaultBranch?: string
    axisBaseUrl: string
  }): Promise<GiteaRepositoryBindingRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The claim and the numeric repository id are host-relative, so they join the §3 axis fence.
        await joinGiteaAxisFence(tx, input.axisBaseUrl)
        // The deployment-global single-owner claim (§6 step 1): a uniqueness loser aborts before any provider write.
        const claim = await tx.codeHostRepositoryClaim.create({
          data: { provider: 'gitea', externalId: input.repoId, orgId: input.orgId, state: 'provisioning' }
        })
        await tx.codeHostRepository.upsert({
          where: { orgId_provider_externalId: { orgId: input.orgId, provider: 'gitea', externalId: input.repoId } },
          create: {
            orgId: input.orgId,
            provider: 'gitea',
            externalId: input.repoId,
            displayPath: input.repoPath,
            cloneUrl: input.cloneUrl ?? null,
            defaultBranch: input.defaultBranch ?? null
          },
          update: {
            displayPath: input.repoPath,
            ...(input.cloneUrl !== undefined ? { cloneUrl: input.cloneUrl } : {}),
            ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {})
          }
        })
        const binding = await tx.giteaRepositoryBinding.create({
          data: {
            orgId: input.orgId,
            connectionId: input.connectionId,
            repoId: input.repoId,
            repoPath: input.repoPath,
            cloneUrl: input.cloneUrl ?? null,
            defaultBranch: input.defaultBranch ?? null,
            state: 'provisioning'
          }
        })
        await tx.codeHostRepositoryClaim.update({ where: { id: claim.id }, data: { bindingRef: binding.id } })
        return toBindingRecord(binding)
      })
    } catch (e) {
      if (isUniqueViolation(e)) throw new GiteaRepositoryClaimConflict(input.repoId)
      throw e
    }
  }

  async get(orgId: string, bindingId: string): Promise<GiteaRepositoryBindingRecord | null> {
    const row = await this.prisma.giteaRepositoryBinding.findFirst({ where: { id: bindingId, orgId } })
    return row ? toBindingRecord(row) : null
  }

  async byRepo(orgId: string, repoId: bigint): Promise<GiteaRepositoryBindingRecord | null> {
    const row = await this.prisma.giteaRepositoryBinding.findUnique({ where: { orgId_repoId: { orgId, repoId } } })
    return row ? toBindingRecord(row) : null
  }

  async byRepoPath(orgId: string, repoPath: string): Promise<GiteaRepositoryBindingRecord | null> {
    const row = await this.prisma.giteaRepositoryBinding.findFirst({
      where: { orgId, repoPath: { equals: repoPath, mode: 'insensitive' } }
    })
    return row ? toBindingRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<GiteaRepositoryBindingRecord[]> {
    const rows = await this.prisma.giteaRepositoryBinding.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toBindingRecord)
  }

  async listForConnection(orgId: string, connectionId: string): Promise<GiteaRepositoryBindingRecord[]> {
    const rows = await this.prisma.giteaRepositoryBinding.findMany({
      where: { orgId, connectionId },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBindingRecord)
  }

  async update(
    orgId: string,
    bindingId: string,
    patch: Partial<{
      repoPath: string
      cloneUrl: string | null
      defaultBranch: string | null
      webhookId: bigint | null
      desiredEventsHash: string | null
      lastVerifiedDeliveryAt: Date | null
      convergeOwedAt: Date | null
      state: GiteaBindingState
      stateReason: string | null
    }>
  ): Promise<GiteaRepositoryBindingRecord | null> {
    const res = await this.prisma.giteaRepositoryBinding.updateMany({ where: { id: bindingId, orgId }, data: patch })
    if (res.count !== 1) return null
    return this.get(orgId, bindingId)
  }

  async degradeForConnection(orgId: string, connectionId: string, reason: string): Promise<number> {
    const res = await this.prisma.giteaRepositoryBinding.updateMany({
      where: { orgId, connectionId, state: { in: [...DEGRADABLE_STATES] } },
      // A settled verdict asking for a replacement token owes no automatic convergence any more.
      data: { state: 'runtime_degraded', stateReason: reason, convergeOwedAt: null }
    })
    return res.count
  }

  async markDeliveryVerified(orgId: string, repoId: bigint, at: Date): Promise<GiteaRepositoryBindingRecord | null> {
    const res = await this.prisma.giteaRepositoryBinding.updateMany({
      where: { orgId, repoId },
      data: { lastVerifiedDeliveryAt: at }
    })
    if (res.count !== 1) return null
    return this.byRepo(orgId, repoId)
  }

  async markConvergeOwed(orgId: string, bindingId: string, at: Date): Promise<void> {
    // Lock the claim first, in cleanup's own order, so an obligation never lands on a claim cleanup just flipped.
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.$queryRaw<{ state: string }[]>`
        SELECT c."state" FROM "code_host_repository_claim" AS c
          JOIN "gitea_repository_binding" AS b
            ON c."externalId" = b."repoId" AND c."bindingRef" = b."id"
         WHERE c."provider" = 'gitea' AND b."id" = ${bindingId}::uuid AND b."orgId" = ${orgId}
           FOR UPDATE OF c`
      const state = claim[0]?.state
      if (state !== 'provisioning' && state !== 'active') return
      await tx.giteaRepositoryBinding.updateMany({ where: { id: bindingId, orgId }, data: { convergeOwedAt: at } })
    })
  }

  async listConvergeOwed(before: Date, limit: number): Promise<GiteaRepositoryBindingRecord[]> {
    const rows = await this.prisma.giteaRepositoryBinding.findMany({
      orderBy: { convergeOwedAt: 'asc' },
      where: { convergeOwedAt: { not: null, lt: before }, state: { not: 'cleanup_pending' } },
      take: limit
    })
    return rows.map(toBindingRecord)
  }

  async markProviderMutationStarted(
    orgId: string,
    bindingId: string,
    repoId: bigint,
    owner: string,
    until: Date,
    now: Date
  ): Promise<boolean> {
    // EXCLUSIVE run-owned lease, CAS-acquired: free, same-owner, or expired — never a live foreign lease.
    const res = await this.prisma.codeHostRepositoryClaim.updateMany({
      where: {
        provider: 'gitea',
        externalId: repoId,
        orgId,
        bindingRef: bindingId,
        state: { in: ['provisioning', 'active'] },
        OR: [{ opOwner: null }, { opOwner: owner }, { opLeaseUntil: { lt: now } }]
      },
      data: { state: 'active', opOwner: owner, opLeaseUntil: until }
    })
    return res.count === 1
  }

  async endProviderMutation(orgId: string, bindingId: string, repoId: bigint, owner: string): Promise<void> {
    await this.prisma.codeHostRepositoryClaim.updateMany({
      where: { provider: 'gitea', externalId: repoId, orgId, bindingRef: bindingId, opOwner: owner },
      data: { opOwner: null, opLeaseUntil: null }
    })
  }

  async renewProviderLease(
    orgId: string,
    bindingId: string,
    repoId: bigint,
    owner: string,
    until: Date
  ): Promise<boolean> {
    const res = await this.prisma.codeHostRepositoryClaim.updateMany({
      where: { provider: 'gitea', externalId: repoId, orgId, bindingRef: bindingId, state: 'active', opOwner: owner },
      data: { opLeaseUntil: until }
    })
    return res.count === 1
  }

  async beginCleanup(orgId: string, bindingId: string, repoId: bigint, now: Date): Promise<boolean> {
    const attached = await this.prisma.codeHostRepositoryClaim.count({
      where: { provider: 'gitea', externalId: repoId, orgId, bindingRef: bindingId }
    })
    if (attached === 0) {
      await this.prisma.giteaRepositoryBinding.updateMany({
        where: { id: bindingId, orgId },
        data: { convergeOwedAt: null }
      })
      return true
    }
    // The claim flip and the convergence discharge are ONE transaction; a live lease refuses.
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.codeHostRepositoryClaim.updateMany({
        where: {
          provider: 'gitea',
          externalId: repoId,
          orgId,
          bindingRef: bindingId,
          OR: [{ opOwner: null }, { opLeaseUntil: { lt: now } }]
        },
        data: { state: 'cleanup_pending', opOwner: null, opLeaseUntil: null }
      })
      if (res.count !== 1) return false
      await tx.giteaRepositoryBinding.updateMany({ where: { id: bindingId, orgId }, data: { convergeOwedAt: null } })
      return true
    })
  }

  async removeWithClaim(orgId: string, bindingId: string, repoId: bigint): Promise<boolean> {
    // Claim FIRST: the delete trigger would otherwise preserve it as cleanup_pending, which verified cleanup has earned releasing.
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.giteaRepositoryBinding.count({ where: { id: bindingId, orgId } })
      if (owned !== 1) return false
      await tx.codeHostRepositoryClaim.deleteMany({
        where: { provider: 'gitea', externalId: repoId, orgId, bindingRef: bindingId }
      })
      await tx.giteaRepositoryBinding.deleteMany({ where: { id: bindingId, orgId } })
      return true
    })
  }
}

export class PgGiteaWebhookSecretStore implements GiteaWebhookSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: string, bindingId: string, keys: GiteaWebhookSigningKeys): Promise<void> {
    if ((await this.db.giteaRepositoryBinding.count({ where: { id: bindingId, orgId } })) === 0) {
      throw new Error('gitea webhook secret write outside its organization')
    }
    const scope = orgScope(OrgId(orgId))
    const sealed = {
      signingKey: await this.cipher.seal(keys.current, scope),
      nextSigningKey: keys.next === null ? null : await this.cipher.seal(keys.next, scope)
    }
    await this.db.giteaWebhookSecret.upsert({ where: { bindingId }, create: { bindingId, ...sealed }, update: sealed })
  }

  async get(orgId: string, bindingId: string): Promise<GiteaWebhookSigningKeys | null> {
    const row = await this.db.giteaWebhookSecret.findFirst({ where: { bindingId, binding: { orgId } } })
    if (!row) return null
    const scope = orgScope(OrgId(orgId))
    return {
      current: await this.cipher.open(row.signingKey, scope),
      next: row.nextSigningKey === null ? null : await this.cipher.open(row.nextSigningKey, scope)
    }
  }

  async delete(orgId: string, bindingId: string): Promise<void> {
    await this.db.giteaWebhookSecret.deleteMany({ where: { bindingId, binding: { orgId } } })
  }
}
