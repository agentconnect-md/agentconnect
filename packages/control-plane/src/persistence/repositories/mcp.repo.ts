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
import type { McpProvider, McpGrant, AgentMcpToolPolicy } from '../../generated/prisma/client.js'
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
  McpAgentGrantRecord,
  McpGrantCustody,
  AgentMcpToolPolicyRepo,
  AgentMcpToolPolicyRecord,
  SaveAgentMcpToolPolicyInput,
  McpToolCatalogRepo,
  McpToolCatalogRecord,
  McpToolDecision,
  McpToolGroup,
  McpTransport,
  McpProviderKind,
  McpProviderAuthMode,
  ResourceVisibility,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { OrgId } from '../../domain/ids.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'

function toProviderRecord(p: McpProvider): McpProviderRecord {
  return {
    id: p.id,
    orgId: OrgId(p.orgId),
    name: p.name,
    kind: p.kind as McpProviderKind,
    auth: p.auth as McpProviderAuthMode,
    transport: p.transport as McpTransport,
    url: p.url,
    ui: p.ui,
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
          ...(input.auth ? { auth: input.auth } : {}),
          ...(input.transport ? { transport: input.transport } : {}),
          ...(input.ui !== undefined ? { ui: input.ui } : {}),
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
        ...(patch.transport !== undefined ? { transport: patch.transport } : {}),
        ...(patch.ui !== undefined ? { ui: patch.ui } : {})
      }
    })
    return toProviderRecord(p)
  }

  async delete(orgId: OrgId, id: string): Promise<void> {
    // Org-fenced delete: a cross-org id throws the same P2025 as a missing row.
    await this.db.mcpProvider.delete({ where: { id, orgId } }) // FK cascade drops secret + grants
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
    agentId: g.agentId,
    custody: g.custody as McpGrantCustody | null,
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
    return this.open(orgId, { mcpProviderId: providerId, agentId: null })
  }

  async mintForAgent(
    orgId: OrgId,
    providerId: string,
    agentId: string,
    custody: McpGrantCustody
  ): Promise<McpAgentGrantRecord> {
    const [providers, agents] = await Promise.all([
      this.db.mcpProvider.count({ where: { id: providerId, orgId } }),
      this.db.agent.count({ where: { id: agentId, orgId } })
    ])
    if (providers === 0 || agents === 0) throw new Error('mcp agent grant mint outside its organization')
    const key = mintGrantKey()
    const g = await this.db.mcpGrant.create({
      data: { mcpProviderId: providerId, agentId, custody, key: await this.cipher.seal(key, orgScope(orgId)) }
    })
    return { ...toGrantRecord(g), agentId, custody, key }
  }

  async activeForAgent(orgId: OrgId, providerId: string, agentId: string): Promise<McpAgentGrantRecord[]> {
    return (await this.open(orgId, { mcpProviderId: providerId, agentId })) as McpAgentGrantRecord[]
  }

  async activeRestricted(orgId: OrgId, providerId: string): Promise<McpAgentGrantRecord[]> {
    return (await this.open(orgId, { mcpProviderId: providerId, agentId: { not: null } })) as McpAgentGrantRecord[]
  }

  async activeOfAgent(orgId: OrgId, agentId: string): Promise<McpAgentGrantRecord[]> {
    return (await this.open(orgId, { agentId })) as McpAgentGrantRecord[]
  }

  /** Active grants matching `where` inside the org, oldest first, with their keys opened. */
  private async open(orgId: OrgId, where: Prisma.McpGrantWhereInput): Promise<McpGrantRecord[]> {
    const rows = await this.db.mcpGrant.findMany({
      where: { ...where, status: 'active', provider: { orgId } },
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

function toPolicyRecord(p: AgentMcpToolPolicy & { provider: { name: string } }): AgentMcpToolPolicyRecord {
  return {
    agentId: p.agentId,
    mcpProviderId: p.mcpProviderId,
    providerName: p.provider.name,
    groups: p.groups as Record<McpToolGroup, McpToolDecision>,
    overrides: p.overrides as Record<string, McpToolDecision>,
    allowTools: p.allowTools,
    approvalTools: p.approvalTools,
    askTools: p.askTools,
    catalogFetchedAt: p.catalogFetchedAt,
    updatedByUserId: p.updatedByUserId,
    updatedAt: p.updatedAt
  }
}

const WITH_PROVIDER_NAME = { provider: { select: { name: true } } } as const

export class PgAgentMcpToolPolicyRepo implements AgentMcpToolPolicyRepo {
  constructor(private readonly db: PrismaLike) {}

  async get(orgId: OrgId, agentId: string, providerId: string): Promise<AgentMcpToolPolicyRecord | null> {
    const row = await this.db.agentMcpToolPolicy.findFirst({
      where: { agentId, mcpProviderId: providerId, agent: { orgId }, provider: { orgId } },
      include: WITH_PROVIDER_NAME
    })
    return row ? toPolicyRecord(row) : null
  }

  async listForAgent(orgId: OrgId, agentId: string): Promise<AgentMcpToolPolicyRecord[]> {
    return this.list({ agentId, agent: { orgId } })
  }

  async listForProvider(orgId: OrgId, providerId: string): Promise<AgentMcpToolPolicyRecord[]> {
    return this.list({ mcpProviderId: providerId, provider: { orgId } })
  }

  async listForOrg(orgId: OrgId): Promise<AgentMcpToolPolicyRecord[]> {
    return this.list({ agent: { orgId } })
  }

  async save(
    orgId: OrgId,
    input: SaveAgentMcpToolPolicyInput
  ): Promise<{ policy: AgentMcpToolPolicyRecord; created: boolean }> {
    return withAmbientTx(this.db, async (tx) => {
      const [agents, providers] = await Promise.all([
        tx.agent.count({ where: { id: input.agentId, orgId } }),
        tx.mcpProvider.count({ where: { id: input.mcpProviderId, orgId } })
      ])
      if (agents === 0 || providers === 0) throw new Error('mcp tool policy write outside its organization')
      const key = { agentId_mcpProviderId: { agentId: input.agentId, mcpProviderId: input.mcpProviderId } }
      const existed = (await tx.agentMcpToolPolicy.count({ where: key.agentId_mcpProviderId })) > 0
      const data = {
        groups: input.groups as Prisma.InputJsonValue,
        overrides: input.overrides as Prisma.InputJsonValue,
        allowTools: input.allowTools,
        approvalTools: input.approvalTools,
        askTools: input.askTools,
        catalogFetchedAt: input.catalogFetchedAt,
        updatedByUserId: input.updatedByUserId
      }
      const row = await tx.agentMcpToolPolicy.upsert({
        where: key,
        create: { agentId: input.agentId, mcpProviderId: input.mcpProviderId, ...data },
        update: data,
        include: WITH_PROVIDER_NAME
      })
      // A first policy drops the provider from the spec an older daemon receives, so the spec's revision advances.
      if (!existed) await tx.agent.update({ where: { id: input.agentId }, data: { configRevision: { increment: 1 } } })
      return { policy: toPolicyRecord(row), created: !existed }
    })
  }

  async delete(orgId: OrgId, agentId: string, providerId: string): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      const { count } = await tx.agentMcpToolPolicy.deleteMany({
        where: { agentId, mcpProviderId: providerId, agent: { orgId } }
      })
      if (count > 0) await tx.agent.update({ where: { id: agentId }, data: { configRevision: { increment: 1 } } })
      return count > 0
    })
  }

  private async list(where: Prisma.AgentMcpToolPolicyWhereInput): Promise<AgentMcpToolPolicyRecord[]> {
    const rows = await this.db.agentMcpToolPolicy.findMany({
      where,
      include: WITH_PROVIDER_NAME,
      orderBy: [{ agentId: 'asc' }, { mcpProviderId: 'asc' }]
    })
    return rows.map(toPolicyRecord)
  }
}

export class PgMcpToolCatalogRepo implements McpToolCatalogRepo {
  constructor(private readonly db: PrismaLike) {}

  async get(orgId: OrgId, providerId: string): Promise<McpToolCatalogRecord | null> {
    const row = await this.db.mcpToolCatalog.findFirst({ where: { mcpProviderId: providerId, provider: { orgId } } })
    if (!row) return null
    return {
      mcpProviderId: row.mcpProviderId,
      tools: row.tools as unknown as McpToolCatalogRecord['tools'],
      fetchedAt: row.fetchedAt,
      failure: row.failure
    }
  }

  async put(orgId: OrgId, providerId: string, snapshot: Omit<McpToolCatalogRecord, 'mcpProviderId'>): Promise<void> {
    if ((await this.db.mcpProvider.count({ where: { id: providerId, orgId } })) === 0) {
      throw new Error('mcp tool catalog write outside its organization')
    }
    const data = {
      tools: snapshot.tools as unknown as Prisma.InputJsonValue,
      fetchedAt: snapshot.fetchedAt,
      failure: snapshot.failure
    }
    await this.db.mcpToolCatalog.upsert({
      where: { mcpProviderId: providerId },
      create: { mcpProviderId: providerId, ...data },
      update: data
    })
  }
}
