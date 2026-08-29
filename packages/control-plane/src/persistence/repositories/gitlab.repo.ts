/**
 * GitLab.com OAuth connection persistence (gitlab-com-integration.md §8.2, §9).
 *
 * Three stores: connection metadata, the sealed token pair (SecretCipher,
 * per-org scope — BotSecret discipline), and the one-shot OAuth state whose
 * consume is an atomic delete-returning read. Refresh coordination is data
 * here, policy in the service: a short lease row claim plus a tokenVersion CAS.
 */
import type {
  GitlabAgentAccount,
  GitlabConnection,
  GitlabProjectBinding,
  GitlabProjectCredential,
  PrismaClient
} from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { GitlabMembershipGone, GitlabProjectClaimConflict } from '../errors.js'
import { GITLAB_CREATION_FORBIDDEN_STATE } from '../ports.js'
import type {
  GitlabAccountConsumer,
  GitlabProjectConsumer,
  GitlabAccountMembershipRecord,
  GitlabAccountState,
  GitlabAgentAccountRecord,
  GitlabAgentAccountRepo,
  GitlabBindingState,
  GitlabConnectionRecord,
  GitlabConnectionRepo,
  GitlabConnectionRemoval,
  GitlabConnectionSecretStore,
  GitlabConnectionState,
  GitlabCredentialPurpose,
  GitlabInstanceStateRecord,
  GitlabInstanceStateRepo,
  GitlabOauthStateRecord,
  GitlabOauthStateStore,
  GitlabProjectBindingRecord,
  GitlabProjectBindingRepo,
  GitlabProjectCredentialRecord,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore,
  GitlabSealedTokenPair,
  GitlabWebhookSecretStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { OrgId } from '../../domain/ids.js'
import {
  GITLAB_ACCESS_DEVELOPER as ACCESS_DEVELOPER,
  gitlabAuthorizationAccessLevel,
  gitlabWorkspaceAccessLevel
} from '../../gitlab/api.js'
import { joinAxisFence } from './gitlab-axis.js'

const CONNECTION_STATES: readonly GitlabConnectionState[] = ['connected', 'reauth_required', 'disconnected']

function toState(value: string): GitlabConnectionState {
  // Fail closed on an unknown persisted state: administration stops until repaired.
  return (CONNECTION_STATES as readonly string[]).includes(value) ? (value as GitlabConnectionState) : 'reauth_required'
}

function toRecord(r: GitlabConnection): GitlabConnectionRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    gitlabUserId: r.gitlabUserId,
    gitlabUsername: r.gitlabUsername,
    scopes: r.scopes,
    accessExpiresAt: r.accessExpiresAt,
    state: toState(r.state),
    tokenVersion: r.tokenVersion,
    lastSyncAt: r.lastSyncAt,
    createdAt: r.createdAt
  }
}

export class PgGitlabConnectionRepo implements GitlabConnectionRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertOnCallback(input: {
    orgId: string
    userId: string
    gitlabUserId: bigint
    gitlabUsername: string
    scopes: string[]
    accessExpiresAt: Date | null
    sealedPair: GitlabSealedTokenPair
    axisBaseUrl: string
  }): Promise<GitlabConnectionRecord> {
    const facts = {
      userId: input.userId,
      gitlabUsername: input.gitlabUsername,
      scopes: input.scopes,
      accessExpiresAt: input.accessExpiresAt,
      state: 'connected',
      lastSyncAt: new Date()
    }
    // Metadata and the sealed pair land in ONE transaction: no reader can see a
    // connected row whose side-table pair is absent or stale.
    return this.prisma.$transaction(async (tx) => {
      // §24.1: this pair was minted on one instance and carries no provenance,
      // so it may not land after the axis moved under it.
      await joinAxisFence(tx, input.axisBaseUrl)
      // §9.4, serialized: FOR SHARE pins the membership row for the length of
      // this transaction, so a concurrent removal either waits for this commit
      // (and its trigger then disconnects the fresh row) or wins first (and
      // this locked read finds nothing) — a deterministic winner either way.
      const membership = await tx.$queryRaw<{ userId: string }[]>`
        SELECT "userId" FROM "membership"
         WHERE "orgId" = ${input.orgId} AND "userId" = ${input.userId} FOR SHARE`
      if (membership.length === 0) throw new GitlabMembershipGone()
      const row = await tx.gitlabConnection.upsert({
        where: { orgId_gitlabUserId: { orgId: input.orgId, gitlabUserId: input.gitlabUserId } },
        create: { orgId: input.orgId, gitlabUserId: input.gitlabUserId, ...facts },
        // Reconnect rotates the pair, so the version advances and any in-flight
        // refresh CAS on the old version loses.
        update: { ...facts, tokenVersion: { increment: 1n } }
      })
      await tx.gitlabConnectionSecret.upsert({
        where: { connectionId: row.id },
        create: { connectionId: row.id, ...input.sealedPair },
        update: input.sealedPair
      })
      return toRecord(row)
    })
  }

  async get(orgId: string, connectionId: string): Promise<GitlabConnectionRecord | null> {
    const row = await this.prisma.gitlabConnection.findFirst({ where: { id: connectionId, orgId } })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<GitlabConnectionRecord[]> {
    const rows = await this.prisma.gitlabConnection.findMany({ orderBy: { createdAt: 'asc' }, where: { orgId } })
    return rows.map(toRecord)
  }

  async markReauthRequired(connectionId: string, expectedVersion: bigint): Promise<boolean> {
    const res = await this.prisma.gitlabConnection.updateMany({
      where: { id: connectionId, tokenVersion: expectedVersion },
      data: { state: 'reauth_required' }
    })
    return res.count === 1
  }

  async disconnect(orgId: string, connectionId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.gitlabConnection.updateMany({
        where: { id: connectionId, orgId },
        // The version bump defeats any in-flight refresh CAS, so a raced refresh
        // cannot resurrect the pair this transaction deletes.
        data: { state: 'disconnected', tokenVersion: { increment: 1n } }
      })
      if (res.count !== 1) return false
      await tx.gitlabConnectionSecret.deleteMany({ where: { connectionId } })
      return true
    })
  }

  async remove(orgId: string, connectionId: string): Promise<GitlabConnectionRemoval> {
    // Lock, check, delete in ONE transaction (§9.4). FOR UPDATE conflicts with the
    // FOR KEY SHARE that inserting a binding takes on its installer, so a racing
    // project create either commits first and is counted, or waits and then fails
    // its foreign key — it can never be silently detached by ON DELETE SET NULL.
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ state: string }[]>`
        SELECT "state" FROM "gitlab_connection"
         WHERE "id" = ${connectionId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      if (locked.length === 0) return { outcome: 'missing' }
      if (locked[0]!.state !== 'disconnected') return { outcome: 'not_disconnected' }
      const assignedProjects = await tx.gitlabProjectBinding.count({
        where: { orgId, installerConnectionId: connectionId }
      })
      if (assignedProjects > 0) return { outcome: 'blocked', assignedProjects }
      await tx.gitlabConnection.delete({ where: { id: connectionId } })
      return { outcome: 'removed' }
    })
  }

  async claimRefreshLease(connectionId: string, owner: string, until: Date, now: Date): Promise<boolean> {
    const res = await this.prisma.gitlabConnection.updateMany({
      where: {
        id: connectionId,
        OR: [
          { refreshLeaseOwner: null },
          { refreshLeaseOwner: owner },
          { refreshLeaseUntil: { lt: now } } // an expired lease is claimable (crash recovery)
        ]
      },
      data: { refreshLeaseOwner: owner, refreshLeaseUntil: until }
    })
    return res.count === 1
  }

  async releaseRefreshLease(connectionId: string, owner: string): Promise<void> {
    await this.prisma.gitlabConnection.updateMany({
      where: { id: connectionId, refreshLeaseOwner: owner },
      data: { refreshLeaseOwner: null, refreshLeaseUntil: null }
    })
  }

  async commitRefresh(
    connectionId: string,
    expectedVersion: bigint,
    accessExpiresAt: Date | null,
    sealedPair: GitlabSealedTokenPair
  ): Promise<boolean> {
    // CAS and the sealed pair commit together or not at all: success is only
    // ever published with the matching tokens already in place.
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.gitlabConnection.updateMany({
        where: { id: connectionId, tokenVersion: expectedVersion, state: 'connected' },
        data: { tokenVersion: { increment: 1n }, accessExpiresAt, state: 'connected' }
      })
      if (res.count !== 1) return false
      await tx.gitlabConnectionSecret.upsert({
        where: { connectionId },
        create: { connectionId, ...sealedPair },
        update: sealedPair
      })
      return true
    })
  }
}

export class PgGitlabConnectionSecretStore implements GitlabConnectionSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async get(orgId: string, connectionId: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    const row = await this.db.gitlabConnectionSecret.findFirst({
      where: { connectionId, connection: { orgId } }
    })
    if (!row) return null
    const scope = orgScope(OrgId(orgId))
    return {
      accessToken: await this.cipher.open(row.accessToken, scope),
      refreshToken: await this.cipher.open(row.refreshToken, scope)
    }
  }
}

export class PgGitlabOauthStateStore implements GitlabOauthStateStore {
  constructor(private readonly prisma: PrismaClient) {}

  async put(input: Omit<GitlabOauthStateRecord, 'browserHash'>): Promise<void> {
    await this.prisma.gitlabOauthState.create({
      data: {
        nonce: input.nonce,
        orgId: input.orgId,
        userId: input.userId,
        returnPath: input.returnPath,
        verifier: input.verifier,
        expiresAt: input.expiresAt
      }
    })
  }

  async bindBrowser(nonce: string, browserHash: string, now: Date): Promise<GitlabOauthStateRecord | null> {
    // Exactly-once stamp: a second begin hop (or a replayed link) finds the hash
    // set and gets nothing — the flow must be restarted, never re-bound.
    const res = await this.prisma.gitlabOauthState.updateMany({
      where: { nonce, browserHash: null, expiresAt: { gt: now } },
      data: { browserHash }
    })
    if (res.count !== 1) return null
    return this.prisma.gitlabOauthState.findUnique({ where: { nonce } })
  }

  async consume(nonce: string, now: Date): Promise<GitlabOauthStateRecord | null> {
    // Atomic single-use: the delete IS the consumption; a raced second callback
    // deletes nothing and returns null.
    try {
      const row = await this.prisma.gitlabOauthState.delete({ where: { nonce } })
      return row.expiresAt > now ? row : null
    } catch {
      return null
    }
  }
}

// ── §24.2 the observed instance version ──────────────────────────────────────

export class PgGitlabInstanceStateStore implements GitlabInstanceStateRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: GitlabInstanceStateRecord): Promise<void> {
    const observed = { version: input.version, enterprise: input.enterprise, observedAt: input.observedAt }
    await this.prisma.gitlabInstanceState.upsert({
      where: { baseUrl: input.baseUrl },
      create: { baseUrl: input.baseUrl, ...observed },
      update: observed
    })
  }

  get(baseUrl: string): Promise<GitlabInstanceStateRecord | null> {
    return this.prisma.gitlabInstanceState.findUnique({
      where: { baseUrl },
      select: { baseUrl: true, version: true, enterprise: true, observedAt: true }
    })
  }
}

// ── §8.2/§10 project bindings ────────────────────────────────────────────────

const BINDING_STATES: readonly GitlabBindingState[] = [
  'provisioning',
  'ready',
  'admin_degraded',
  'runtime_degraded',
  'cleanup_pending'
]

function toBindingState(value: string): GitlabBindingState {
  // Unknown persisted state fails toward "needs runtime repair", never toward ready.
  return (BINDING_STATES as readonly string[]).includes(value) ? (value as GitlabBindingState) : 'runtime_degraded'
}

function toBindingRecord(r: GitlabProjectBinding): GitlabProjectBindingRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    projectPath: r.projectPath,
    defaultBranch: r.defaultBranch,
    installerConnectionId: r.installerConnectionId,
    webhookId: r.webhookId,
    desiredEventsHash: r.desiredEventsHash,
    credentialEpoch: r.credentialEpoch,
    convergeOwedAt: r.convergeOwedAt,
    state: toBindingState(r.state),
    stateReason: r.stateReason,
    createdAt: r.createdAt
  }
}

export class PgGitlabProjectBindingRepo implements GitlabProjectBindingRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async createWithClaim(input: {
    orgId: string
    projectId: bigint
    projectPath: string
    defaultBranch?: string
    cloneUrl?: string
    installerConnectionId: string
    axisBaseUrl: string
  }): Promise<GitlabProjectBindingRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // §24.1: the claim and the numeric project id are host-relative, so they
        // may not land after the axis moved under this operation.
        await joinAxisFence(tx, input.axisBaseUrl)
        // The deployment-global single-owner claim (§8.1): the unique
        // (provider, externalId) insert selects one winner BEFORE any provider
        // mutation may begin; a loser aborts the whole transaction.
        const claim = await tx.codeHostRepositoryClaim.create({
          data: { provider: 'gitlab', externalId: input.projectId, orgId: input.orgId, state: 'provisioning' }
        })
        await tx.codeHostRepository.upsert({
          where: {
            orgId_provider_externalId: { orgId: input.orgId, provider: 'gitlab', externalId: input.projectId }
          },
          create: {
            orgId: input.orgId,
            provider: 'gitlab',
            externalId: input.projectId,
            displayPath: input.projectPath,
            cloneUrl: input.cloneUrl ?? null,
            defaultBranch: input.defaultBranch ?? null
          },
          update: {
            displayPath: input.projectPath,
            ...(input.cloneUrl !== undefined ? { cloneUrl: input.cloneUrl } : {}),
            ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {})
          }
        })
        const binding = await tx.gitlabProjectBinding.create({
          data: {
            orgId: input.orgId,
            projectId: input.projectId,
            projectPath: input.projectPath,
            defaultBranch: input.defaultBranch ?? null,
            installerConnectionId: input.installerConnectionId,
            state: 'provisioning'
          }
        })
        await tx.codeHostRepositoryClaim.update({ where: { id: claim.id }, data: { bindingRef: binding.id } })
        return toBindingRecord(binding)
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new GitlabProjectClaimConflict(input.projectId)
      }
      throw e
    }
  }

  async get(orgId: string, bindingId: string): Promise<GitlabProjectBindingRecord | null> {
    const row = await this.prisma.gitlabProjectBinding.findFirst({ where: { id: bindingId, orgId } })
    return row ? toBindingRecord(row) : null
  }

  async byProject(orgId: string, projectId: bigint): Promise<GitlabProjectBindingRecord | null> {
    const row = await this.prisma.gitlabProjectBinding.findUnique({
      where: { orgId_projectId: { orgId, projectId } }
    })
    return row ? toBindingRecord(row) : null
  }

  async byProjectPath(orgId: string, projectPath: string): Promise<GitlabProjectBindingRecord | null> {
    const row = await this.prisma.gitlabProjectBinding.findFirst({
      where: { orgId, projectPath: { equals: projectPath, mode: 'insensitive' } }
    })
    return row ? toBindingRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<GitlabProjectBindingRecord[]> {
    const rows = await this.prisma.gitlabProjectBinding.findMany({
      orderBy: { createdAt: 'asc' },
      where: { orgId }
    })
    return rows.map(toBindingRecord)
  }

  async countByInstaller(orgId: string): Promise<Record<string, number>> {
    const groups = await this.prisma.gitlabProjectBinding.groupBy({
      by: ['installerConnectionId'],
      where: { orgId, installerConnectionId: { not: null } },
      _count: { _all: true }
    })
    const counts: Record<string, number> = {}
    for (const group of groups) {
      if (group.installerConnectionId) counts[group.installerConnectionId] = group._count._all
    }
    return counts
  }

  async update(
    orgId: string,
    bindingId: string,
    patch: Partial<{
      projectPath: string
      defaultBranch: string | null
      installerConnectionId: string | null
      webhookId: bigint | null
      desiredEventsHash: string | null
      state: GitlabBindingState
      stateReason: string | null
    }>
  ): Promise<GitlabProjectBindingRecord | null> {
    const res = await this.prisma.gitlabProjectBinding.updateMany({ where: { id: bindingId, orgId }, data: patch })
    if (res.count !== 1) return null
    return this.get(orgId, bindingId)
  }

  async markProviderMutationStarted(
    orgId: string,
    bindingId: string,
    projectId: bigint,
    owner: string,
    until: Date,
    now: Date
  ): Promise<boolean> {
    // EXCLUSIVE run-owned lease, CAS-acquired: free, same-owner, or expired —
    // never a live foreign lease, so two runs can never both hold the fence.
    const res = await this.prisma.codeHostRepositoryClaim.updateMany({
      where: {
        provider: 'gitlab',
        externalId: projectId,
        orgId,
        bindingRef: bindingId,
        state: { in: ['provisioning', 'active'] },
        OR: [{ opOwner: null }, { opOwner: owner }, { opLeaseUntil: { lt: now } }]
      },
      data: { state: 'active', opOwner: owner, opLeaseUntil: until }
    })
    return res.count === 1
  }

  async endProviderMutation(orgId: string, bindingId: string, projectId: bigint, owner: string): Promise<void> {
    // Only the owning run releases; a finished run can never clear a peer's lease.
    await this.prisma.codeHostRepositoryClaim.updateMany({
      where: { provider: 'gitlab', externalId: projectId, orgId, bindingRef: bindingId, opOwner: owner },
      data: { opOwner: null, opLeaseUntil: null }
    })
  }

  async renewProviderLease(
    orgId: string,
    bindingId: string,
    projectId: bigint,
    owner: string,
    until: Date
  ): Promise<boolean> {
    // Owner-matched atomic extension: renewal and the liveness check are one
    // write, so the lease cannot lapse between a check and its provider call.
    // Owner match alone suffices — an expired-but-unreclaimed lease renews,
    // a reclaimed one has a different owner and refuses.
    const res = await this.prisma.codeHostRepositoryClaim.updateMany({
      where: {
        provider: 'gitlab',
        externalId: projectId,
        orgId,
        bindingRef: bindingId,
        state: 'active',
        opOwner: owner
      },
      data: { opLeaseUntil: until }
    })
    return res.count === 1
  }

  async beginCleanup(orgId: string, bindingId: string, projectId: bigint, now: Date): Promise<boolean> {
    // Refused while a LIVE provisioning lease is held: cleanup must wait, so
    // there is no window between a fence check and its provider write. When no
    // claim row is attached at all (already tombstoned), cleanup may proceed.
    const attached = await this.prisma.codeHostRepositoryClaim.count({
      where: { provider: 'gitlab', externalId: projectId, orgId, bindingRef: bindingId }
    })
    if (attached === 0) {
      await this.prisma.gitlabProjectBinding.updateMany({
        where: { id: bindingId, orgId },
        data: { convergeOwedAt: null }
      })
      return true
    }
    // The claim flip and the convergence discharge are ONE transaction: past
    // this point provisioning can never acquire the claim, so an obligation
    // surviving the flip is one nothing could ever satisfy — and it would hold
    // the console at "converging" forever.
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.codeHostRepositoryClaim.updateMany({
        where: {
          provider: 'gitlab',
          externalId: projectId,
          orgId,
          bindingRef: bindingId,
          OR: [{ opOwner: null }, { opLeaseUntil: { lt: now } }]
        },
        data: { state: 'cleanup_pending', opOwner: null, opLeaseUntil: null }
      })
      if (res.count !== 1) return false
      await tx.gitlabProjectBinding.updateMany({ where: { id: bindingId, orgId }, data: { convergeOwedAt: null } })
      return true
    })
  }

  async removeWithClaim(orgId: string, bindingId: string, projectId: bigint): Promise<boolean> {
    // Claim FIRST: the binding-delete trigger preserves any still-attached claim
    // as cleanup_pending, which is exactly wrong here — this path is only taken
    // after verified-complete external cleanup, so the claim releases with it.
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.gitlabProjectBinding.count({ where: { id: bindingId, orgId } })
      if (owned !== 1) return false
      await tx.codeHostRepositoryClaim.deleteMany({
        where: { provider: 'gitlab', externalId: projectId, orgId, bindingRef: bindingId }
      })
      await tx.gitlabProjectBinding.deleteMany({ where: { id: bindingId, orgId } })
      return true
    })
  }

  async markConvergeOwed(orgId: string, bindingId: string, at: Date): Promise<void> {
    // Lock the CLAIM first, the same order cleanup takes, then decide. A single
    // statement would not do: under read-committed its subquery is evaluated on
    // the statement snapshot, so a cleanup committing while this waits on the
    // binding row would not be seen, and the marker would land unsatisfiable.
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.$queryRaw<{ state: string }[]>`
        SELECT c."state" FROM "code_host_repository_claim" AS c
          JOIN "gitlab_project_binding" AS b
            ON c."externalId" = b."projectId" AND c."bindingRef" = b."id"
         WHERE c."provider" = 'gitlab' AND b."id" = ${bindingId}::uuid AND b."orgId" = ${orgId}
           FOR UPDATE OF c`
      const state = claim[0]?.state
      if (state !== 'provisioning' && state !== 'active') return
      await tx.gitlabProjectBinding.updateMany({ where: { id: bindingId, orgId }, data: { convergeOwedAt: at } })
    })
  }

  async listConvergeOwed(before: Date, limit: number): Promise<GitlabProjectBindingRecord[]> {
    const rows = await this.prisma.gitlabProjectBinding.findMany({
      orderBy: { convergeOwedAt: 'asc' },
      // A binding in cleanup can never acquire its claim again, so its
      // obligation is void — selecting it would burn the sweep's budget and
      // hold it "converging" forever.
      where: { convergeOwedAt: { not: null, lt: before }, state: { not: 'cleanup_pending' } },
      take: limit
    })
    return rows.map(toBindingRecord)
  }

  async bumpCredentialEpoch(orgId: string, bindingId: string): Promise<bigint | null> {
    const res = await this.prisma.gitlabProjectBinding.updateMany({
      where: { id: bindingId, orgId },
      data: { credentialEpoch: { increment: 1n } }
    })
    if (res.count !== 1) return null
    const row = await this.prisma.gitlabProjectBinding.findUnique({ where: { id: bindingId } })
    return row?.credentialEpoch ?? null
  }
}

// ── §7.2/§8.2 per-agent accounts, their memberships, and their PATs ──────────

const ACCOUNT_STATES: readonly GitlabAccountState[] = [...BINDING_STATES, GITLAB_CREATION_FORBIDDEN_STATE]

function toAccountRecord(r: GitlabAgentAccount): GitlabAgentAccountRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    agentId: r.agentId,
    rootGroupId: r.rootGroupId,
    serviceAccountUserId: r.serviceAccountUserId,
    username: r.username,
    displayName: r.displayName,
    avatarFingerprint: r.avatarFingerprint,
    createAttempt:
      r.createAttemptId === null || r.createAttemptAt === null
        ? null
        : {
            id: r.createAttemptId,
            openedAt: r.createAttemptAt,
            knownServiceAccountUserIds: r.createAttemptKnownIds
          },
    credentialEpoch: r.credentialEpoch,
    administeringConnectionId: r.administeringConnectionId,
    generation: r.generation,
    // Unknown persisted values fail toward "needs repair", never toward usable.
    lifecycle: r.lifecycle === 'retiring' ? 'retiring' : 'active',
    state: (ACCOUNT_STATES as readonly string[]).includes(r.state)
      ? (r.state as GitlabAccountState)
      : 'runtime_degraded',
    stateReason: r.stateReason
  }
}

export class PgGitlabAgentAccountRepo implements GitlabAgentAccountRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async ensure(input: {
    orgId: string
    agentId: string
    rootGroupId: bigint
    username: string
    administeringConnectionId: string | null
    axisBaseUrl: string
  }): Promise<GitlabAgentAccountRecord> {
    // §24.1: the root group id is host-relative, and the binding lease this runs
    // under is a GitLab-domain lease, not the axis key — so join it here.
    const row = await this.prisma.$transaction(async (tx) => {
      await joinAxisFence(tx, input.axisBaseUrl)
      return tx.gitlabAgentAccount.upsert({
        where: {
          orgId_agentId_rootGroupId: {
            orgId: input.orgId,
            agentId: input.agentId,
            rootGroupId: input.rootGroupId
          }
        },
        create: {
          orgId: input.orgId,
          agentId: input.agentId,
          rootGroupId: input.rootGroupId,
          username: input.username,
          administeringConnectionId: input.administeringConnectionId,
          state: 'provisioning'
        },
        // An existing row keeps its lifecycle facts: only the administering
        // connection follows the binding that is converging it right now.
        update: { administeringConnectionId: input.administeringConnectionId }
      })
    })
    return toAccountRecord(row)
  }

  async get(accountId: string): Promise<GitlabAgentAccountRecord | null> {
    const row = await this.prisma.gitlabAgentAccount.findUnique({ where: { id: accountId } })
    return row ? toAccountRecord(row) : null
  }

  async byAgentRoot(orgId: string, agentId: string, rootGroupId: bigint): Promise<GitlabAgentAccountRecord | null> {
    const row = await this.prisma.gitlabAgentAccount.findUnique({
      where: { orgId_agentId_rootGroupId: { orgId, agentId, rootGroupId } }
    })
    return row ? toAccountRecord(row) : null
  }

  async forAgentBinding(orgId: string, agentId: string, bindingId: string): Promise<GitlabAgentAccountRecord | null> {
    // The membership IS the resolution: an account serves an agent on a project
    // exactly while it is bound there, whatever else it holds in its root.
    const row = await this.prisma.gitlabAgentAccount.findFirst({
      where: { orgId, agentId, memberships: { some: { bindingId } } }
    })
    return row ? toAccountRecord(row) : null
  }

  async listForBinding(bindingId: string): Promise<GitlabAgentAccountRecord[]> {
    const rows = await this.prisma.gitlabAgentAccount.findMany({
      orderBy: { createdAt: 'asc' },
      where: { memberships: { some: { bindingId } } }
    })
    return rows.map(toAccountRecord)
  }

  async listForAgent(orgId: string, agentId: string): Promise<GitlabAgentAccountRecord[]> {
    const rows = await this.prisma.gitlabAgentAccount.findMany({
      orderBy: { createdAt: 'asc' },
      where: { orgId, agentId }
    })
    return rows.map(toAccountRecord)
  }

  async listUnfinishedRetirements(before: Date, limit: number): Promise<GitlabAgentAccountRecord[]> {
    const rows = await this.prisma.gitlabAgentAccount.findMany({
      orderBy: { updatedAt: 'asc' },
      // Every surviving `retiring` row is unfinished by definition — a finished
      // retirement deletes its row — so the worklist keys on the lifecycle and
      // never on a reason or state a later failure may have overwritten.
      where: { lifecycle: 'retiring', updatedAt: { lt: before } },
      take: limit
    })
    return rows.map(toAccountRecord)
  }

  async detachMembershipForRemoval(accountId: string, bindingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Lock the account row FIRST, exactly as attachMembership and
      // beginRetirement do. Counting before taking it would let a concurrent
      // attach hold the lock with an uncommitted membership this count cannot
      // see, and the CAS below would then retire a row that has one.
      await tx.$queryRaw`SELECT "id" FROM "gitlab_agent_account" WHERE "id" = ${accountId}::uuid FOR UPDATE`
      await tx.gitlabAccountMembership.deleteMany({ where: { accountId, bindingId } })
      // Emptied by this detach ⇒ the removal owes this account's retirement.
      // This transaction is the §7.2 `active`→`retiring` CAS: it has just
      // verified the membership set is empty, and committing the lifecycle with
      // the marker is what makes the row a durable work item — a crash before
      // the provider work would otherwise leave it in no worklist at all.
      if ((await tx.gitlabAccountMembership.count({ where: { accountId } })) > 0) return
      await tx.gitlabAgentAccount.updateMany({
        where: { id: accountId, lifecycle: 'active' },
        data: { lifecycle: 'retiring', retiringForBindingId: bindingId }
      })
    })
  }

  async listRetiringForBinding(bindingId: string): Promise<GitlabAgentAccountRecord[]> {
    const rows = await this.prisma.gitlabAgentAccount.findMany({
      orderBy: { createdAt: 'asc' },
      where: { lifecycle: 'retiring', retiringForBindingId: bindingId }
    })
    return rows.map(toAccountRecord)
  }

  async listForOrg(orgId: string): Promise<GitlabAgentAccountRecord[]> {
    const rows = await this.prisma.gitlabAgentAccount.findMany({ orderBy: { createdAt: 'asc' }, where: { orgId } })
    return rows.map(toAccountRecord)
  }

  async update(
    accountId: string,
    patch: Partial<{
      serviceAccountUserId: bigint | null
      username: string
      displayName: string | null
      avatarFingerprint: string | null
      administeringConnectionId: string | null
      state: GitlabAccountState
      stateReason: string | null
    }>
  ): Promise<GitlabAgentAccountRecord | null> {
    const res = await this.prisma.gitlabAgentAccount.updateMany({ where: { id: accountId }, data: patch })
    if (res.count !== 1) return null
    return this.get(accountId)
  }

  async openCreateAttempt(input: {
    accountId: string
    attemptId: string
    openedAt: Date
    knownServiceAccountUserIds: bigint[]
  }): Promise<GitlabAgentAccountRecord | null> {
    const res = await this.prisma.gitlabAgentAccount.updateMany({
      where: { id: input.accountId },
      data: {
        createAttemptId: input.attemptId,
        createAttemptAt: input.openedAt,
        createAttemptKnownIds: input.knownServiceAccountUserIds
      }
    })
    if (res.count !== 1) return null
    return this.get(input.accountId)
  }

  async commitServiceAccount(input: {
    accountId: string
    serviceAccountUserId: bigint
    username: string
    administeringConnectionId: string
  }): Promise<GitlabAgentAccountRecord | null> {
    // One write: the id lands and the window closes together, so a process that
    // exits right after this still resolves its own account by the durable key.
    const res = await this.prisma.gitlabAgentAccount.updateMany({
      where: { id: input.accountId },
      data: {
        serviceAccountUserId: input.serviceAccountUserId,
        username: input.username,
        administeringConnectionId: input.administeringConnectionId,
        createAttemptId: null,
        createAttemptAt: null,
        createAttemptKnownIds: []
      }
    })
    if (res.count !== 1) return null
    return this.get(input.accountId)
  }

  async claimLease(accountId: string, owner: string, until: Date, now: Date): Promise<boolean> {
    // CAS: free, same-owner, or expired — never a live foreign lease, so two
    // runs can never both mutate one account at the provider (§7.2).
    const res = await this.prisma.gitlabAgentAccount.updateMany({
      where: {
        id: accountId,
        OR: [{ leaseOwner: null }, { leaseOwner: owner }, { leaseUntil: { lt: now } }]
      },
      data: { leaseOwner: owner, leaseUntil: until }
    })
    return res.count === 1
  }

  async renewLease(accountId: string, owner: string, until: Date): Promise<boolean> {
    const res = await this.prisma.gitlabAgentAccount.updateMany({
      where: { id: accountId, leaseOwner: owner },
      data: { leaseUntil: until }
    })
    return res.count === 1
  }

  async releaseLease(accountId: string, owner: string): Promise<void> {
    await this.prisma.gitlabAgentAccount.updateMany({
      where: { id: accountId, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null }
    })
  }

  async attachMembership(input: {
    accountId: string
    generation: bigint
    bindingId: string
    accessLevel: number
  }): Promise<boolean> {
    // The generation fence (§7.2): the row must still be `active` at exactly the
    // generation the caller provisioned under. The locked read serializes with
    // the retirement CAS below, so exactly one of the two wins.
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ generation: bigint; lifecycle: string }[]>`
        SELECT "generation", "lifecycle" FROM "gitlab_agent_account"
         WHERE "id" = ${input.accountId}::uuid FOR UPDATE`
      const row = locked[0]
      if (!row || row.lifecycle !== 'active' || row.generation !== input.generation) return false
      // Bound again ⇒ no removal is owed this account's retirement any more.
      await tx.gitlabAgentAccount.updateMany({ where: { id: input.accountId }, data: { retiringForBindingId: null } })
      await tx.gitlabAccountMembership.upsert({
        where: { accountId_bindingId: { accountId: input.accountId, bindingId: input.bindingId } },
        create: {
          accountId: input.accountId,
          accountGeneration: input.generation,
          bindingId: input.bindingId,
          accessLevel: input.accessLevel
        },
        update: { accountGeneration: input.generation, accessLevel: input.accessLevel }
      })
      return true
    })
  }

  async detachMembership(accountId: string, bindingId: string): Promise<void> {
    await this.prisma.gitlabAccountMembership.deleteMany({ where: { accountId, bindingId } })
  }

  async membershipsForBinding(bindingId: string): Promise<GitlabAccountMembershipRecord[]> {
    const rows = await this.prisma.gitlabAccountMembership.findMany({ where: { bindingId } })
    return rows.map((row) => ({
      accountId: row.accountId,
      accountGeneration: row.accountGeneration,
      bindingId: row.bindingId,
      accessLevel: row.accessLevel
    }))
  }

  async membershipsOfAccount(accountId: string): Promise<Array<{ bindingId: string; projectId: bigint }>> {
    const rows = await this.prisma.gitlabAccountMembership.findMany({
      where: { accountId },
      select: { bindingId: true, binding: { select: { projectId: true } } }
    })
    return rows.map((row) => ({ bindingId: row.bindingId, projectId: row.binding.projectId }))
  }

  countMemberships(accountId: string): Promise<number> {
    return this.prisma.gitlabAccountMembership.count({ where: { accountId } })
  }

  async beginRetirement(accountId: string): Promise<boolean> {
    // Emptiness check and the `active`→`retiring` CAS are ONE transaction under
    // the same row lock a membership insert takes, so a bind either commits
    // first (and this finds a membership) or waits and then loses the fence.
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ lifecycle: string }[]>`
        SELECT "lifecycle" FROM "gitlab_agent_account" WHERE "id" = ${accountId}::uuid FOR UPDATE`
      const row = locked[0]
      if (!row) return false
      if (row.lifecycle === 'retiring') return true
      if ((await tx.gitlabAccountMembership.count({ where: { accountId } })) > 0) return false
      await tx.gitlabAgentAccount.updateMany({
        where: { id: accountId, lifecycle: 'active' },
        data: { lifecycle: 'retiring' }
      })
      return true
    })
  }

  async finishRetirement(accountId: string): Promise<void> {
    await this.prisma.gitlabAgentAccount.deleteMany({ where: { id: accountId, lifecycle: 'retiring' } })
  }

  async consumers(orgId: string, projectId: bigint): Promise<GitlabAccountConsumer[]> {
    const [workspaces, hooks, grants] = await Promise.all([
      this.prisma.agent.findMany({
        where: { orgId, gitCredentialProvider: 'gitlab', workspaceRepoId: projectId },
        select: { id: true, gitAccess: true }
      }),
      this.prisma.hookDef.findMany({
        where: { orgId, kind: 'gitlab', enabled: true, repoId: projectId, agentId: { not: null } },
        select: { agentId: true }
      }),
      this.prisma.agentRepoAuthorization.findMany({
        where: { provider: 'gitlab', repoId: projectId, agent: { orgId } },
        select: { agentId: true, access: true }
      })
    ])
    const levels = new Map<string, number>()
    const raise = (agentId: string, accessLevel: number): void => {
      levels.set(agentId, Math.max(levels.get(agentId) ?? 0, accessLevel))
    }
    // The workspace gitAccess clamp derives the role (§7.2, §13.1).
    for (const row of workspaces) raise(row.id, gitlabWorkspaceAccessLevel(row.gitAccess))
    // A hook consumer posts notes and may run the configured review policy.
    for (const row of hooks) if (row.agentId) raise(row.agentId, ACCESS_DEVELOPER)
    // An explicit additional-project authorization is a consumer too (§8.3): without
    // it, the membership such a grant binds would be unbound by the next converge.
    for (const row of grants) raise(row.agentId, gitlabAuthorizationAccessLevel(row.access))
    return [...levels].map(([agentId, accessLevel]) => ({ agentId, accessLevel }))
  }

  async consumersForOrg(orgId: string): Promise<GitlabProjectConsumer[]> {
    const [workspaces, hooks, grants] = await Promise.all([
      this.prisma.agent.findMany({
        where: { orgId, gitCredentialProvider: 'gitlab', workspaceRepoId: { not: null } },
        select: { id: true, gitAccess: true, workspaceRepoId: true }
      }),
      this.prisma.hookDef.findMany({
        where: { orgId, kind: 'gitlab', enabled: true, repoId: { not: null }, agentId: { not: null } },
        select: { agentId: true, repoId: true }
      }),
      this.prisma.agentRepoAuthorization.findMany({
        where: { provider: 'gitlab', agent: { orgId } },
        select: { agentId: true, repoId: true, access: true }
      })
    ])
    const levels = new Map<string, GitlabProjectConsumer>()
    const raise = (projectId: bigint, agentId: string, accessLevel: number): void => {
      const key = `${projectId}:${agentId}`
      const held = levels.get(key)
      if (held) held.accessLevel = Math.max(held.accessLevel, accessLevel)
      else levels.set(key, { projectId, agentId, accessLevel })
    }
    // The workspace gitAccess clamp derives the role (§7.2, §13.1).
    for (const row of workspaces) raise(row.workspaceRepoId!, row.id, gitlabWorkspaceAccessLevel(row.gitAccess))
    // A hook consumer posts notes and may run the configured review policy.
    for (const row of hooks) if (row.agentId && row.repoId) raise(row.repoId, row.agentId, ACCESS_DEVELOPER)
    // An explicit additional-project authorization is a consumer too (§8.3).
    for (const row of grants) raise(row.repoId, row.agentId, gitlabAuthorizationAccessLevel(row.access))
    return [...levels.values()]
  }
}

export class PgGitlabProjectCredentialRepo implements GitlabProjectCredentialRepo {
  constructor(private readonly prisma: PrismaClient) {}

  private toRecord(r: GitlabProjectCredential): GitlabProjectCredentialRecord {
    return {
      id: r.id,
      accountId: r.accountId,
      // Purpose is written only from the closed union; a foreign value cannot round-trip.
      purpose: r.purpose as GitlabCredentialPurpose,
      externalTokenId: r.externalTokenId,
      scopes: r.scopes,
      providerExpiresAt: r.providerExpiresAt,
      generation: r.generation
    }
  }

  async commitRotation(input: {
    accountId: string
    purpose: GitlabCredentialPurpose
    externalTokenId: bigint
    scopes: string[]
    providerExpiresAt: Date
    sealedToken: string
  }): Promise<GitlabProjectCredentialRecord> {
    const facts = {
      externalTokenId: input.externalTokenId,
      scopes: input.scopes,
      providerExpiresAt: input.providerExpiresAt
    }
    // Metadata/generation, the sealed value, and the account's purge fence land
    // in ONE transaction: a reader can never open an old token under new
    // metadata, and a crash between them cannot lose the provider token id.
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.gitlabProjectCredential.upsert({
        where: { accountId_purpose: { accountId: input.accountId, purpose: input.purpose } },
        create: { accountId: input.accountId, purpose: input.purpose, ...facts },
        update: { ...facts, generation: { increment: 1n } }
      })
      await tx.gitlabProjectCredentialSecret.upsert({
        where: { credentialId: row.id },
        create: { credentialId: row.id, token: input.sealedToken },
        update: { token: input.sealedToken }
      })
      await tx.gitlabAgentAccount.updateMany({
        where: { id: input.accountId },
        data: { credentialEpoch: { increment: 1n } }
      })
      return this.toRecord(row)
    })
  }

  async get(accountId: string, purpose: GitlabCredentialPurpose): Promise<GitlabProjectCredentialRecord | null> {
    const row = await this.prisma.gitlabProjectCredential.findUnique({
      where: { accountId_purpose: { accountId, purpose } }
    })
    return row ? this.toRecord(row) : null
  }

  async listForAccount(accountId: string): Promise<GitlabProjectCredentialRecord[]> {
    const rows = await this.prisma.gitlabProjectCredential.findMany({
      orderBy: { purpose: 'asc' },
      where: { accountId }
    })
    return rows.map((r) => this.toRecord(r))
  }

  async listExpiring(before: Date): Promise<Array<{ credential: GitlabProjectCredentialRecord; orgId: string }>> {
    const rows = await this.prisma.gitlabProjectCredential.findMany({
      orderBy: { providerExpiresAt: 'asc' },
      where: { providerExpiresAt: { lt: before } },
      include: { account: { select: { orgId: true } } }
    })
    return rows.map((row) => ({ credential: this.toRecord(row), orgId: row.account.orgId }))
  }

  async remove(accountId: string, purpose: GitlabCredentialPurpose): Promise<void> {
    await this.prisma.gitlabProjectCredential.deleteMany({ where: { accountId, purpose } })
  }
}

export class PgGitlabProjectCredentialSecretStore implements GitlabProjectCredentialSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async get(orgId: string, credentialId: string): Promise<string | null> {
    const row = await this.db.gitlabProjectCredentialSecret.findFirst({
      where: { credentialId, credential: { account: { orgId } } }
    })
    return row ? this.cipher.open(row.token, orgScope(OrgId(orgId))) : null
  }
}

export class PgGitlabWebhookSecretStore implements GitlabWebhookSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: string, bindingId: string, signingKey: string): Promise<void> {
    if ((await this.db.gitlabProjectBinding.count({ where: { id: bindingId, orgId } })) === 0) {
      throw new Error('gitlab webhook secret write outside its organization')
    }
    const sealed = await this.cipher.seal(signingKey, orgScope(OrgId(orgId)))
    await this.db.gitlabWebhookSecret.upsert({
      where: { bindingId },
      create: { bindingId, signingKey: sealed },
      update: { signingKey: sealed }
    })
  }

  async get(orgId: string, bindingId: string): Promise<string | null> {
    const row = await this.db.gitlabWebhookSecret.findFirst({ where: { bindingId, binding: { orgId } } })
    return row ? this.cipher.open(row.signingKey, orgScope(OrgId(orgId))) : null
  }

  async delete(orgId: string, bindingId: string): Promise<void> {
    await this.db.gitlabWebhookSecret.deleteMany({ where: { bindingId, binding: { orgId } } })
  }
}
