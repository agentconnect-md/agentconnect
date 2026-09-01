/**
 * PgBotRepo + PgBotSecretStore + PgIntegrationRepo (design §3.15).
 *
 * A bot is the durable identity (name + token material); an integration is the
 * install binding it to one agent. `PgBotRepo`/`PgIntegrationRepo` are
 * metadata-only — they NEVER select the token columns, so no read path above
 * them can leak a token. `PgBotSecretStore` is the ONLY path to `bot_secret`;
 * every value passes through the configured SecretCipher. `none` stores
 * plaintext; an encrypting provider stores ciphertext without changing
 * routes/protocol/daemon.
 */
import type { Platform, FeishuRegion } from '@agentconnect.md/protocol'
import type { Bot, Integration, IntegrationChannel, User } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { BotExternalIdentityTaken, BotMissing, BotStillShared } from '../errors.js'
import type {
  BotRepo,
  BotIdentityProjector,
  BotRecord,
  BotUpdate,
  CreateBotInput,
  BotSecretStore,
  BotSecretMaterial,
  IntegrationRepo,
  IntegrationRecord,
  ChannelAgentRecord,
  ChannelPlacementRecord,
  CreateIntegrationInput,
  IntegrationStatus,
  IntegrationChannelRepo,
  IntegrationChannelRecord,
  IntegrationChannelNameRecord,
  ConversationCoordinate,
  ReportedChannel,
  ChannelTrigger,
  ConversationKind,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import { toDbPlatform } from '../platform.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { AgentId, BotId, DaemonId, IntegrationId, OrgId } from '../../domain/ids.js'

// The bot row plus its joined creator and current installs (for `agentIds` /
// `inUseByAgentId`). A shareable bot fans out to many active integrations, so we
// join the LIST (ordered) rather than the old 0-or-1 relation.
type BotJoined = Bot & {
  createdBy: User | null
  integrations: { agentId: string; status: string }[]
}
const botInclude = {
  createdBy: true,
  integrations: { select: { agentId: true, status: true }, orderBy: { createdAt: 'asc' } }
} as const

/** The bag is `Json`, so a hand-edited row can hold anything. Read it the way any
 *  untrusted map is read: a non-string is absent, never coerced. */
function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toBotRecord(b: BotJoined): BotRecord {
  const active = b.integrations.filter((i) => i.status === 'active')
  const platformConfig = (b.platformConfig as Record<string, unknown> | null) ?? null
  const cfg = platformConfig ?? {}
  return {
    id: BotId(b.id),
    orgId: OrgId(b.orgId),
    platform: b.platform as Platform,
    name: b.name,
    prebuilt: b.prebuilt,
    slackAppId: b.slackAppId,
    teamId: b.teamId,
    externalAppId: b.externalAppId,
    externalTenantId: b.externalTenantId,
    platformConfig: platformConfig,
    workspaceId: b.workspaceId,
    workspaceName: b.workspaceName,
    botUserId: b.botUserId,
    revokedAt: b.revokedAt,
    credentialRevision: b.credentialRevision,
    credentialInstalledAt: b.credentialInstalledAt,
    // The column cannot be NULL (Prisma scalar list), so empty encodes "never
    // observed". The RECORD restores the tri-state the readers contract on:
    // null = unknown grant, non-empty = the observed set.
    grantedScopes: b.grantedScopes.length > 0 ? b.grantedScopes : null,
    // Projected out of the generic bag, which is where every write puts them
    // (`CpPlatformProvider.projectBotIdentity`). The named fields stay on the
    // RECORD because that is a domain type with named platform metadata, not a
    // column list — the bag is a storage decision, so it stops at this seam.
    discordAppId: asText(cfg.discordAppId),
    feishuAppId: asText(cfg.feishuAppId),
    feishuRegion: (asText(cfg.feishuRegion) as FeishuRegion | null) ?? null,
    shareable: b.shareable,
    transport: b.transport as BotRecord['transport'],
    preferredAgentId: b.preferredAgentId ? AgentId(b.preferredAgentId) : null,
    createdBy: b.createdBy
      ? { userId: b.createdBy.id, displayName: b.createdBy.displayName, email: b.createdBy.email }
      : null,
    lastUsedAt: b.lastUsedAt,
    lastAgentName: b.lastAgentName,
    agentIds: active.map((i) => AgentId(i.agentId)),
    // A shareable bot lifts the 1-install cap, so it is never reuse-blocked; a
    // non-shareable bot (socket, or http single-agent) keeps the 1-install cap.
    inUseByAgentId: !b.shareable && active[0] ? AgentId(active[0].agentId) : null,
    createdAt: b.createdAt
  }
}

export class PgBotRepo implements BotRepo {
  /**
   * @param projectIdentity The per-platform D6 identity projection
   *   ({@link BotIdentityProjector}). The composition root wires it from the
   *   platform registry; the four-arm `switch (input.platform)` it replaced was
   *   the last piece of per-platform knowledge in this file (audit F13).
   *
   *   Defaulted so the transaction-scoped instances that only bump or revoke a
   *   credential (`bot-credential.writer.ts`) need not carry it. A `create`
   *   through an unwired repo is a composition bug, not a row with a quietly
   *   absent identity, so it THROWS rather than writing the NULLs §11 reserves
   *   for legacy rows.
   */
  constructor(
    private readonly db: PrismaLike,
    private readonly projectIdentity: BotIdentityProjector = () => {
      throw new Error('PgBotRepo.create needs a bot-identity projector (wire it from the platform registry)')
    }
  ) {}

  async create(input: CreateBotInput): Promise<BotRecord> {
    // The D6 generic identity (§11) — the row's only demux identity, and what
    // the composite unique fences on. Written for every NEW row, whichever
    // platform and whichever install path produced it. Resolved BEFORE the write
    // so an unwired projector surfaces as itself rather than as something the
    // P2002 mapping below has to survive.
    const identity = this.projectIdentity(input)
    try {
      const b = await this.db.bot.create({
        data: {
          id: input.id,
          orgId: input.orgId,
          platform: toDbPlatform(input.platform),
          name: input.name,
          ...(input.prebuilt !== undefined ? { prebuilt: input.prebuilt } : {}),
          ...(input.slackAppId ? { slackAppId: input.slackAppId } : {}),
          ...(input.teamId ? { teamId: input.teamId } : {}),
          ...identity,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
          ...(input.botUserId ? { botUserId: input.botUserId } : {}),
          ...(input.shareable !== undefined ? { shareable: input.shareable } : {}),
          ...(input.transport !== undefined ? { transport: input.transport } : {}),
          // Only a non-empty observed set is worth writing: empty is the
          // column's "never observed" encoding, which the default already says.
          ...(input.grantedScopes && input.grantedScopes.length > 0 ? { grantedScopes: input.grantedScopes } : {}),
          // Generation 1 (the column default) lands NOW — so a lifecycle event that
          // predates this credential is fenced out even on a bot's first install.
          // Legacy rows keep a null stamp and fall back to the revision arm alone.
          credentialInstalledAt: new Date(),
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
        },
        include: botInclude
      })
      return toBotRecord(b)
    } catch (err) {
      // The composite unique fired: a bot with this external app identity already
      // exists on this platform. Typed so routes can 409 instead of 500.
      if (
        (err as { code?: string }).code === 'P2002' &&
        String((err as { meta?: { target?: unknown } }).meta?.target ?? '').includes('externalAppId')
      ) {
        throw new BotExternalIdentityTaken(input.platform)
      }
      throw err
    }
  }

  async get(orgId: OrgId, id: BotId): Promise<BotRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const b = await this.db.bot.findUnique({ where: { id, orgId }, include: botInclude })
    return b ? toBotRecord(b) : null
  }

  async getUnscoped(id: BotId): Promise<BotRecord | null> {
    const b = await this.db.bot.findUnique({ where: { id }, include: botInclude })
    return b ? toBotRecord(b) : null
  }

  async listForOrg(orgId: OrgId): Promise<BotRecord[]> {
    const rows = await this.db.bot.findMany({ where: { orgId }, include: botInclude, orderBy: { createdAt: 'asc' } })
    return rows.map(toBotRecord)
  }

  async setWorkspaceMetadata(
    orgId: OrgId,
    id: BotId,
    workspaceId: string,
    workspaceName: string | null
  ): Promise<void> {
    // Org fence rides the unique update (extended where): a cross-org id throws
    // the same P2025 as a missing row (org-scoped-data-layer.md §3), preserving
    // this method's existing missing-row behaviour rather than inventing a new one.
    await this.db.bot.update({
      where: { id, orgId },
      data: {
        workspaceId,
        ...(workspaceName ? { workspaceName } : {})
      }
    })
  }

  async setGrantedScopes(orgId: OrgId, id: BotId, scopes: readonly string[]): Promise<void> {
    // Advisory capability metadata: a cross-org (or vanished) id writes nothing
    // rather than throwing — no caller has a recovery beyond "keep going".
    await this.db.bot.updateMany({ where: { id, orgId }, data: { grantedScopes: [...scopes] } })
  }

  async listSlackMissingIdentity(): Promise<BotRecord[]> {
    const rows = await this.db.bot.findMany({
      where: {
        platform: 'slack',
        OR: [
          { transport: 'http', slackAppId: null },
          { workspaceId: null },
          { workspaceName: null },
          { botUserId: null }
        ]
      },
      include: botInclude,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBotRecord)
  }

  async setSlackAppIdIfMissing(id: BotId, slackAppId: string): Promise<boolean> {
    // Both in one statement, so the demux identity and the console's deep-link id
    // can never disagree. The tenant half stays NULL: this backfills a socket bot
    // that never captured a workspace, and NULL is what keeps such rows distinct
    // under the composite unique.
    const result = await this.db.bot.updateMany({
      where: { id, slackAppId: null },
      data: { slackAppId, externalAppId: slackAppId }
    })
    return result.count === 1
  }

  async setSlackBotUserIdIfMissing(id: BotId, botUserId: string): Promise<boolean> {
    const result = await this.db.bot.updateMany({
      where: { id, botUserId: null },
      data: { botUserId }
    })
    return result.count === 1
  }

  async markFreed(orgId: OrgId, id: BotId, at: Date, lastAgentName: string | null): Promise<void> {
    // Org-fenced like `setWorkspaceMetadata`: cross-org and missing are the same P2025.
    await this.db.bot.update({ where: { id, orgId }, data: { lastUsedAt: at, lastAgentName } })
  }

  async update(orgId: OrgId, id: BotId, patch: BotUpdate): Promise<void> {
    // Serialized on the bot row: membership admission (addBotMembership) takes
    // the same lock, so a disable can never commit alongside a concurrent
    // second-agent admission — whichever wins, the loser observes the winner's
    // committed state. The capacity recount lives HERE (not only in the route's
    // optimistic pre-check) because only under the lock is it authoritative.
    //
    // Both columns move in ONE statement inside that transaction. Split writes could
    // commit the capacity flip and then fail the preferred agent's FK against a
    // concurrent agent delete — a half-applied update the caller cannot undo.
    await withAmbientTx(this.db, async (tx) => {
      // The org fence rides the row-lock read and refuses BEFORE the recount:
      // reaching the recount with a foreign id would answer `BotStillShared`
      // (a 409 carrying the foreign bot's occupancy) instead of the missing-row
      // 404 the tenancy fence owes (org-scoped-data-layer.md §3).
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM bot WHERE id = ${id} AND "orgId" = ${orgId} FOR UPDATE`
      if (locked.length === 0) throw new BotMissing(id)
      if (patch.shareable === false) {
        const active = await tx.integration.count({ where: { botId: id, status: 'active' } })
        if (active > 1) throw new BotStillShared(active)
      }
      await tx.bot.update({
        where: { id, orgId },
        data: {
          ...(patch.shareable !== undefined ? { shareable: patch.shareable } : {}),
          ...(patch.preferredAgentId !== undefined ? { preferredAgentId: patch.preferredAgentId } : {})
        }
      })
    })
  }

  async listHttpActive(): Promise<BotRecord[]> {
    // http-transport bots with ≥1 ACTIVE install — the orchestrator's convergence set.
    const rows = await this.db.bot.findMany({
      where: { transport: 'http', integrations: { some: { status: 'active' } } },
      include: botInclude,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBotRecord)
  }

  async workspaceClaimedElsewhere(
    orgId: OrgId,
    platform: string,
    appId: string,
    workspaceId: string
  ): Promise<boolean> {
    // Cross-org on purpose (the admission question IS cross-org), boolean on
    // purpose (no foreign row crosses the seam) — ingress-tenant-fence.md §5.
    //
    // The app id matches EITHER column. Every write that sets a Slack app id sets
    // the generic one in the same statement (`create` via the projector,
    // `setSlackAppIdIfMissing` explicitly), so `slackAppId` alone should be
    // unreachable — but nothing in the SCHEMA enforces that, and the cost of
    // being wrong here is one organization capturing another's workspace. A
    // second predicate is a cheap price for not resting a cross-org fence on an
    // invariant the database does not hold.
    const held = await this.db.bot.count({
      where: {
        platform: toDbPlatform(platform),
        workspaceId,
        NOT: { orgId },
        OR: [{ externalAppId: appId }, { slackAppId: appId }]
      }
    })
    return held > 0
  }

  async getByExternalIdentity(
    platform: string,
    externalAppId: string,
    externalTenantId: string
  ): Promise<BotRecord | null> {
    // Cross-org on purpose: an external app identity binds to exactly one org — a
    // workspace install of a distributed app is global — and a second org's claim
    // must find it wherever it lives in order to refuse.
    const b = await this.db.bot.findUnique({
      where: { platform_externalAppId_externalTenantId: { platform, externalAppId, externalTenantId } },
      include: botInclude
    })
    return b ? toBotRecord(b) : null
  }

  async bumpCredential(id: BotId, at: Date): Promise<number> {
    // One statement: the generation advance, its timestamp, and clearing the
    // revocation marker are the SAME event ("a fresh credential landed"). A
    // reader can never observe a live bot whose generation still matches a
    // report that was already in flight for the dead credential.
    const row = await this.db.bot.update({
      where: { id },
      data: { credentialRevision: { increment: 1 }, credentialInstalledAt: at, revokedAt: null },
      select: { credentialRevision: true }
    })
    return row.credentialRevision
  }

  async revokeIfCurrent(id: BotId, at: Date, fence: { revision?: number; eventAt?: Date }): Promise<boolean> {
    // CAS in the WHERE clause — no read-then-write window. Both predicates are
    // conjunctive and each is skipped when the report didn't carry it (fail-open:
    // an uninstall must eventually take effect). `credentialInstalledAt: null`
    // (a bot predating the fence) also passes the timestamp arm via the OR.
    const { count } = await this.db.bot.updateMany({
      where: {
        id,
        ...(fence.revision !== undefined ? { credentialRevision: fence.revision } : {}),
        ...(fence.eventAt
          ? { OR: [{ credentialInstalledAt: null }, { credentialInstalledAt: { lt: fence.eventAt } }] }
          : {})
      },
      data: { revokedAt: at }
    })
    return count > 0
  }

  async delete(orgId: OrgId, id: BotId): Promise<void> {
    // Org-fenced delete: FK cascade drops bot_secret, Restrict blocks while
    // installed, and a cross-org id throws the same P2025 as an absent row.
    await this.db.bot.delete({ where: { id, orgId } })
  }
}

export class PgBotSecretStore implements BotSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: OrgId, botId: BotId, material: BotSecretMaterial): Promise<void> {
    // `bot_secret` is keyed by botId alone, so the upsert below cannot carry the
    // org in its predicate — check the parent row once instead. A mismatch is a
    // caller bug: refuse rather than seal one org's material onto another's bot.
    if ((await this.db.bot.count({ where: { id: botId, orgId } })) === 0) {
      throw new Error('bot secret write outside its organization')
    }
    const scope = orgScope(orgId)
    const sealed = {
      botToken: await this.cipher.seal(material.botToken, scope),
      appToken: material.appToken === null ? null : await this.cipher.seal(material.appToken, scope),
      signingSecret: material.signingSecret === null ? null : await this.cipher.seal(material.signingSecret, scope),
      verificationToken:
        material.verificationToken == null ? null : await this.cipher.seal(material.verificationToken, scope),
      encryptKey: material.encryptKey == null ? null : await this.cipher.seal(material.encryptKey, scope)
    }
    await this.db.botSecret.upsert({
      where: { botId },
      create: { botId, ...sealed },
      update: sealed
    })
  }

  async get(orgId: OrgId, botId: BotId): Promise<BotSecretMaterial | null> {
    // Fences through the parent relation: a cross-org pair reads as "no row".
    const s = await this.db.botSecret.findFirst({ where: { botId, bot: { orgId } } })
    if (!s) return null
    const scope = orgScope(orgId)
    return {
      botToken: await this.cipher.open(s.botToken, scope),
      appToken: s.appToken === null ? null : await this.cipher.open(s.appToken, scope),
      signingSecret: s.signingSecret === null ? null : await this.cipher.open(s.signingSecret, scope),
      verificationToken: s.verificationToken === null ? null : await this.cipher.open(s.verificationToken, scope),
      encryptKey: s.encryptKey === null ? null : await this.cipher.open(s.encryptKey, scope)
    }
  }

  async delete(orgId: OrgId, botId: BotId): Promise<void> {
    // deleteMany → idempotent (the FK cascade may already have removed it).
    await this.db.botSecret.deleteMany({ where: { botId, bot: { orgId } } })
  }
}

function toRecord(i: Integration): IntegrationRecord {
  return {
    id: IntegrationId(i.id),
    orgId: OrgId(i.orgId),
    agentId: AgentId(i.agentId),
    botId: BotId(i.botId),
    platform: i.platform as Platform,
    name: i.name,
    status: i.status as IntegrationStatus,
    ...(i.feishuRegion ? { feishuRegion: i.feishuRegion as FeishuRegion } : {}),
    createdAt: i.createdAt
  }
}

export class PgIntegrationRepo implements IntegrationRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: CreateIntegrationInput): Promise<IntegrationRecord> {
    const i = await this.db.integration.create({
      data: {
        id: input.id,
        orgId: input.orgId,
        agentId: input.agentId,
        botId: input.botId,
        platform: toDbPlatform(input.platform),
        name: input.name,
        ...(input.feishuRegion ? { feishuRegion: input.feishuRegion } : {}),
        ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
      }
    })
    return toRecord(i)
  }

  async addBotMembership(
    input: CreateIntegrationInput
  ): Promise<
    | { outcome: 'added' | 'exists'; integration: IntegrationRecord }
    | { outcome: 'not_shareable' }
    | { outcome: 'revoked' }
  > {
    // Atomic bot-membership admission (the platform "Add to Slack" re-install
    // AND the generic reuse path): the bot row is LOCKED, so `shareable`,
    // `revokedAt`, and the active membership set read below are stable through
    // the insert — a concurrent sharing toggle (BotRepo.update takes the same
    // lock), a credential revoke (BotCredentialWriter.revoke opens with the
    // bot-row CAS), or a concurrent duplicate admission serializes here instead
    // of racing an earlier snapshot of the handler.
    return await withAmbientTx(this.db, async (tx) => {
      const locked = await tx.$queryRaw<
        { shareable: boolean; revokedAt: Date | null }[]
      >`SELECT shareable, "revokedAt" FROM bot WHERE id = ${input.botId} FOR UPDATE`
      // Bot vanished mid-flight (delete race) — nothing to admit onto; the
      // caller's refusal path is close enough for this exotic window.
      if (!locked[0]) return { outcome: 'not_shareable' as const }
      // A revoke that won the lock flipped every install AND stamped the bot:
      // admitting after it would mint a live membership on a dead credential
      // (the zero-active read below would otherwise wave it through).
      if (locked[0].revokedAt) return { outcome: 'revoked' as const }
      const active = await tx.integration.findMany({ where: { botId: input.botId, status: 'active' } })
      // Idempotent per (bot, agent): the loser of two concurrent same-agent
      // admissions lands here and reports the winner's row as success.
      const mine = active.find((i) => i.agentId === input.agentId)
      if (mine) return { outcome: 'exists' as const, integration: toRecord(mine) }
      if (active.length > 0 && !locked[0].shareable) return { outcome: 'not_shareable' as const }
      const created = await tx.integration.create({
        data: {
          id: input.id,
          orgId: input.orgId,
          agentId: input.agentId,
          botId: input.botId,
          platform: toDbPlatform(input.platform),
          name: input.name,
          ...(input.feishuRegion ? { feishuRegion: input.feishuRegion } : {}),
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
        }
      })
      return { outcome: 'added' as const, integration: toRecord(created) }
    })
  }

  async get(orgId: OrgId, id: IntegrationId): Promise<IntegrationRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const i = await this.db.integration.findUnique({ where: { id, orgId } })
    return i ? toRecord(i) : null
  }

  async getUnscoped(id: IntegrationId): Promise<IntegrationRecord | null> {
    const i = await this.db.integration.findUnique({ where: { id } })
    return i ? toRecord(i) : null
  }

  async listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<IntegrationRecord[]> {
    // Derived visibility: an integration inherits its parent agent's visibility.
    // Every human principal filters through the `agent` relation; an undefined
    // internal viewer produces `agent: {}` and stays unfiltered.
    const rows = await this.db.integration.findMany({
      where: { orgId, agent: { ...visibilityWhere(viewer) } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async listForAgent(agentId: AgentId): Promise<IntegrationRecord[]> {
    const rows = await this.db.integration.findMany({
      where: { agentId, status: 'active' },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  // Active integrations whose owning agent is placed on this daemon — the join that
  // keeps `register/ok.integrations[]` daemon-scoped (never org-wide token broadcast).
  async activeForDaemon(daemonId: DaemonId): Promise<IntegrationRecord[]> {
    const rows = await this.db.integration.findMany({
      where: { status: 'active', agent: { daemonId } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  // The duty half of that roster: the ledger names the agents, not the placement.
  async activeForAgents(agentIds: readonly string[]): Promise<IntegrationRecord[]> {
    if (agentIds.length === 0) return []
    const rows = await this.db.integration.findMany({
      where: { status: 'active', agentId: { in: [...agentIds] } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  // Agent-collaboration directory: agents present in a channel, ACROSS all daemons
  // (the CP is the only authority for the full roster). Join the channel's active
  // integrations to their agents; dedupe by agent (an agent may reach a channel via
  // more than one integration). Metadata only — no tokens.
  async agentsInChannel(orgId: OrgId, platform: Platform, channelId: string): Promise<ChannelAgentRecord[]> {
    const rows = await this.db.integration.findMany({
      where: {
        orgId,
        platform: toDbPlatform(platform),
        status: 'active',
        channels: { some: { channelId } }
      },
      select: {
        agent: {
          select: {
            id: true,
            name: true,
            displayName: true,
            description: true,
            status: true,
            callPolicy: true,
            allowedCallerAgentIds: true,
            outboundPolicy: true,
            allowedTargetAgentIds: true
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    })
    const byId = new Map<string, ChannelAgentRecord>()
    for (const { agent: a } of rows) {
      if (!byId.has(a.id)) {
        byId.set(a.id, {
          agentId: AgentId(a.id),
          name: a.name,
          displayName: a.displayName,
          description: a.description,
          status: a.status as ChannelAgentRecord['status'],
          callPolicy: a.callPolicy as ChannelAgentRecord['callPolicy'],
          allowedCallerAgentIds: a.allowedCallerAgentIds,
          outboundPolicy: a.outboundPolicy as ChannelAgentRecord['outboundPolicy'],
          allowedTargetAgentIds: a.allowedTargetAgentIds
        })
      }
    }
    return [...byId.values()]
  }

  async channelPlacements(orgId: OrgId): Promise<ChannelPlacementRecord[]> {
    // Every active integration in the org, joined to its agent (placement + policy)
    // and the channels it reaches. One row per (integration, channel); the caller
    // groups by (platform, channel). Dedupe per (channel, agent) deterministically —
    // earliest active integration wins the DEFINITE integrationId (§6.2, no fallback).
    const rows = await this.db.integration.findMany({
      where: { orgId, status: 'active' },
      select: {
        id: true,
        platform: true,
        // `botUserId` is the public member id a `<@…>` resolves to. Whether it is
        // shared is conversation-scoped and is derived from the complete placement set
        // in `buildCollabSnapshot`; the bot's `shareable` capacity flag is not identity.
        bot: { select: { slackAppId: true, botUserId: true } },
        agent: {
          select: {
            id: true,
            name: true,
            displayName: true,
            daemonId: true,
            callPolicy: true,
            allowedCallerAgentIds: true,
            outboundPolicy: true,
            allowedTargetAgentIds: true
          }
        },
        channels: { select: { channelId: true } }
      },
      orderBy: { createdAt: 'asc' }
    })
    // (platform, channelId, agentId) → the first (earliest) placement seen.
    const seen = new Map<string, ChannelPlacementRecord>()
    for (const i of rows) {
      const platform = i.platform as Platform
      for (const ch of i.channels) {
        const key = `${platform}\u0000${ch.channelId}\u0000${i.agent.id}`
        if (seen.has(key)) continue
        seen.set(key, {
          platform,
          channelId: ch.channelId,
          agentId: AgentId(i.agent.id),
          daemonId: i.agent.daemonId,
          integrationId: IntegrationId(i.id),
          ...(platform === 'slack' && i.bot.slackAppId ? { botAppId: i.bot.slackAppId } : {}),
          ...(platform === 'slack' && i.bot.botUserId ? { botUserId: i.bot.botUserId } : {}),
          callPolicy: i.agent.callPolicy as ChannelPlacementRecord['callPolicy'],
          allowedCallerAgentIds: i.agent.allowedCallerAgentIds,
          outboundPolicy: i.agent.outboundPolicy as ChannelPlacementRecord['outboundPolicy'],
          allowedTargetAgentIds: i.agent.allowedTargetAgentIds,
          name: i.agent.name,
          ...(i.agent.displayName != null ? { displayName: i.agent.displayName } : {})
        })
      }
    }
    return [...seen.values()]
  }

  async listForBot(botId: BotId): Promise<IntegrationRecord[]> {
    const rows = await this.db.integration.findMany({
      where: { botId, status: 'active' },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async markRevokedForBot(botId: BotId, credentialRevision: number): Promise<IntegrationId[]> {
    // Read-then-flip inside one statement pair: the ids are needed by the caller
    // (spec removal per daemon), and updateMany returns only a count.
    const rows = await this.db.integration.findMany({
      where: { botId, status: 'active' },
      select: { id: true }
    })
    if (rows.length === 0) return []
    await this.db.integration.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'revoked', revokedCredentialRevision: credentialRevision }
    })
    return rows.map((r) => IntegrationId(r.id))
  }

  async restoreRevokedForBot(botId: BotId, credentialRevision: number): Promise<number> {
    const { count } = await this.db.integration.updateMany({
      where: { botId, status: 'revoked', revokedCredentialRevision: credentialRevision },
      data: { status: 'active', revokedCredentialRevision: null }
    })
    return count
  }

  async delete(orgId: OrgId, id: IntegrationId): Promise<void> {
    // Org-fenced delete: a cross-org id throws the same P2025 as an absent row.
    await this.db.integration.delete({ where: { id, orgId } })
  }
}

function toChannelRecord(c: IntegrationChannel): IntegrationChannelRecord {
  return {
    integrationId: IntegrationId(c.integrationId),
    channelId: c.channelId,
    name: c.name,
    spaceId: c.spaceId,
    space: c.space,
    isPrivate: c.isPrivate,
    kind: c.kind as ConversationKind,
    trigger: c.trigger as ChannelTrigger,
    dmUserId: c.dmUserId,
    triggerChosen: c.triggerChosen,
    agentId: c.agentId ? AgentId(c.agentId) : null
  }
}

export class PgIntegrationChannelRepo implements IntegrationChannelRepo {
  constructor(private readonly db: PrismaLike) {}

  // Converge to a daemon channel report: refresh supplied metadata on known
  // conversations (PRESERVING the operator's trigger), insert new ones (trigger =
  // `defaultTrigger`, otherwise On for a 1:1 DM and Mention for a room), and, for an
  // authoritative membership snapshot, drop channel rows that are no longer present.
  // DM rows and rows omitted from a non-authoritative observed-conversation report
  // are retained.
  //
  // The channel→DM transition is decided INSIDE the write, off the row's committed kind,
  // never off a prior read. Channel reports are fire-and-forget and their handlers run
  // concurrently — the daemon's own startup emits a kind-less snapshot and the resolver's
  // later `saveScope` emits the same conversation as `im`. Two such writes racing with a
  // read-then-write would both see "no row": the first creates channel/mention, the
  // second flips the kind and inherits that trigger, landing exactly on the fail-open
  // state above. `ON CONFLICT … DO UPDATE` re-reads the row under the write's own lock,
  // so the conversion cannot be missed however the reports interleave.
  async replaceSnapshot(
    integrationId: IntegrationId,
    channels: ReportedChannel[],
    opts?: {
      defaultTrigger?: ChannelTrigger
      defaultTriggerByChannel?: ReadonlyMap<string, ChannelTrigger>
      authoritative?: boolean
      removed?: string[]
    }
  ): Promise<void> {
    if (opts?.authoritative !== false) {
      await this.db.integrationChannel.deleteMany({
        where: { integrationId, kind: 'channel', channelId: { notIn: channels.map((c) => c.id) } }
      })
    }
    // A conversation named as removed is not re-created by the same report, so the
    // retraction wins over a stale entry the reporter also happened to list.
    const removed = new Set(opts?.removed ?? [])
    const authoritative = opts?.authoritative !== false
    for (const c of channels) {
      if (removed.has(c.id)) continue
      // Which columns a re-report is allowed to overwrite. An absent name/isPrivate is
      // authoritative-only (a partial report must not blank them); an absent space keeps
      // the known server (it resolves lazily at the edge); an absent kind must never
      // downgrade an established 'im' row.
      const setName = authoritative || c.name !== undefined
      const setPrivate = authoritative || c.isPrivate !== undefined
      // Direct conversations are observed rather than enumerated. Restricted installs
      // pass `defaultTrigger:'off'`; Everyone installs default a 1:1 DM On and a group
      // DM to Mention. An authoritative channel snapshot cannot delete either kind.
      const direct = c.kind === 'im' || c.kind === 'mpim'
      // A per-conversation seed (§14.8) outranks the install-wide default; both seed a
      // NEW row only, and a late channel→direct conversion re-applies whichever won.
      const createTrigger: ChannelTrigger =
        opts?.defaultTriggerByChannel?.get(c.id) ?? opts?.defaultTrigger ?? (c.kind === 'im' ? 'any' : 'mention')
      await this.db.$executeRaw`
        INSERT INTO "integration_channel"
          ("integrationId", "channelId", "name", "spaceId", "space", "isPrivate", "kind", "trigger",
           "dmUserId", "firstSeenAt", "updatedAt")
        VALUES (
          ${integrationId}::uuid, ${c.id}, ${c.name ?? null}, ${c.spaceId ?? null}, ${c.space ?? null},
          ${c.isPrivate ?? false}, ${c.kind ?? 'channel'}::"ConversationKind",
          ${createTrigger}::"ChannelTrigger", ${c.dmUserId ?? null}, NOW(), NOW()
        )
        ON CONFLICT ("integrationId", "channelId") DO UPDATE SET
          "name" = CASE WHEN ${setName}::boolean THEN EXCLUDED."name" ELSE "integration_channel"."name" END,
          "spaceId" = CASE WHEN ${c.spaceId !== undefined}::boolean THEN EXCLUDED."spaceId"
                           ELSE "integration_channel"."spaceId" END,
          "space" = CASE WHEN ${c.space !== undefined}::boolean THEN EXCLUDED."space"
                         ELSE "integration_channel"."space" END,
          "isPrivate" = CASE WHEN ${setPrivate}::boolean THEN EXCLUDED."isPrivate"
                             ELSE "integration_channel"."isPrivate" END,
          -- Learned once and never unlearned: an omitting report (a channel snapshot, an
          -- older reporter) must not blank the member a DM row is with.
          "dmUserId" = CASE WHEN ${c.dmUserId !== undefined}::boolean THEN EXCLUDED."dmUserId"
                            ELSE "integration_channel"."dmUserId" END,
          -- A committed direct kind is never downgraded back to 'channel'. Slack
          -- classifies a group DM late, so a daemon that has lost its cache (a restart,
          -- a snapshot refresh) re-reports the conversation as a provisional 'channel'
          -- before conversations.info corrects it. Accepting that would flip the row
          -- twice and, through the fail-closed conversion below, silently reset an
          -- operator's enabled trigger to Off on every restart. The classification lives
          -- here, not in daemon memory.
          "kind" = CASE
            WHEN ${c.kind !== undefined}::boolean
              AND NOT (
                "integration_channel"."kind" IN ('im'::"ConversationKind", 'mpim'::"ConversationKind")
                AND EXCLUDED."kind" = 'channel'::"ConversationKind"
              )
              THEN EXCLUDED."kind"
            ELSE "integration_channel"."kind"
          END,
          -- Resolve a late channel→direct classification against the COMMITTED kind.
          -- The row receives this installation's direct-conversation default; a row
          -- already of the reported kind keeps whatever the operator set.
          "trigger" = CASE
            WHEN ${direct}::boolean AND "integration_channel"."kind" <> EXCLUDED."kind"
              THEN ${createTrigger}::"ChannelTrigger"
            ELSE "integration_channel"."trigger"
          END,
          "updatedAt" = NOW()
      `
    }
    // Retractions last: a conversation the reporter says it left is gone whatever
    // its kind, including a DM row that no authoritative snapshot could ever delete.
    if (removed.size > 0) {
      await this.db.integrationChannel.deleteMany({
        where: { integrationId, channelId: { in: [...removed] } }
      })
    }
  }

  async deleteChannel(integrationId: IntegrationId, channelId: string): Promise<boolean> {
    const { count } = await this.db.integrationChannel.deleteMany({ where: { integrationId, channelId } })
    return count > 0
  }

  async upsertConversation(
    integrationId: IntegrationId,
    conversation: ReportedChannel,
    opts?: { defaultTrigger?: ChannelTrigger }
  ): Promise<IntegrationChannelRecord> {
    const row = await this.db.integrationChannel.upsert({
      where: { integrationId_channelId: { integrationId, channelId: conversation.id } },
      create: {
        integrationId,
        channelId: conversation.id,
        name: conversation.name ?? null,
        spaceId: conversation.spaceId ?? null,
        space: conversation.space ?? null,
        isPrivate: conversation.isPrivate ?? false,
        kind: conversation.kind ?? 'channel',
        dmUserId: conversation.dmUserId ?? null,
        // Restricted installs supply Off. Otherwise 1:1 DMs start On and rooms use
        // Mention, matching replaceSnapshot and the controls shown in the Console.
        trigger: opts?.defaultTrigger ?? (conversation.kind === 'im' ? 'any' : 'mention')
      },
      // Refresh only known metadata; trigger/agentId stay operator-owned.
      update: {
        ...(conversation.name ? { name: conversation.name } : {}),
        ...(conversation.spaceId ? { spaceId: conversation.spaceId } : {}),
        ...(conversation.space ? { space: conversation.space } : {}),
        ...(conversation.dmUserId ? { dmUserId: conversation.dmUserId } : {})
      }
    })
    return toChannelRecord(row)
  }

  async listForIntegration(integrationId: IntegrationId): Promise<IntegrationChannelRecord[]> {
    const rows = await this.db.integrationChannel.findMany({
      where: { integrationId },
      orderBy: [{ name: 'asc' }, { channelId: 'asc' }]
    })
    return rows.map(toChannelRecord)
  }

  async listForBot(botId: BotId): Promise<IntegrationChannelRecord[]> {
    // Channels across every active integration of the bot (shared-bot route source).
    const rows = await this.db.integrationChannel.findMany({
      where: { integration: { botId, status: 'active' } },
      orderBy: [{ name: 'asc' }, { channelId: 'asc' }]
    })
    return rows.map(toChannelRecord)
  }

  async setAgent(
    integrationId: IntegrationId,
    channelId: string,
    agentId: AgentId | null
  ): Promise<IntegrationChannelRecord | null> {
    const res = await this.db.integrationChannel.updateMany({
      where: { integrationId, channelId },
      data: { agentId }
    })
    if (res.count === 0) return null
    const row = await this.db.integrationChannel.findUnique({
      where: { integrationId_channelId: { integrationId, channelId } }
    })
    return row ? toChannelRecord(row) : null
  }

  async upsertAgent(
    integrationId: IntegrationId,
    channelId: string,
    agentId: AgentId,
    opts?: { defaultTrigger?: ChannelTrigger; kind?: ConversationKind }
  ): Promise<IntegrationChannelRecord> {
    const row = await this.db.integrationChannel.upsert({
      where: { integrationId_channelId: { integrationId, channelId } },
      create: {
        integrationId,
        channelId,
        agentId,
        ...(opts?.kind ? { kind: opts.kind } : {}),
        ...(opts?.defaultTrigger ? { trigger: opts.defaultTrigger } : {})
      },
      update: { agentId }
    })
    return toChannelRecord(row)
  }

  async setTrigger(
    integrationId: IntegrationId,
    channelId: string,
    trigger: ChannelTrigger,
    opts?: { chosen?: boolean }
  ): Promise<IntegrationChannelRecord | null> {
    // updateMany → no throw on a missing row (the bot may have just left the channel).
    // `triggerChosen` is only ever set, never cleared: a decision does not expire, and
    // orchestration mirroring an owner's trigger must not unmark one either.
    const res = await this.db.integrationChannel.updateMany({
      where: { integrationId, channelId },
      data: { trigger, ...(opts?.chosen ? { triggerChosen: true } : {}) }
    })
    if (res.count === 0) return null
    const row = await this.db.integrationChannel.findUnique({
      where: { integrationId_channelId: { integrationId, channelId } }
    })
    return row ? toChannelRecord(row) : null
  }

  async namesForOrg(
    orgId: OrgId,
    conversations: readonly ConversationCoordinate[]
  ): Promise<IntegrationChannelNameRecord[]> {
    if (conversations.length === 0) return []
    const platforms = [...new Set(conversations.map((c) => c.platform))]
    const channelIds = [...new Set(conversations.map((c) => c.channelId))]
    // The org fence rides on the parent integration (§3.6); the platform narrows the
    // cross-product this coarse `IN` pair admits, and the caller keys on both anyway.
    const rows = await this.db.integrationChannel.findMany({
      where: {
        channelId: { in: channelIds },
        name: { not: null },
        integration: { orgId, platform: { in: platforms } }
      },
      select: { channelId: true, name: true, integration: { select: { platform: true } } },
      orderBy: [{ integrationId: 'asc' }, { channelId: 'asc' }]
    })
    const wanted = new Set(conversations.map((c) => `${c.platform} ${c.channelId}`))
    const named = new Map<string, IntegrationChannelNameRecord>()
    for (const row of rows) {
      const key = `${row.integration.platform} ${row.channelId}`
      // Shared-bot siblings repeat the conversation; the ordered first row wins so the
      // answer is stable across requests rather than whichever row the planner emits.
      if (!wanted.has(key) || named.has(key)) continue
      named.set(key, { platform: row.integration.platform, channelId: row.channelId, name: row.name! })
    }
    return [...named.values()]
  }
}
