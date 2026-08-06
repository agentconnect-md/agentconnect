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
import { orgScope } from '../../secrets/scope.js'
import { OrgId, AgentId } from '../../domain/ids.js'

export class PgSlackInstallStore implements SlackInstallStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  // `orgId` is the caller's assertion on the scoped paths and the row's own on
  // the callback path (see `getUnscoped`) — never silently one or the other.
  private async toRecord(orgId: OrgId, r: SlackInstall): Promise<SlackInstallRecord> {
    const scope = orgScope(orgId)
    return {
      id: r.id,
      orgId: OrgId(r.orgId),
      agentId: AgentId(r.agentId),
      appId: r.appId,
      clientId: r.clientId,
      clientSecret: await this.cipher.open(r.clientSecret, scope),
      botToken: r.botToken === null ? null : await this.cipher.open(r.botToken, scope),
      name: r.name,
      transport: r.transport,
      signingSecret: r.signingSecret === null ? null : await this.cipher.open(r.signingSecret, scope),
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt
    }
  }

  async create(input: CreateSlackInstallInput): Promise<SlackInstallRecord> {
    const scope = orgScope(input.orgId)
    const row = await this.prisma.slackInstall.create({
      data: {
        id: input.id,
        orgId: input.orgId,
        agentId: input.agentId,
        appId: input.appId,
        clientId: input.clientId,
        clientSecret: await this.cipher.seal(input.clientSecret, scope),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
        ...(input.signingSecret != null ? { signingSecret: await this.cipher.seal(input.signingSecret, scope) } : {}),
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {})
      }
    })
    return this.toRecord(input.orgId, row)
  }

  async get(orgId: OrgId, id: string): Promise<SlackInstallRecord | null> {
    const row = await this.prisma.slackInstall.findUnique({ where: { id, orgId } })
    return row ? this.toRecord(orgId, row) : null
  }

  async getUnscoped(id: string): Promise<SlackInstallRecord | null> {
    // The OAuth callback resolves a pending install by its unforgeable `state`
    // before any org context exists; the state token IS the authority there
    // (org-scoped-data-layer.md §4). The org then comes from the row itself.
    const row = await this.prisma.slackInstall.findUnique({ where: { id } })
    return row ? this.toRecord(OrgId(row.orgId), row) : null
  }

  async setBotToken(orgId: OrgId, id: string, botToken: string): Promise<boolean> {
    // updateMany (not update) so an unknown/expired id is a count of 0, not a throw.
    const res = await this.prisma.slackInstall.updateMany({
      where: { id, orgId },
      data: { botToken: await this.cipher.seal(botToken, orgScope(orgId)) }
    })
    return res.count === 1
  }

  async delete(orgId: OrgId, id: string): Promise<void> {
    // deleteMany so a double-finalize / already-reaped row is a no-op, not a throw.
    await this.prisma.slackInstall.deleteMany({ where: { id, orgId } })
  }

  async reapExpired(staleBefore: Date): Promise<number> {
    const res = await this.prisma.slackInstall.deleteMany({ where: { createdAt: { lt: staleBefore } } })
    return res.count
  }
}
