/**
 * PgSlackUserConfigStore (docs/designs/slack-install-smoothing.md §Tier B).
 *
 * One user's stored Slack App Configuration Token (access + refresh + expiry),
 * scoped to an org. PER-USER (composite key orgId+userId) so the app the funnel
 * creates belongs to whoever's token created it. The tokens pass through the
 * SecretCipher behind this seam (same discipline as `bot_secret`) — never
 * returned in a DTO, never logged. `put` upserts (one row per user per org),
 * used both when the caller saves it in the console and when a stale access
 * token is rotated.
 */
import type { SlackUserConfig } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { SlackUserConfigMaterial, SlackUserConfigRecord, SlackUserConfigStore } from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { OrgId } from '../../domain/ids.js'

export class PgSlackUserConfigStore implements SlackUserConfigStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  private async toRecord(r: SlackUserConfig): Promise<SlackUserConfigRecord> {
    return {
      orgId: OrgId(r.orgId),
      userId: r.userId,
      accessToken: await this.cipher.open(r.accessToken),
      // Access-only rows have no refresh token (the column is nullable).
      refreshToken: r.refreshToken ? await this.cipher.open(r.refreshToken) : null,
      accessExpiresAt: r.accessExpiresAt,
      updatedAt: r.updatedAt
    }
  }

  async get(orgId: OrgId, userId: string): Promise<SlackUserConfigRecord | null> {
    const row = await this.prisma.slackUserConfig.findUnique({ where: { orgId_userId: { orgId, userId } } })
    return row ? this.toRecord(row) : null
  }

  async put(orgId: OrgId, userId: string, m: SlackUserConfigMaterial): Promise<void> {
    const tokens = {
      accessToken: await this.cipher.seal(m.accessToken),
      refreshToken: m.refreshToken ? await this.cipher.seal(m.refreshToken) : null,
      accessExpiresAt: m.accessExpiresAt
    }
    await this.prisma.slackUserConfig.upsert({
      where: { orgId_userId: { orgId, userId } },
      create: { orgId, userId, ...tokens },
      update: tokens
    })
  }

  async delete(orgId: OrgId, userId: string): Promise<void> {
    await this.prisma.slackUserConfig.deleteMany({ where: { orgId, userId } })
  }

  async deleteIfUnchanged(orgId: OrgId, userId: string, updatedAt: Date): Promise<number> {
    // `updatedAt` is the optimistic-concurrency version: a concurrent upsert bumps it
    // (@updatedAt), so scoping the delete to the attempted value drops the row iff nothing
    // replaced it in the meantime. One atomic statement — no read-then-delete race.
    const res = await this.prisma.slackUserConfig.deleteMany({ where: { orgId, userId, updatedAt } })
    return res.count
  }
}
