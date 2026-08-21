/**
 * GitLab.com OAuth connection persistence (gitlab-com-integration.md §8.2, §9).
 *
 * Three stores: connection metadata, the sealed token pair (SecretCipher,
 * per-org scope — BotSecret discipline), and the one-shot OAuth state whose
 * consume is an atomic delete-returning read. Refresh coordination is data
 * here, policy in the service: a short lease row claim plus a tokenVersion CAS.
 */
import type {
  GitlabConnection,
  GitlabProjectBinding,
  GitlabProjectCredential,
  PrismaClient
} from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { GitlabMembershipGone, GitlabProjectClaimConflict } from '../errors.js'
import type {
  GitlabBindingState,
  GitlabConnectionRecord,
  GitlabConnectionRepo,
  GitlabConnectionSecretStore,
  GitlabConnectionState,
  GitlabCredentialPurpose,
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
    serviceAccountUserId: r.serviceAccountUserId,
    serviceAccountUsername: r.serviceAccountUsername,
    webhookId: r.webhookId,
    desiredEventsHash: r.desiredEventsHash,
    credentialEpoch: r.credentialEpoch,
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
  }): Promise<GitlabProjectBindingRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
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

  async listForOrg(orgId: string): Promise<GitlabProjectBindingRecord[]> {
    const rows = await this.prisma.gitlabProjectBinding.findMany({
      orderBy: { createdAt: 'asc' },
      where: { orgId }
    })
    return rows.map(toBindingRecord)
  }

  async update(
    orgId: string,
    bindingId: string,
    patch: Partial<{
      projectPath: string
      defaultBranch: string | null
      installerConnectionId: string | null
      serviceAccountUserId: bigint | null
      serviceAccountUsername: string | null
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
    if (attached === 0) return true
    const res = await this.prisma.codeHostRepositoryClaim.updateMany({
      where: {
        provider: 'gitlab',
        externalId: projectId,
        orgId,
        bindingRef: bindingId,
        OR: [{ opOwner: null }, { opLeaseUntil: { lt: now } }]
      },
      data: { state: 'cleanup_pending', opOwner: null, opLeaseUntil: null }
    })
    return res.count === 1
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

export class PgGitlabProjectCredentialRepo implements GitlabProjectCredentialRepo {
  constructor(private readonly prisma: PrismaClient) {}

  private toRecord(r: GitlabProjectCredential): GitlabProjectCredentialRecord {
    return {
      id: r.id,
      bindingId: r.bindingId,
      // Purpose is written only from the closed union; a foreign value cannot round-trip.
      purpose: r.purpose as GitlabCredentialPurpose,
      externalTokenId: r.externalTokenId,
      scopes: r.scopes,
      providerExpiresAt: r.providerExpiresAt,
      generation: r.generation
    }
  }

  async commitRotation(input: {
    bindingId: string
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
    // Metadata/generation, the sealed value, and the binding's purge fence land
    // in ONE transaction: a reader can never open an old token under new
    // metadata, and a crash between them cannot lose the provider token id.
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.gitlabProjectCredential.upsert({
        where: { bindingId_purpose: { bindingId: input.bindingId, purpose: input.purpose } },
        create: { bindingId: input.bindingId, purpose: input.purpose, ...facts },
        update: { ...facts, generation: { increment: 1n } }
      })
      await tx.gitlabProjectCredentialSecret.upsert({
        where: { credentialId: row.id },
        create: { credentialId: row.id, token: input.sealedToken },
        update: { token: input.sealedToken }
      })
      await tx.gitlabProjectBinding.updateMany({
        where: { id: input.bindingId },
        data: { credentialEpoch: { increment: 1n } }
      })
      return this.toRecord(row)
    })
  }

  async get(bindingId: string, purpose: GitlabCredentialPurpose): Promise<GitlabProjectCredentialRecord | null> {
    const row = await this.prisma.gitlabProjectCredential.findUnique({
      where: { bindingId_purpose: { bindingId, purpose } }
    })
    return row ? this.toRecord(row) : null
  }

  async listForBinding(bindingId: string): Promise<GitlabProjectCredentialRecord[]> {
    const rows = await this.prisma.gitlabProjectCredential.findMany({
      orderBy: { purpose: 'asc' },
      where: { bindingId }
    })
    return rows.map((r) => this.toRecord(r))
  }

  async listExpiring(before: Date): Promise<Array<{ credential: GitlabProjectCredentialRecord; orgId: string }>> {
    const rows = await this.prisma.gitlabProjectCredential.findMany({
      orderBy: { providerExpiresAt: 'asc' },
      where: { providerExpiresAt: { lt: before } },
      include: { binding: { select: { orgId: true } } }
    })
    return rows.map((row) => ({ credential: this.toRecord(row), orgId: row.binding.orgId }))
  }

  async remove(bindingId: string, purpose: GitlabCredentialPurpose): Promise<void> {
    await this.prisma.gitlabProjectCredential.deleteMany({ where: { bindingId, purpose } })
  }
}

export class PgGitlabProjectCredentialSecretStore implements GitlabProjectCredentialSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async get(orgId: string, credentialId: string): Promise<string | null> {
    const row = await this.db.gitlabProjectCredentialSecret.findFirst({
      where: { credentialId, credential: { binding: { orgId } } }
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
