/**
 * `rewrapAllSecrets` — the convergence sweep for at-rest secret encryption
 * (docs/designs/secret-store-seams.md §6): re-seal every stored tenant-secret
 * VALUE through the configured {@link SecretCipher} (`open` → `seal`).
 *
 * Two jobs, one sweep:
 * - **Converge the lazy migration.** Flipping `SECRET_CIPHER=vault-transit`
 *   seals rows only as they are next written; this sweep re-writes every
 *   existing value so plaintext residue disappears NOW, not eventually.
 * - **Rewrap after key rotation.** Post-`transit/keys/<key>/rotate`, old
 *   ciphertexts still open (Vault keeps prior versions) — re-sealing upgrades
 *   them all to the newest key version.
 *
 * SAFE AGAINST A LIVE CP: every write is a compare-and-set on the row's OLD
 * stored values (`updateMany` constrained by the snapshot bytes, not just the
 * key). A row the CP changed (or deleted) between snapshot and write loses the
 * CAS and is SKIPPED — which is correct, not a gap: every normal writer goes
 * through the cipher'd store seams, so a concurrent write is already sealed
 * with the current key. No maintenance window, no locks.
 *
 * Discipline: values NEVER leave this module except into the cipher; nothing is
 * logged but table names and counts. Idempotent — a re-run re-seals to the same
 * plaintexts (fresh ciphertexts, identical values), and a mid-way failure is
 * harmless: finished rows stay sealed, a re-run picks up the rest.
 *
 * The sweep reads the raw columns (not the typed stores): it must reach every
 * secret-bearing table including ones whose ports have no update-in-place shape
 * (`mcp_grant.key`), and per-column `open→seal` is exactly the stores' seam
 * semantics. Fleet-bounded tables (hundreds of rows) — a full read per table is
 * deliberate; no pagination machinery.
 */
import type { Prisma, PrismaClient } from '../generated/prisma/client.js'
import type { SecretCipher } from './cipher.js'

export interface RewrapStats {
  table: string
  /** Rows re-written. */
  rows: number
  /** Individual secret values re-sealed (a row may hold several). */
  values: number
  /** Rows whose CAS lost to a concurrent CP write (already sealed by it) — safe to leave. */
  skipped: number
}

export async function rewrapAllSecrets(
  prisma: PrismaClient,
  cipher: SecretCipher,
  log: (message: string) => void = () => {}
): Promise<RewrapStats[]> {
  // open() then seal(): plaintext residue gets sealed, old-key ciphertext gets
  // re-encrypted at the current key version — both arms of the sweep's job.
  const reseal = async (stored: string): Promise<string> => cipher.seal(await cipher.open(stored))
  const resealNullable = async (stored: string | null): Promise<string | null> =>
    stored === null ? null : reseal(stored)

  const stats: RewrapStats[] = []
  const done = (table: string, rows: number, values: number, skipped: number): void => {
    stats.push({ table, rows, values, skipped })
    log(
      `${table}: resealed ${values} value(s) across ${rows} row(s)` +
        (skipped > 0 ? `; skipped ${skipped} concurrently-updated row(s)` : '')
    )
  }

  {
    let rows = 0
    let values = 0
    let skipped = 0
    for (const r of await prisma.botSecret.findMany()) {
      const sealed = {
        botToken: await reseal(r.botToken),
        appToken: await resealNullable(r.appToken),
        signingSecret: await resealNullable(r.signingSecret),
        verificationToken: await resealNullable(r.verificationToken),
        encryptKey: await resealNullable(r.encryptKey)
      }
      // CAS on the snapshot bytes: a concurrent store.put() (already sealed) wins.
      const res = await prisma.botSecret.updateMany({
        where: {
          botId: r.botId,
          botToken: r.botToken,
          appToken: r.appToken,
          signingSecret: r.signingSecret,
          verificationToken: r.verificationToken,
          encryptKey: r.encryptKey
        },
        data: sealed
      })
      if (res.count === 0) skipped += 1
      else {
        rows += 1
        values +=
          1 +
          (r.appToken === null ? 0 : 1) +
          (r.signingSecret === null ? 0 : 1) +
          (r.verificationToken === null ? 0 : 1) +
          (r.encryptKey === null ? 0 : 1)
      }
    }
    done('bot_secret', rows, values, skipped)
  }

  {
    let rows = 0
    let skipped = 0
    for (const r of await prisma.agentSecret.findMany()) {
      const res = await prisma.agentSecret.updateMany({
        where: { agentId: r.agentId, key: r.key, value: r.value },
        data: { value: await reseal(r.value) }
      })
      if (res.count === 0) skipped += 1
      else rows += 1
    }
    done('agent_secret', rows, rows, skipped)
  }

  {
    let rows = 0
    let skipped = 0
    for (const r of await prisma.hookSecret.findMany()) {
      const res = await prisma.hookSecret.updateMany({
        where: { hookId: r.hookId, hmacSecret: r.hmacSecret },
        data: { hmacSecret: await reseal(r.hmacSecret) }
      })
      if (res.count === 0) skipped += 1
      else rows += 1
    }
    done('hook_secret', rows, rows, skipped)
  }

  {
    // JSONB headers: [{name, value}] — names are config and stay readable;
    // each VALUE re-seals (same shape PgMcpProviderSecretStore writes). The CAS
    // compares the whole JSONB document against the snapshot.
    let rows = 0
    let values = 0
    let skipped = 0
    for (const r of await prisma.mcpProviderSecret.findMany()) {
      const headers = r.headers as unknown as Array<{ name: string; value: string }>
      const resealed = await Promise.all(headers.map(async (h) => ({ name: h.name, value: await reseal(h.value) })))
      const res = await prisma.mcpProviderSecret.updateMany({
        where: { mcpProviderId: r.mcpProviderId, headers: { equals: r.headers as Prisma.InputJsonValue } },
        data: { headers: resealed }
      })
      if (res.count === 0) skipped += 1
      else {
        rows += 1
        values += resealed.length
      }
    }
    done('mcp_provider_secret', rows, values, skipped)
  }

  {
    let rows = 0
    let skipped = 0
    for (const r of await prisma.mcpGrant.findMany()) {
      const res = await prisma.mcpGrant.updateMany({
        where: { id: r.id, key: r.key },
        data: { key: await reseal(r.key) }
      })
      if (res.count === 0) skipped += 1
      else rows += 1
    }
    done('mcp_grant', rows, rows, skipped)
  }

  {
    let rows = 0
    let values = 0
    let skipped = 0
    for (const r of await prisma.slackInstall.findMany()) {
      const sealed = {
        clientSecret: await reseal(r.clientSecret),
        botToken: await resealNullable(r.botToken),
        signingSecret: await resealNullable(r.signingSecret)
      }
      const res = await prisma.slackInstall.updateMany({
        where: { id: r.id, clientSecret: r.clientSecret, botToken: r.botToken, signingSecret: r.signingSecret },
        data: sealed
      })
      if (res.count === 0) skipped += 1
      else {
        rows += 1
        values += 1 + (r.botToken === null ? 0 : 1) + (r.signingSecret === null ? 0 : 1)
      }
    }
    done('slack_install', rows, values, skipped)
  }

  {
    // JSONB values map: {NAME: value} — logical-secret NAMES are config and stay
    // readable; each VALUE re-seals (same shape PgExternalMemoryConnectionSecretStore
    // writes). The CAS compares the whole JSONB document against the snapshot.
    let rows = 0
    let values = 0
    let skipped = 0
    for (const r of await prisma.externalMemoryConnectionSecret.findMany()) {
      const stored = r.values as unknown as Record<string, string>
      const resealed = Object.fromEntries(
        await Promise.all(Object.entries(stored).map(async ([name, value]) => [name, await reseal(value)] as const))
      )
      const res = await prisma.externalMemoryConnectionSecret.updateMany({
        where: { connectionId: r.connectionId, values: { equals: r.values as Prisma.InputJsonValue } },
        data: { values: resealed }
      })
      if (res.count === 0) skipped += 1
      else {
        rows += 1
        values += Object.keys(resealed).length
      }
    }
    done('external_memory_connection_secret', rows, values, skipped)
  }

  {
    let rows = 0
    let skipped = 0
    for (const r of await prisma.externalMemoryGrant.findMany()) {
      const res = await prisma.externalMemoryGrant.updateMany({
        where: { id: r.id, key: r.key },
        data: { key: await reseal(r.key) }
      })
      if (res.count === 0) skipped += 1
      else rows += 1
    }
    done('external_memory_grant', rows, rows, skipped)
  }

  {
    let rows = 0
    let values = 0
    let skipped = 0
    for (const r of await prisma.slackUserConfig.findMany()) {
      const res = await prisma.slackUserConfig.updateMany({
        where: { orgId: r.orgId, userId: r.userId, accessToken: r.accessToken, refreshToken: r.refreshToken },
        data: {
          accessToken: await reseal(r.accessToken),
          // Access-only rows have no refresh token to reseal (the column is nullable).
          refreshToken: r.refreshToken ? await reseal(r.refreshToken) : null
        }
      })
      if (res.count === 0) skipped += 1
      else {
        rows += 1
        values += r.refreshToken ? 2 : 1
      }
    }
    done('slack_user_config', rows, values, skipped)
  }

  return stats
}
