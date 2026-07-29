/**
 * PgSlackPlatformInstallStore (preset-agents.md §5.3) — pending installs of the
 * platform-published (distributed) Slack app. No secret material: the app's
 * credentials are deployment env config; a row only binds the OAuth `state` to
 * {org, target agent, user}. No FKs (mirrors slack_install): a dangling row
 * after an org/agent delete is harmless and TTL-reaped.
 */
import type { SlackPlatformInstall } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { SlackPlatformInstallRecord, SlackPlatformInstallStore } from '../ports.js'
import { OrgId, AgentId } from '../../domain/ids.js'

function toRecord(r: SlackPlatformInstall): SlackPlatformInstallRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    agentId: AgentId(r.agentId),
    status: r.status,
    failureReason: r.failureReason,
    botId: r.botId,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt,
    settledAt: r.settledAt
  }
}

export class PgSlackPlatformInstallStore implements SlackPlatformInstallStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(input: {
    id: string
    orgId: OrgId
    agentId: AgentId
    createdByUserId?: string
  }): Promise<SlackPlatformInstallRecord> {
    const row = await this.prisma.slackPlatformInstall.create({
      data: {
        id: input.id,
        orgId: input.orgId,
        agentId: input.agentId,
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {})
      }
    })
    return toRecord(row)
  }

  async get(id: string): Promise<SlackPlatformInstallRecord | null> {
    const row = await this.prisma.slackPlatformInstall.findUnique({ where: { id } })
    return row ? toRecord(row) : null
  }

  async settle(
    id: string,
    outcome: { status: 'completed'; botId?: string } | { status: 'failed'; failureReason: string }
  ): Promise<void> {
    // `status: 'pending'` in the WHERE: a double callback (Slack retry / a
    // double-clicked tab) keeps the FIRST outcome rather than overwriting a
    // completed install with a late failure. updateMany so a reaped row is a
    // no-op, not a throw.
    await this.prisma.slackPlatformInstall.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: outcome.status,
        settledAt: new Date(),
        ...(outcome.status === 'completed'
          ? { ...(outcome.botId ? { botId: outcome.botId } : {}) }
          : { failureReason: outcome.failureReason })
      }
    })
  }

  async delete(id: string): Promise<void> {
    // deleteMany so a double-callback / already-reaped row is a no-op, not a throw.
    await this.prisma.slackPlatformInstall.deleteMany({ where: { id } })
  }

  async reapExpired(staleBefore: Date): Promise<number> {
    const res = await this.prisma.slackPlatformInstall.deleteMany({ where: { createdAt: { lt: staleBefore } } })
    return res.count
  }
}
