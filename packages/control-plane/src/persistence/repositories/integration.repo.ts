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
import { BotExternalIdentityTaken, BotStillShared } from '../errors.js'
import type {
  BotRepo,
  BotRecord,
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
  ReportedChannel,
  ChannelTrigger,
  ConversationKind,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import { toDbPlatform } from '../platform.js'
import type { SecretCipher } from '../../secrets/cipher.js'
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

function toBotRecord(b: BotJoined): BotRecord {
  const active = b.integrations.filter((i) => i.status === 'active')
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
    platformConfig: (b.platformConfig as Record<string, unknown> | null) ?? null,
    workspaceId: b.workspaceId,
    workspaceName: b.workspaceName,
    botUserId: b.botUserId,
    revokedAt: b.revokedAt,
    credentialRevision: b.credentialRevision,
    credentialInstalledAt: b.credentialInstalledAt,
    discordAppId: b.discordAppId,
    feishuAppId: b.feishuAppId,
    feishuRegion: (b.feishuRegion as FeishuRegion | null) ?? null,
    shareable: b.shareable,
    transport: b.transport as BotRecord['transport'],
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

/** Tenant sentinel for NEW rows of tenantless platforms (D6/§11): a real value —
 *  unlike NULL — participates in the composite unique, so it is what makes
 *  `(platform, externalAppId)` enforceable. NULL stays reserved for legacy rows. */
export const TENANTLESS_SENTINEL = '-'

/** Derive the D6 generic identity dual-write from the legacy per-platform input
 *  fields. Reads stay on the legacy columns during the dual-write window; this
 *  only keeps the generic columns in lockstep for every NEW row. */
function botExternalIdentity(input: CreateBotInput): {
  externalAppId?: string
  externalTenantId?: string
  platformConfig?: Record<string, string>
} {
  switch (input.platform) {
    case 'slack':
      // Tenant-scoped: the pair mirrors (slackAppId, teamId) verbatim. A manual
      // single-workspace install without a captured identity keeps NULLs — the
      // same pre-capture semantics the legacy fence has today.
      return {
        ...(input.slackAppId ? { externalAppId: input.slackAppId } : {}),
        ...(input.teamId ? { externalTenantId: input.teamId } : {})
      }
    case 'feishu': {
      const bag = {
        ...(input.feishuAppId ? { feishuAppId: input.feishuAppId } : {}),
        ...(input.feishuRegion ? { feishuRegion: input.feishuRegion } : {})
      }
      return {
        // App-scoped identity (no tenant axis): the cli_ app id + the sentinel,
        // which turns the composite unique into a one-bot-per-Feishu-app fence.
        ...(input.feishuAppId ? { externalAppId: input.feishuAppId, externalTenantId: TENANTLESS_SENTINEL } : {}),
        ...(Object.keys(bag).length ? { platformConfig: bag } : {})
      }
    }
    case 'discord':
      // Display-only app id; Discord has no ingress demux identity today.
      return input.discordAppId ? { platformConfig: { discordAppId: input.discordAppId } } : {}
    default:
      return {}
  }
}

export class PgBotRepo implements BotRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: CreateBotInput): Promise<BotRecord> {
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
          ...botExternalIdentity(input),
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
          ...(input.botUserId ? { botUserId: input.botUserId } : {}),
          ...(input.discordAppId ? { discordAppId: input.discordAppId } : {}),
          ...(input.feishuAppId ? { feishuAppId: input.feishuAppId } : {}),
          ...(input.feishuRegion ? { feishuRegion: input.feishuRegion } : {}),
          ...(input.shareable !== undefined ? { shareable: input.shareable } : {}),
          ...(input.transport !== undefined ? { transport: input.transport } : {}),
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
      // The D6 composite unique fired: a bot with this external app identity
      // already exists on this platform. Typed so routes can 409 instead of 500.
      // The legacy (slackAppId, teamId) unique keeps its existing callers'
      // handling; only the new index maps here.
      if (
        (err as { code?: string }).code === 'P2002' &&
        String((err as { meta?: { target?: unknown } }).meta?.target ?? '').includes('externalAppId')
      ) {
        throw new BotExternalIdentityTaken(input.platform)
      }
      throw err
    }
  }

  async get(id: BotId): Promise<BotRecord | null> {
    const b = await this.db.bot.findUnique({ where: { id }, include: botInclude })
    return b ? toBotRecord(b) : null
  }

  async listForOrg(orgId: OrgId): Promise<BotRecord[]> {
    const rows = await this.db.bot.findMany({ where: { orgId }, include: botInclude, orderBy: { createdAt: 'asc' } })
    return rows.map(toBotRecord)
  }

  async setWorkspaceMetadata(id: BotId, workspaceId: string, workspaceName: string | null): Promise<void> {
    await this.db.bot.update({
      where: { id },
      data: {
        workspaceId,
        ...(workspaceName ? { workspaceName } : {})
      }
    })
  }

  async listSlackMissingIdentity(): Promise<BotRecord[]> {
    const rows = await this.db.bot.findMany({
      where: {
        platform: 'slack',
        OR: [{ transport: 'http', slackAppId: null }, { workspaceId: null }, { workspaceName: null }]
      },
      include: botInclude,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toBotRecord)
  }

  async setSlackAppIdIfMissing(id: BotId, slackAppId: string): Promise<boolean> {
    // Dual-write (D6): the generic column tracks the legacy one. The tenant half
    // stays NULL here — the reconciler backfills legacy socket bots, whose
    // pre-capture NULLs-distinct semantics must be preserved.
    const result = await this.db.bot.updateMany({
      where: { id, slackAppId: null },
      data: { slackAppId, externalAppId: slackAppId }
    })
    return result.count === 1
  }

  async markFreed(id: BotId, at: Date, lastAgentName: string | null): Promise<void> {
    await this.db.bot.update({ where: { id }, data: { lastUsedAt: at, lastAgentName } })
  }

  async setShareable(id: BotId, shareable: boolean): Promise<void> {
    // Serialized on the bot row: membership admission (addBotMembership) takes
    // the same lock, so a disable can never commit alongside a concurrent
    // second-agent admission — whichever wins, the loser observes the winner's
    // committed state. The capacity recount lives HERE (not only in the route's
    // optimistic pre-check) because only under the lock is it authoritative.
    await withAmbientTx(this.db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM bot WHERE id = ${id} FOR UPDATE`
      if (!shareable) {
        const active = await tx.integration.count({ where: { botId: id, status: 'active' } })
        if (active > 1) throw new BotStillShared(active)
      }
      await tx.bot.update({ where: { id }, data: { shareable } })
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

  async getBySlackAppTeam(slackAppId: string, teamId: string): Promise<BotRecord | null> {
    // Cross-org on purpose: (slackAppId, teamId) is globally unique — a workspace
    // install of a distributed app binds to exactly one org, and the platform
    // callback must find it wherever it lives to refuse a second org's claim.
    const b = await this.db.bot.findUnique({
      where: { slackAppId_teamId: { slackAppId, teamId } },
      include: botInclude
    })
    return b ? toBotRecord(b) : null
  }

  async getByExternalIdentity(
    platform: string,
    externalAppId: string,
    externalTenantId: string
  ): Promise<BotRecord | null> {
    // Cross-org on purpose, mirroring getBySlackAppTeam: an external app identity
    // binds to exactly one org, and a second org's claim must find it to refuse.
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

  async delete(id: BotId): Promise<void> {
    await this.db.bot.delete({ where: { id } }) // FK cascade drops bot_secret; Restrict blocks while installed
  }
}

export class PgBotSecretStore implements BotSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(botId: BotId, material: BotSecretMaterial): Promise<void> {
    const sealed = {
      botToken: await this.cipher.seal(material.botToken),
      appToken: material.appToken === null ? null : await this.cipher.seal(material.appToken),
      signingSecret: material.signingSecret === null ? null : await this.cipher.seal(material.signingSecret),
      verificationToken: material.verificationToken == null ? null : await this.cipher.seal(material.verificationToken),
      encryptKey: material.encryptKey == null ? null : await this.cipher.seal(material.encryptKey)
    }
    await this.db.botSecret.upsert({
      where: { botId },
      create: { botId, ...sealed },
      update: sealed
    })
  }

  async get(botId: BotId): Promise<BotSecretMaterial | null> {
    const s = await this.db.botSecret.findUnique({ where: { botId } })
    if (!s) return null
    return {
      botToken: await this.cipher.open(s.botToken),
      appToken: s.appToken === null ? null : await this.cipher.open(s.appToken),
      signingSecret: s.signingSecret === null ? null : await this.cipher.open(s.signingSecret),
      verificationToken: s.verificationToken === null ? null : await this.cipher.open(s.verificationToken),
      encryptKey: s.encryptKey === null ? null : await this.cipher.open(s.encryptKey)
    }
  }

  async delete(botId: BotId): Promise<void> {
    // deleteMany → idempotent (the FK cascade may already have removed it).
    await this.db.botSecret.deleteMany({ where: { botId } })
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
    // the insert — a concurrent sharing toggle (setShareable takes the same
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

  async get(id: IntegrationId): Promise<IntegrationRecord | null> {
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
        bot: { select: { slackAppId: true } },
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

  async delete(id: IntegrationId): Promise<void> {
    await this.db.integration.delete({ where: { id } })
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
    agentId: c.agentId ? AgentId(c.agentId) : null
  }
}

export class PgIntegrationChannelRepo implements IntegrationChannelRepo {
  constructor(private readonly db: PrismaLike) {}

  // Converge to a daemon channel report: refresh supplied metadata on known
  // conversations (PRESERVING the operator's trigger), insert new ones (trigger =
  // `defaultTrigger`, 'mention' unless the integration is gated), and, for an
  // authoritative membership snapshot, drop channel rows that are no longer present.
  // DM rows and rows omitted from a non-authoritative observed-conversation report
  // are retained.
  //
  // A DM row is the one exception to `defaultTrigger`, and it is a SECURITY boundary
  // (resource-visibility.md §14.3). Discovery reports DMs whether or not the owning
  // agent is gated today, and visibility can flip to restricted later — at which point
  // `gatedBindRules` enables every non-Off IM row. Storing a discovered DM with the
  // ordinary 'mention' default would therefore let a newly-private agent keep answering
  // a DM that no operator ever enabled. Created DM rows, and channel rows converting to
  // DM, are pinned Off; an operator's later choice is untouched.
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
    opts?: { defaultTrigger?: ChannelTrigger; authoritative?: boolean; removed?: string[] }
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
      // Direct conversations (a DM, or a Slack group DM) are only ever reported by
      // observation, never enumerated — so they are pinned Off on creation and on
      // conversion for the same fail-closed reason, and an authoritative channel
      // snapshot (which cannot contain them) must not delete them.
      const direct = c.kind === 'im' || c.kind === 'mpim'
      const createTrigger = direct ? 'off' : (opts?.defaultTrigger ?? 'mention')
      await this.db.$executeRaw`
        INSERT INTO "integration_channel"
          ("integrationId", "channelId", "name", "spaceId", "space", "isPrivate", "kind", "trigger",
           "firstSeenAt", "updatedAt")
        VALUES (
          ${integrationId}::uuid, ${c.id}, ${c.name ?? null}, ${c.spaceId ?? null}, ${c.space ?? null},
          ${c.isPrivate ?? false}, ${c.kind ?? 'channel'}::"ConversationKind",
          ${createTrigger}::"ChannelTrigger", NOW(), NOW()
        )
        ON CONFLICT ("integrationId", "channelId") DO UPDATE SET
          "name" = CASE WHEN ${setName}::boolean THEN EXCLUDED."name" ELSE "integration_channel"."name" END,
          "spaceId" = CASE WHEN ${c.spaceId !== undefined}::boolean THEN EXCLUDED."spaceId"
                           ELSE "integration_channel"."spaceId" END,
          "space" = CASE WHEN ${c.space !== undefined}::boolean THEN EXCLUDED."space"
                         ELSE "integration_channel"."space" END,
          "isPrivate" = CASE WHEN ${setPrivate}::boolean THEN EXCLUDED."isPrivate"
                             ELSE "integration_channel"."isPrivate" END,
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
          -- The fail-closed conversion, resolved against the COMMITTED kind: a row that
          -- was a channel carried a channel's trigger, which is not an operator's choice
          -- for a direct conversation. A row already of the reported kind keeps whatever
          -- the operator set. (Slack classifies a group DM late — an app_mention payload
          -- carries no channel_type — so channel to mpim is a real transition, not a race.)
          "trigger" = CASE
            WHEN ${direct}::boolean AND "integration_channel"."kind" <> EXCLUDED."kind"
              THEN 'off'::"ChannelTrigger"
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
    opts?: { agentId?: AgentId | null; defaultTrigger?: ChannelTrigger }
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
        // Same fail-closed rule as replaceSnapshot: a created direct-conversation row
        // (DM or group DM) starts Off however it was discovered, so a later flip to
        // restricted cannot grandfather it in.
        ...(conversation.kind === 'im' || conversation.kind === 'mpim'
          ? { trigger: 'off' as const }
          : opts?.defaultTrigger
            ? { trigger: opts.defaultTrigger }
            : {}),
        ...(opts?.agentId !== undefined ? { agentId: opts.agentId } : {})
      },
      // Refresh only a KNOWN name — a nameless re-report must not clobber a
      // previously resolved counterpart name; trigger/agentId stay operator-owned.
      update: {
        ...(conversation.name ? { name: conversation.name } : {}),
        ...(conversation.spaceId ? { spaceId: conversation.spaceId } : {}),
        ...(conversation.space ? { space: conversation.space } : {})
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
    opts?: { defaultTrigger?: ChannelTrigger }
  ): Promise<IntegrationChannelRecord> {
    const row = await this.db.integrationChannel.upsert({
      where: { integrationId_channelId: { integrationId, channelId } },
      create: {
        integrationId,
        channelId,
        agentId,
        ...(opts?.defaultTrigger ? { trigger: opts.defaultTrigger } : {})
      },
      update: { agentId }
    })
    return toChannelRecord(row)
  }

  async setTrigger(
    integrationId: IntegrationId,
    channelId: string,
    trigger: ChannelTrigger
  ): Promise<IntegrationChannelRecord | null> {
    // updateMany → no throw on a missing row (the bot may have just left the channel).
    const res = await this.db.integrationChannel.updateMany({
      where: { integrationId, channelId },
      data: { trigger }
    })
    if (res.count === 0) return null
    const row = await this.db.integrationChannel.findUnique({
      where: { integrationId_channelId: { integrationId, channelId } }
    })
    return row ? toChannelRecord(row) : null
  }
}
