/**
 * Rewrap CLI — one-shot admin sweep re-sealing every stored tenant secret through
 * the configured SecretCipher (docs/designs/secret-store-seams.md §6). Run it after
 * flipping `SECRET_CIPHER=vault-transit` to converge the lazy migration, and after a
 * `transit/keys/<key>/rotate` to rewrap onto the newest key version. Idempotent;
 * safe to re-run after a mid-way failure.
 *
 * This lives in `src/` (not `scripts/`) so it COMPILES INTO `dist/` and ships in the
 * control-plane runtime image — the image is dist-only (no `tsx`/`src/`/`scripts/`),
 * so this is the entry an operator can actually run there:
 *
 *   node dist/secrets/rewrap-cli.js        # in the deployed runtime environment
 *   pnpm secrets:rewrap                    # locally, via tsx on this same file
 *
 * Run with the same database and cipher configuration as the control plane.
 * Environment-specific execution and identity details belong in the private
 * operations runbook. Refuses to run under SECRET_CIPHER=none: an identity
 * rewrap would only churn rows.
 */
import { loadConfig } from '../config/env.js'
import { createPrisma, disconnectPrisma } from '../persistence/prisma.js'
import { makeSecretCipher } from './cipher.js'
import { rewrapAllSecrets } from './rewrap.js'

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.SECRET_CIPHER === 'none') {
    console.error('secrets:rewrap: SECRET_CIPHER=none — nothing to rewrap. Configure vault-transit first.')
    process.exitCode = 2
    return
  }
  const prisma = createPrisma(config.DATABASE_URL)
  try {
    const stats = await rewrapAllSecrets(prisma, makeSecretCipher(config), (m) => console.log(`secrets:rewrap: ${m}`))
    const rows = stats.reduce((n, s) => n + s.rows, 0)
    const values = stats.reduce((n, s) => n + s.values, 0)
    const skipped = stats.reduce((n, s) => n + s.skipped, 0)
    console.log(
      `secrets:rewrap: done — ${values} value(s) across ${rows} row(s) in ${stats.length} table(s)` +
        (skipped > 0
          ? `; ${skipped} row(s) skipped (updated concurrently by the CP — already sealed, nothing to do)`
          : '')
    )
  } finally {
    await disconnectPrisma()
  }
}

main().catch((err: unknown) => {
  // The sweep never puts secret material in error messages (cipher discipline).
  console.error('secrets:rewrap: failed —', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
