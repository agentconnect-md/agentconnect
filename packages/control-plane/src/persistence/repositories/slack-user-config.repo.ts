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
import { orgScope } from '../../secrets/scope.js'
import { OrgId } from '../../domain/ids.js'

export class PgSlackUserConfigStore implements SlackUserConfigStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  // The scope comes from the CALLER's orgId, never from `r.orgId`: the fence
  // has to be something the caller asserted, not something the row claims.
  private async toRecord(orgId: OrgId, r: SlackUserConfig): Promise<SlackUserConfigRecord> {
    const scope = orgScope(orgId)
    return {
      orgId: OrgId(r.orgId),
      userId: r.userId,
      accessToken: await this.cipher.open(r.accessToken, scope),
      // Access-only rows have no refresh token (the column is nullable).
      refreshToken: r.refreshToken ? await this.cipher.open(r.refreshToken, scope) : null,
      accessExpiresAt: r.accessExpiresAt,
      updatedAt: r.updatedAt
    }
  }

  async get(orgId: OrgId, userId: string): Promise<SlackUserConfigRecord | null> {
    const row = await this.prisma.slackUserConfig.findUnique({ where: { orgId_userId: { orgId, userId } } })
    return row ? this.toRecord(orgId, row) : null
  }

  async put(orgId: OrgId, userId: string, m: SlackUserConfigMaterial): Promise<void> {
    const scope = orgScope(orgId)
    const tokens = {
      accessToken: await this.cipher.seal(m.accessToken, scope),
      refreshToken: m.refreshToken ? await this.cipher.seal(m.refreshToken, scope) : null,
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
}
