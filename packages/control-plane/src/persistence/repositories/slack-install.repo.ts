/**
 * PgSlackInstallStore (docs/designs/slack-install-smoothing.md §Tier B).
 *
 * Short-lived pending rows for the config-token auto-install funnel: the
 * manifest-created app's client credentials + the OAuth-obtained bot token live
 * here until `finalize` mints the real bot + integration and DELETES the row.
 * `clientSecret`/`botToken`/`signingSecret` pass through the SecretCipher behind
 * this seam (same discipline as `bot_secret`) — never returned in a DTO, never
 * logged. No FKs (like `github_install_state`): a dangling row after an
 * org/agent delete is harmless and the reaper sweeps it by age.
 */
import type { SlackInstall } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { CreateSlackInstallInput, SlackInstallRecord, SlackInstallStore } from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { OrgId, AgentId } from '../../domain/ids.js'

export class PgSlackInstallStore implements SlackInstallStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  private async toRecord(r: SlackInstall): Promise<SlackInstallRecord> {
    return {
      id: r.id,
      orgId: OrgId(r.orgId),
      agentId: AgentId(r.agentId),
      appId: r.appId,
      clientId: r.clientId,
      clientSecret: await this.cipher.open(r.clientSecret),
      botToken: r.botToken === null ? null : await this.cipher.open(r.botToken),
      name: r.name,
      transport: r.transport,
      signingSecret: r.signingSecret === null ? null : await this.cipher.open(r.signingSecret),
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt
    }
  }

  async create(input: CreateSlackInstallInput): Promise<SlackInstallRecord> {
    const row = await this.prisma.slackInstall.create({
      data: {
        id: input.id,
        orgId: input.orgId,
        agentId: input.agentId,
        appId: input.appId,
        clientId: input.clientId,
        clientSecret: await this.cipher.seal(input.clientSecret),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
        ...(input.signingSecret != null ? { signingSecret: await this.cipher.seal(input.signingSecret) } : {}),
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {})
      }
    })
    return this.toRecord(row)
  }

  async get(id: string): Promise<SlackInstallRecord | null> {
    const row = await this.prisma.slackInstall.findUnique({ where: { id } })
    return row ? this.toRecord(row) : null
  }

  async setBotToken(id: string, botToken: string): Promise<boolean> {
    // updateMany (not update) so an unknown/expired id is a count of 0, not a throw.
    const res = await this.prisma.slackInstall.updateMany({
      where: { id },
      data: { botToken: await this.cipher.seal(botToken) }
    })
    return res.count === 1
  }

  async delete(id: string): Promise<void> {
    // deleteMany so a double-finalize / already-reaped row is a no-op, not a throw.
    await this.prisma.slackInstall.deleteMany({ where: { id } })
  }

  async reapExpired(staleBefore: Date): Promise<number> {
    const res = await this.prisma.slackInstall.deleteMany({ where: { createdAt: { lt: staleBefore } } })
    return res.count
  }
}
