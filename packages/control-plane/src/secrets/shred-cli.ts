/**
 * Shred CLI — destroy the transit key of every deleted organization
 * (docs/designs/per-org-secret-encryption.md §6). This is the ONLY thing in the
 * codebase that deletes a Vault key; the control plane records the intent and
 * nothing more.
 *
 * Run it as its own workload with its OWN identity, not the CP's. A Vault role
 * binds to a service account, so granting key deletion to a second role bound to
 * the CP's account would leave the capability reachable from the CP — the
 * separation is the workload, not the role name. Give this job a service
 * account of its own whose policy carries, scoped to the org key prefix only,
 * `delete` on `<mount>/keys/<orgKeyPrefix>` + glob and `update` on that same
 * glob's `config` sub-path.
 *
 * No `list` capability is required, and none should be granted: this never
 * enumerates keys, it derives every name from a tombstone this deployment wrote.
 *
 * Like `rewrap-cli.ts` this lives in `src/` so it compiles into `dist/` and
 * ships in the runtime image:
 *
 *   node dist/secrets/shred-cli.js         # in the deployed runtime environment
 *   pnpm secrets:shred                     # locally, via tsx on this same file
 *
 * It reads a MINIMAL configuration of its own (`shred-config.ts`) — database,
 * Vault address, and `SECRET_SHRED_VAULT_TOKEN` / `SECRET_SHRED_VAULT_JWT_ROLE`.
 * Deliberately not the control plane's `loadConfig()`: that would demand the
 * CP's `API_KEY_PEPPER` and its Vault credential before this job could start,
 * handing back the very separation the job exists to create. The transit target
 * is not configured here at all — each tombstone carries the mount and key name
 * pinned when its organization was deleted.
 *
 * Unconfigured deployments simply accumulate unreferenced keys, which is the
 * right default for self-hosted and development installs.
 */
import { createPrisma, disconnectPrisma } from '../persistence/prisma.js'
import { loadShredConfig, shredVaultAuth } from './shred-config.js'
import { shredPendingKeys, VaultTransitKeyDestroyer } from './shred.js'
import { VaultHttp } from './vault-http.js'

async function main(): Promise<void> {
  const config = loadShredConfig()
  const http = new VaultHttp({
    addr: config.VAULT_ADDR,
    namespace: config.VAULT_NAMESPACE,
    auth: shredVaultAuth(config)
  })
  const prisma = createPrisma(config.DATABASE_URL)
  try {
    const stats = await shredPendingKeys(prisma, new VaultTransitKeyDestroyer(http), (m) =>
      console.log(`secrets:shred: ${m}`)
    )
    console.log(`secrets:shred: done — ${stats.shredded} key(s) destroyed, ${stats.failed} left for a re-run`)
    if (stats.failed > 0) process.exitCode = 1
  } finally {
    await disconnectPrisma()
  }
}

main().catch((err: unknown) => {
  console.error('secrets:shred: failed —', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
