/**
 * PgMcpProviderRepo + PgMcpProviderSecretStore + PgMcpGrantRepo
 * (docs/designs/centralized-tool-management.md §5-§7).
 *
 * Mirrors the Bot/Integration precedent (integration.repo.ts): the provider repo
 * is metadata-only — it NEVER selects the upstream headers or the grant keys, so
 * no read path above it can leak secret material. `PgMcpProviderSecretStore` is
 * the ONLY path to `mcp_provider_secret` (upstream auth headers) and
 * `PgMcpGrantRepo` the ONLY path to `mcp_grant` (bearer keys) — header values and
 * grant keys pass through the configured SecretCipher. `none` stores plaintext;
 * an encrypting provider stores ciphertext.
 */
import { mintGrantKey } from '../../orchestrator/mcpProvider.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { McpProvider, McpGrant } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  McpProviderRepo,
  McpProviderRecord,
  CreateMcpProviderInput,
  UpdateMcpProviderInput,
  McpProviderSecretStore,
  McpHeader,
  McpGrantRepo,
  McpGrantRecord,
  McpTransport,
  McpProviderKind,
  ResourceVisibility,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { DaemonId, OrgId } from '../../domain/ids.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'

function toProviderRecord(p: McpProvider): McpProviderRecord {
  return {
    id: p.id,
    orgId: OrgId(p.orgId),
    name: p.name,
    kind: p.kind as McpProviderKind,
    transport: p.transport as McpTransport,
    url: p.url,
    visibility: p.visibility as ResourceVisibility,
    sharedWith: p.sharedWith,
    createdByUserId: p.createdByUserId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

export class PgMcpProviderRepo implements McpProviderRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: CreateMcpProviderInput): Promise<McpProviderRecord> {
    return withAmbientTx(this.db, async (tx) => {
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: input.orgId,
        visibility: input.visibility ?? 'org',
        actorUserId: input.createdByUserId,
        sharedWith: input.sharedWith
      })
      const p = await tx.mcpProvider.create({
        data: {
          orgId: input.orgId,
          name: input.name,
          url: input.url,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.transport ? { transport: input.transport } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(memberships.sharedWith ? { sharedWith: memberships.sharedWith } : {}),
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
        }
      })
      return toProviderRecord(p)
    })
  }

  async get(orgId: OrgId, id: string): Promise<McpProviderRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const p = await this.db.mcpProvider.findUnique({ where: { id, orgId } })
    return p ? toProviderRecord(p) : null
  }

  // Same visibility filter as agents/daemons/crons: org-visible OR explicitly
  // selected (undefined ⇒ unfiltered internal read). See visibilityWhere.
  async listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<McpProviderRecord[]> {
    const rows = await this.db.mcpProvider.findMany({
      where: { orgId, ...visibilityWhere(viewer) },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toProviderRecord)
  }

  async setSharing(
    orgId: OrgId,
    id: string,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<McpProviderRecord> {
    return withAmbientTx(this.db, async (tx) => {
      // Org fence on the opening read: a cross-org id throws the same P2025 as
      // a missing row, before the membership lock or any write.
      const existing = await tx.mcpProvider.findUniqueOrThrow({
        where: { id, orgId },
        select: { orgId: true }
      })
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: existing.orgId,
        visibility: sharing.visibility,
        actorUserId: byUserId,
        sharedWith: sharing.sharedWith
      })
      const p = await tx.mcpProvider.update({
        where: { id, orgId },
        data: { visibility: sharing.visibility, sharedWith: memberships.sharedWith ?? [] }
      })
      return toProviderRecord(p)
    })
  }

  async listAll(): Promise<McpProviderRecord[]> {
    const rows = await this.db.mcpProvider.findMany({ orderBy: { createdAt: 'asc' } })
    return rows.map(toProviderRecord)
  }

  async update(orgId: OrgId, id: string, patch: UpdateMcpProviderInput): Promise<McpProviderRecord> {
    // Org-fenced update: a cross-org id throws the same P2025 as a missing row.
    const p = await this.db.mcpProvider.update({
      where: { id, orgId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.transport !== undefined ? { transport: patch.transport } : {})
      }
    })
    return toProviderRecord(p)
  }

  async delete(orgId: OrgId, id: string): Promise<void> {
    // Org-fenced delete: a cross-org id throws the same P2025 as a missing row.
    await this.db.mcpProvider.delete({ where: { id, orgId } }) // FK cascade drops secret + grants
  }

  // Org providers whose `name` is enabled by some agent placed on this daemon. The
  // enable-list lives in the agent's `runtimeOverrides.mcpServers` JSON (not a scalar
  // column), so collect the enabled names in app code, then point-query the providers.
  async activeForDaemon(daemonId: DaemonId): Promise<McpProviderRecord[]> {
    const agents = await this.db.agent.findMany({
      where: { daemonId },
      select: { orgId: true, runtimeOverrides: true }
    })
    const orgIds = new Set<string>()
    const names = new Set<string>()
    for (const a of agents) {
      orgIds.add(a.orgId)
      const ov = a.runtimeOverrides as { mcpServers?: string[] } | null
      for (const n of ov?.mcpServers ?? []) names.add(n)
    }
    if (names.size === 0) return []
    const rows = await this.db.mcpProvider.findMany({
      where: { orgId: { in: [...orgIds] }, name: { in: [...names] } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toProviderRecord)
  }
}

export class PgMcpProviderSecretStore implements McpProviderSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: OrgId, providerId: string, headers: McpHeader[]): Promise<void> {
    // The row is keyed by providerId alone, so the upsert cannot carry the org in
    // its predicate — check the parent row once instead.
    if ((await this.db.mcpProvider.count({ where: { id: providerId, orgId } })) === 0) {
      throw new Error('mcp provider secret write outside its organization')
    }
    // Header NAMES stay readable (they're config, not secrets); each VALUE passes
    // through the configured cipher before persistence.
    const scope = orgScope(orgId)
    const sealed = await Promise.all(
      headers.map(async (h) => ({ name: h.name, value: await this.cipher.seal(h.value, scope) }))
    )
    const value = sealed as unknown as Prisma.InputJsonValue
    await this.db.mcpProviderSecret.upsert({
      where: { mcpProviderId: providerId },
      create: { mcpProviderId: providerId, headers: value },
      update: { headers: value }
    })
  }

  async get(orgId: OrgId, providerId: string): Promise<McpHeader[] | null> {
    const s = await this.db.mcpProviderSecret.findFirst({
      where: { mcpProviderId: providerId, provider: { orgId } }
    })
    if (!s) return null
    const scope = orgScope(orgId)
    const stored = s.headers as unknown as McpHeader[]
    return Promise.all(stored.map(async (h) => ({ name: h.name, value: await this.cipher.open(h.value, scope) })))
  }

  async delete(orgId: OrgId, providerId: string): Promise<void> {
    // deleteMany → idempotent (the FK cascade may already have removed it).
    await this.db.mcpProviderSecret.deleteMany({ where: { mcpProviderId: providerId, provider: { orgId } } })
  }
}

function toGrantRecord(g: McpGrant): McpGrantRecord {
  return {
    id: g.id,
    mcpProviderId: g.mcpProviderId,
    key: g.key,
    status: g.status as McpGrantRecord['status'],
    createdAt: g.createdAt
  }
}

export class PgMcpGrantRepo implements McpGrantRepo {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async mintFor(orgId: OrgId, providerId: string): Promise<McpGrantRecord> {
    if ((await this.db.mcpProvider.count({ where: { id: providerId, orgId } })) === 0) {
      throw new Error('mcp grant mint outside its organization')
    }
    const key = mintGrantKey() // the one mint path (orchestrator/mcpProvider) — opaque, header-safe
    const g = await this.db.mcpGrant.create({
      data: { mcpProviderId: providerId, key: await this.cipher.seal(key, orgScope(orgId)) }
    })
    return { ...toGrantRecord(g), key } // callers get the plaintext they must ship, not the stored form
  }

  async activeForProvider(orgId: OrgId, providerId: string): Promise<McpGrantRecord[]> {
    const rows = await this.db.mcpGrant.findMany({
      where: { mcpProviderId: providerId, status: 'active', provider: { orgId } },
      orderBy: { createdAt: 'asc' }
    })
    const scope = orgScope(orgId)
    return Promise.all(rows.map(async (g) => ({ ...toGrantRecord(g), key: await this.cipher.open(g.key, scope) })))
  }

  async revoke(grantId: string): Promise<void> {
    // updateMany → idempotent (no throw if already gone / already revoked).
    await this.db.mcpGrant.updateMany({ where: { id: grantId }, data: { status: 'revoked' } })
  }
}
