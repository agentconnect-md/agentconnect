/**
 * PgMemoryConnectionWriter — the transactional unit-of-work for external-memory
 * definition/grant mutations (see the {@link MemoryConnectionWriter} port).
 *
 * Each method runs its check-then-write pair in ONE transaction that
 * try-acquires the advisory mutation scope(s) of the resources it touches
 * (persistence/memory-connection-lock.ts), so the FK-less agent-binding edge
 * and the installation reference set stay coherent across control-plane
 * instances — including the rolling-update window where two processes serve
 * writes at once. `busy` is the fail-fast answer (routes map it to 409).
 *
 * The configured SecretCipher transform happens BEFORE a transaction opens (an
 * encrypting provider may make network calls; a transaction must never wait on
 * one). Daemon/relay pushes never run in here — they stay at the routes,
 * post-commit, best-effort with reconnect snapshots as the convergence backstop.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js'
import { withTx } from '../prisma.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import type { OrgId } from '../../domain/ids.js'
import { mintGrantKey } from '../../orchestrator/mcpProvider.js'
import type { ExternalMemoryConnectionRecord, ExternalMemoryGrantRecord, MemoryConnectionWriter } from '../ports.js'
import { tryLockMemoryConnectionScope, tryLockMemoryInstallationScope } from '../memory-connection-lock.js'
import { PgExternalMemoryConnectionRepo } from './memory-connection.repo.js'

async function sealValues(cipher: SecretCipher, values: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(Object.entries(values).map(async ([name, value]) => [name, await cipher.seal(value)] as const))
  )
}

async function openValues(cipher: SecretCipher, sealed: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(Object.entries(sealed).map(async ([name, value]) => [name, await cipher.open(value)] as const))
  )
}

/** The sealed secret row as of the surrounding transaction — the ONLY read that
 *  may feed a projection push for the revision that transaction commits. A
 *  pre-transaction read can pair an older credential with a newer committed
 *  revision, and the relay's revision gate then rejects every in-order repair
 *  until reconnect. Decrypt AFTER commit ({@link openValues}). */
async function sealedSecretsInTx(tx: Prisma.TransactionClient, connectionId: string): Promise<Record<string, string>> {
  const row = await tx.externalMemoryConnectionSecret.findUnique({ where: { connectionId } })
  return (row?.values as Record<string, string> | undefined) ?? {}
}

/** The connection's active grants, oldest first, with decrypted keys — the
 *  same read `PgExternalMemoryGrantRepo.activeForConnection` serves, inlined so
 *  the writer needs no second repo instance. Runs OUTSIDE any transaction (the
 *  cipher may make network calls). */
async function readActiveGrants(
  db: PrismaClient,
  cipher: SecretCipher,
  connectionId: string
): Promise<ExternalMemoryGrantRecord[]> {
  const rows = await db.externalMemoryGrant.findMany({
    where: { connectionId, status: 'active' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  })
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      connectionId: row.connectionId,
      key: await cipher.open(row.key),
      status: row.status as ExternalMemoryGrantRecord['status'],
      createdAt: row.createdAt
    }))
  )
}

/** True while any agent in the org binds this connection. Bindings live in the
 *  agents' runtimeOverrides JSON (deliberately no FK); the scan is only
 *  meaningful inside a transaction holding the connection's mutation scope,
 *  which every binding write takes too (PgAgentRepo). */
async function connectionBoundByAgent(
  tx: Prisma.TransactionClient,
  orgId: string,
  connectionId: string
): Promise<boolean> {
  const agents = await tx.agent.findMany({ where: { orgId }, select: { runtimeOverrides: true } })
  return agents.some((agent) => {
    const memory = (agent.runtimeOverrides as { memory?: { provider?: string; connectionId?: string } } | null)?.memory
    return memory?.provider === 'external' && memory.connectionId === connectionId
  })
}

export class PgMemoryConnectionWriter implements MemoryConnectionWriter {
  constructor(
    // The full client (not PrismaLike): a transaction OWNER, like PgAgentConfigWriter.
    private readonly prisma: PrismaClient,
    private readonly cipher: SecretCipher
  ) {}

  async createConnection(
    input: {
      id: string
      orgId: OrgId
      installationId: string
      config: Record<string, unknown>
      createdByUserId?: string
    },
    secrets: Record<string, string>,
    mintGrant: boolean
  ): Promise<
    | { outcome: 'created'; connection: ExternalMemoryConnectionRecord; grantKey?: string }
    | { outcome: 'installation_missing' }
    | { outcome: 'busy' }
  > {
    const sealedSecrets = await sealValues(this.cipher, secrets)
    const grantKey = mintGrant ? mintGrantKey() : undefined
    const sealedGrantKey = grantKey ? await this.cipher.seal(grantKey) : undefined
    return withTx(this.prisma, async (tx) => {
      if (!(await tryLockMemoryInstallationScope(tx, input.installationId))) return { outcome: 'busy' as const }
      // Authoritative existence re-check under the scope: the installation
      // DELETE's reference scan holds the same lock, so it either already
      // dropped the row (⇒ refuse here) or waits until this insert commits
      // (⇒ its scan sees the reference and answers 409).
      const installation = await tx.memoryPluginInstallation.findUnique({
        where: { id: input.installationId },
        select: { orgId: true }
      })
      if (!installation || installation.orgId !== input.orgId) return { outcome: 'installation_missing' as const }
      const connection = await new PgExternalMemoryConnectionRepo(tx).create(input)
      await tx.externalMemoryConnectionSecret.create({
        data: { connectionId: connection.id, values: sealedSecrets as Prisma.InputJsonValue }
      })
      if (sealedGrantKey) {
        await tx.externalMemoryGrant.create({ data: { connectionId: connection.id, key: sealedGrantKey } })
      }
      return { outcome: 'created' as const, connection, ...(grantKey ? { grantKey } : {}) }
    })
  }

  async updateConnection(
    id: string,
    orgId: OrgId,
    patch: { config?: Record<string, unknown>; secrets?: Record<string, string> }
  ): Promise<
    | { outcome: 'updated'; connection: ExternalMemoryConnectionRecord; secrets: Record<string, string> }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  > {
    const sealedSecrets = patch.secrets !== undefined ? await sealValues(this.cipher, patch.secrets) : undefined
    const result = await withTx(this.prisma, async (tx) => {
      if (!(await tryLockMemoryConnectionScope(tx, id))) return { outcome: 'busy' as const }
      const existing = await tx.externalMemoryConnection.findUnique({ where: { id }, select: { orgId: true } })
      if (!existing || existing.orgId !== orgId) return { outcome: 'not_found' as const }
      if (sealedSecrets !== undefined) {
        await tx.externalMemoryConnectionSecret.upsert({
          where: { connectionId: id },
          create: { connectionId: id, values: sealedSecrets as Prisma.InputJsonValue },
          update: { values: sealedSecrets as Prisma.InputJsonValue }
        })
      }
      const connection = await new PgExternalMemoryConnectionRepo(tx).update(orgId, id, {
        ...(patch.config !== undefined ? { config: patch.config } : {})
      })
      // The projection snapshot for the revision THIS transaction commits: a
      // config-only patch must republish the concurrently-replaced secrets, not
      // whatever the route read before the transaction (the relay's revision
      // gate would pin that stale credential until reconnect).
      return { outcome: 'updated' as const, connection, sealedSnapshot: await sealedSecretsInTx(tx, id) }
    })
    if (result.outcome !== 'updated') return result
    return {
      outcome: 'updated',
      connection: result.connection,
      secrets: await openValues(this.cipher, result.sealedSnapshot)
    }
  }

  async prepareGrantRotation(
    id: string,
    orgId: OrgId
  ): Promise<
    | {
        outcome: 'prepared'
        connection: ExternalMemoryConnectionRecord
        fresh: ExternalMemoryGrantRecord
        retiring: ExternalMemoryGrantRecord[]
        secrets: Record<string, string>
      }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  > {
    // Decrypt the observed active set BEFORE the transaction (the route needs
    // plaintext keys for the push and the retire hashes). A failed earlier
    // rotation leaves old+new active: reuse the newest instead of minting an
    // unbounded chain of pending grants.
    const observed = await readActiveGrants(this.prisma, this.cipher, id)
    const reuse = observed.length > 1 ? observed.at(-1)! : undefined
    const freshKey = reuse ? undefined : mintGrantKey()
    const sealedFreshKey = freshKey ? await this.cipher.seal(freshKey) : undefined
    const result = await withTx(this.prisma, async (tx) => {
      if (!(await tryLockMemoryConnectionScope(tx, id))) return { outcome: 'busy' as const }
      const existing = await tx.externalMemoryConnection.findUnique({ where: { id }, select: { orgId: true } })
      if (!existing || existing.orgId !== orgId) return { outcome: 'not_found' as const }
      // CAS the active-grant set against the pre-transaction observation: a
      // rotation that committed in between would otherwise make this one mint
      // beside a fresh grant it never saw. Fail-fast like any other overlap.
      const activeNow = await tx.externalMemoryGrant.findMany({
        where: { connectionId: id, status: 'active' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true }
      })
      if (activeNow.length !== observed.length || activeNow.some((row, index) => row.id !== observed[index]!.id)) {
        return { outcome: 'busy' as const }
      }
      const connection = await new PgExternalMemoryConnectionRepo(tx).update(orgId, id, {})
      let fresh: ExternalMemoryGrantRecord
      if (reuse) {
        fresh = reuse
      } else {
        const created = await tx.externalMemoryGrant.create({
          data: { connectionId: id, key: sealedFreshKey! }
        })
        fresh = {
          id: created.id,
          connectionId: created.connectionId,
          key: freshKey!,
          status: created.status as ExternalMemoryGrantRecord['status'],
          createdAt: created.createdAt
        }
      }
      return {
        outcome: 'prepared' as const,
        connection,
        fresh,
        retiring: observed.filter((grant) => grant.id !== fresh.id),
        sealedSnapshot: await sealedSecretsInTx(tx, id)
      }
    })
    if (result.outcome !== 'prepared') return result
    const { sealedSnapshot, ...prepared } = result
    return { ...prepared, secrets: await openValues(this.cipher, sealedSnapshot) }
  }

  async finalizeGrantRotation(
    id: string,
    orgId: OrgId,
    retiringGrantIds: readonly string[]
  ): Promise<
    | { outcome: 'retired'; connection: ExternalMemoryConnectionRecord; secrets: Record<string, string> }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  > {
    const result = await withTx(this.prisma, async (tx) => {
      if (!(await tryLockMemoryConnectionScope(tx, id))) return { outcome: 'busy' as const }
      const existing = await tx.externalMemoryConnection.findUnique({ where: { id }, select: { orgId: true } })
      if (!existing || existing.orgId !== orgId) return { outcome: 'not_found' as const }
      // Revocation and the revision bump commit TOGETHER, under the scope: the
      // relay honors a whole-list assign only at a strictly newer revision (and
      // a per-hash unassign only at the exact current one), so retirement must
      // own a revision greater than every assignment that could still carry the
      // retired hash. The caller then republishes the post-retirement allowlist
      // under this revision — a delayed pre-retirement assign can no longer
      // reintroduce the revoked grant.
      await tx.externalMemoryGrant.updateMany({
        where: { id: { in: [...retiringGrantIds] }, connectionId: id },
        data: { status: 'revoked' }
      })
      const connection = await new PgExternalMemoryConnectionRepo(tx).update(orgId, id, {})
      return { outcome: 'retired' as const, connection, sealedSnapshot: await sealedSecretsInTx(tx, id) }
    })
    if (result.outcome !== 'retired') return result
    return {
      outcome: 'retired',
      connection: result.connection,
      secrets: await openValues(this.cipher, result.sealedSnapshot)
    }
  }

  async deleteConnection(
    id: string,
    orgId: OrgId
  ): Promise<
    | { outcome: 'deleted'; tombstoneRevision: number }
    | { outcome: 'bound' }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  > {
    return withTx(this.prisma, async (tx) => {
      if (!(await tryLockMemoryConnectionScope(tx, id))) return { outcome: 'busy' as const }
      const existing = await tx.externalMemoryConnection.findUnique({
        where: { id },
        select: { orgId: true, revision: true }
      })
      if (!existing || existing.orgId !== orgId) return { outcome: 'not_found' as const }
      // The binding scan shares this connection's scope with every agent write
      // that binds/unbinds it (PgAgentRepo) — a concurrent bind either committed
      // (seen here ⇒ 'bound') or re-verifies the connection after this drop.
      if (await connectionBoundByAgent(tx, existing.orgId, id)) return { outcome: 'bound' as const }
      await tx.externalMemoryConnection.delete({ where: { id } }) // secret/grant rows cascade
      // The relay tombstone must outrank every revision this row ever published,
      // and only the row read under the scope knows that: a route-level read can
      // be arbitrarily stale (a completed rotation advances TWO revisions), and
      // the relay ignores a tombstone at or below the revision it already holds
      // — which would leave the deleted upstream and grant hashes live until
      // reconnect. All mutations serialize on this scope, so current + 1 is
      // strictly newer than any assignment still in flight.
      return { outcome: 'deleted' as const, tombstoneRevision: existing.revision + 1 }
    })
  }

  async deleteInstallation(id: string, orgId: OrgId): Promise<'deleted' | 'referenced' | 'not_found' | 'busy'> {
    return withTx(this.prisma, async (tx) => {
      if (!(await tryLockMemoryInstallationScope(tx, id))) return 'busy'
      const existing = await tx.memoryPluginInstallation.findUnique({ where: { id }, select: { orgId: true } })
      if (!existing || existing.orgId !== orgId) return 'not_found'
      const referencing = await tx.externalMemoryConnection.findFirst({
        where: { installationId: id },
        select: { id: true }
      })
      if (referencing) return 'referenced'
      await tx.memoryPluginInstallation.delete({ where: { id } })
      return 'deleted'
    })
  }
}
