/**
 * `PgBotCredentialWriter` — the two lifecycle transitions of a shared bot's
 * credential, each as ONE atomic, serialized step (preset-agents.md §5.3).
 *
 * Both transitions span two tables (`bot_secret` + `bot`, or `bot` +
 * `integration`), and both are fenced by `bot.credentialRevision`. Split across
 * separate commits they interleave in ways the fence cannot catch:
 *
 *  - install: the fresh token committing before the generation bump leaves a
 *    window where the bot carries the NEW secret under the OLD revision. A
 *    crash there is not self-healing — `listHttpActive` does not filter on
 *    `revokedAt`, so restart reconciliation broadcasts that fresh token with
 *    the stale fence, and a delayed uninstall then passes the CAS and kills it.
 *  - revoke: the bot CAS committing before the integration flip lets a
 *    concurrent re-install bump to N+1 and re-activate an install in between —
 *    the flip then revokes the FRESH install, leaving a live, re-authorized bot
 *    with nothing installed.
 *
 * Both write the `bot` row, so running each inside one transaction also makes
 * them serialize against each other on that row lock — a revoke and a
 * re-install can no longer interleave at all.
 *
 * A transaction OWNER (takes the full `PrismaClient`), mirroring
 * `PgAgentConfigWriter`: cipher I/O happens OUTSIDE the transaction, and
 * tx-scoped repos are constructed inside it.
 */
import type { PrismaClient } from '../../generated/prisma/client.js'
import { withTx } from '../prisma.js'
import type { BotCredentialWriter, BotSecretMaterial, RevokeBotResult } from '../ports.js'
import type { BotId, IntegrationId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { PgBotRepo, PgIntegrationRepo } from './integration.repo.js'

export class PgBotCredentialWriter implements BotCredentialWriter {
  constructor(
    // The full client (not PrismaLike): this OWNS its transaction, it does not
    // compose under someone else's.
    private readonly prisma: PrismaClient,
    private readonly cipher: SecretCipher
  ) {}

  async install(botId: BotId, material: BotSecretMaterial, at: Date): Promise<number> {
    // Seal first: cipher calls may be remote (Vault Transit), and holding a
    // transaction open across them would pin a connection for that round trip.
    const sealed = {
      botToken: await this.cipher.seal(material.botToken),
      appToken: material.appToken === null ? null : await this.cipher.seal(material.appToken),
      signingSecret: material.signingSecret === null ? null : await this.cipher.seal(material.signingSecret)
    }
    return withTx(this.prisma, async (tx) => {
      await tx.botSecret.upsert({ where: { botId }, create: { botId, ...sealed }, update: sealed })
      // Same transaction: no reader can ever observe the new secret under the
      // old generation, so the fence always describes the credential in place.
      return new PgBotRepo(tx).bumpCredential(botId, at)
    })
  }

  async revoke(botId: BotId, at: Date, fence: { revision?: number; eventAt?: Date }): Promise<RevokeBotResult> {
    return withTx(this.prisma, async (tx) => {
      const bots = new PgBotRepo(tx)
      // The CAS is an UPDATE on the bot row — it takes the row lock for the rest
      // of this transaction, so a concurrent `install` blocks here rather than
      // slipping a fresh generation between the decision and the flip below.
      const applied = await bots.revokeIfCurrent(botId, at, fence)
      if (!applied) return { applied: false, integrationIds: [] }
      const integrationIds = await new PgIntegrationRepo(tx).markRevokedForBot(botId)
      return { applied: true, integrationIds }
    })
  }
}

export type { IntegrationId }
