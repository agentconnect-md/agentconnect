/**
 * The two Linear provider-owned stores (docs/designs/linear-integration.md §7.2).
 *
 * `PgLinearTokenStore` is the ONLY read/write path for a connected workspace's OAuth grant. It is
 * keyed by the CONNECTION identity `(orgId, clientId, organizationId)` — never by the Bot row id —
 * so the callback can write the grant before the create tail mints the Bot, and member churn never
 * touches it (§4.4). Both token values pass through the injected `SecretCipher` under the org scope,
 * the same discipline as `bot_secret`; neither is ever returned in a DTO or logged.
 *
 * `PgLinearInstallStateStore` holds the connect funnel's one-shot OAuth `state` nonce and carries no
 * secret material, so it needs no cipher — only the shared reaper's `reapExpired` slice.
 */
import type { LinearInstallState, LinearToken } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  LinearConnectionIdentity,
  LinearInstallStateRecord,
  LinearInstallStateStore,
  LinearTokenMaterial,
  LinearTokenRecord,
  LinearTokenStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { AgentId, OrgId } from '../../domain/ids.js'

export class PgLinearTokenStore implements LinearTokenStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  // The scope comes from the CALLER's identity, never from `r.orgId`: the fence has to be something
  // the caller asserted, not something the row claims.
  private async toRecord(identity: LinearConnectionIdentity, r: LinearToken): Promise<LinearTokenRecord> {
    const scope = orgScope(identity.orgId)
    return {
      orgId: OrgId(r.orgId),
      clientId: r.clientId,
      organizationId: r.organizationId,
      accessToken: await this.cipher.open(r.accessToken, scope),
      // A grant issued without one has nothing to rotate with; re-connecting is the only repair.
      refreshToken: r.refreshToken ? await this.cipher.open(r.refreshToken, scope) : null,
      expiresAt: r.expiresAt,
      updatedAt: r.updatedAt
    }
  }

  private static key(identity: LinearConnectionIdentity) {
    return {
      orgId_clientId_organizationId: {
        orgId: identity.orgId,
        clientId: identity.clientId,
        organizationId: identity.organizationId
      }
    }
  }

  async get(identity: LinearConnectionIdentity): Promise<LinearTokenRecord | null> {
    const row = await this.prisma.linearToken.findUnique({ where: PgLinearTokenStore.key(identity) })
    return row ? this.toRecord(identity, row) : null
  }

  async put(identity: LinearConnectionIdentity, material: LinearTokenMaterial): Promise<void> {
    const scope = orgScope(identity.orgId)
    const tokens = {
      accessToken: await this.cipher.seal(material.accessToken, scope),
      refreshToken: material.refreshToken ? await this.cipher.seal(material.refreshToken, scope) : null,
      expiresAt: material.expiresAt
    }
    await this.prisma.linearToken.upsert({
      where: PgLinearTokenStore.key(identity),
      create: {
        orgId: identity.orgId,
        clientId: identity.clientId,
        organizationId: identity.organizationId,
        ...tokens
      },
      update: tokens
    })
  }

  async delete(identity: LinearConnectionIdentity): Promise<void> {
    // deleteMany so a disconnect of an already-swept identity is a no-op, not a throw.
    await this.prisma.linearToken.deleteMany({
      where: { orgId: identity.orgId, clientId: identity.clientId, organizationId: identity.organizationId }
    })
  }
}

function toInstallStateRecord(r: LinearInstallState): LinearInstallStateRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    defaultAgentId: r.defaultAgentId ? AgentId(r.defaultAgentId) : null,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt
  }
}

export class PgLinearInstallStateStore implements LinearInstallStateStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(input: {
    id: string
    orgId: OrgId
    defaultAgentId?: AgentId
    createdByUserId?: string
  }): Promise<LinearInstallStateRecord> {
    const row = await this.prisma.linearInstallState.create({
      data: {
        id: input.id,
        orgId: input.orgId,
        ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {})
      }
    })
    return toInstallStateRecord(row)
  }

  async get(id: string): Promise<LinearInstallStateRecord | null> {
    const row = await this.prisma.linearInstallState.findUnique({ where: { id } })
    return row ? toInstallStateRecord(row) : null
  }

  async delete(id: string): Promise<void> {
    // deleteMany so a double callback / already-reaped row is a no-op, not a throw.
    await this.prisma.linearInstallState.deleteMany({ where: { id } })
  }

  async reapExpired(staleBefore: Date): Promise<number> {
    const res = await this.prisma.linearInstallState.deleteMany({ where: { createdAt: { lt: staleBefore } } })
    return res.count
  }
}
