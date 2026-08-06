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
 * `SECRET_SHRED_VAULT_TOKEN` / `SECRET_SHRED_VAULT_JWT_ROLE` select this job's
 * own credential; it refuses to fall back to the CP's. Unconfigured deployments
 * simply accumulate unreferenced keys, which is the right default for
 * self-hosted and development installs.
 */
import { loadConfig } from '../config/env.js'
import { createPrisma, disconnectPrisma } from '../persistence/prisma.js'
import { effectiveOrgKeyPrefix } from './scope.js'
import { shredPendingKeys, VaultTransitKeyDestroyer } from './shred.js'
import { VaultHttp, type VaultAuth } from './vault-http.js'

function shredAuth(env: NodeJS.ProcessEnv, config: { VAULT_JWT_PATH: string; VAULT_AUTH_MOUNT: string }): VaultAuth {
  const token = env.SECRET_SHRED_VAULT_TOKEN
  const role = env.SECRET_SHRED_VAULT_JWT_ROLE
  if (token && role) throw new Error('set exactly one of SECRET_SHRED_VAULT_TOKEN or SECRET_SHRED_VAULT_JWT_ROLE')
  if (token) return { method: 'token', token }
  if (role) {
    return {
      method: 'jwt',
      role,
      jwtPath: env.SECRET_SHRED_VAULT_JWT_PATH ?? config.VAULT_JWT_PATH,
      authMount: env.SECRET_SHRED_VAULT_AUTH_MOUNT ?? config.VAULT_AUTH_MOUNT
    }
  }
  // Deliberately NOT falling back to the CP's credential: that would put key
  // deletion back inside the identity this job exists to stay outside of.
  throw new Error(
    'no shred credential — set SECRET_SHRED_VAULT_TOKEN or SECRET_SHRED_VAULT_JWT_ROLE for this job’s OWN Vault identity'
  )
}

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.SECRET_CIPHER === 'none') {
    console.error('secrets:shred: SECRET_CIPHER=none — values are stored in plaintext, so there is no key to destroy.')
    process.exitCode = 2
    return
  }
  if (!config.VAULT_ADDR) {
    console.error('secrets:shred: VAULT_ADDR is required.')
    process.exitCode = 2
    return
  }
  const http = new VaultHttp({
    addr: config.VAULT_ADDR,
    namespace: config.VAULT_NAMESPACE,
    auth: shredAuth(process.env, config)
  })
  const prisma = createPrisma(config.DATABASE_URL)
  try {
    const stats = await shredPendingKeys(
      prisma,
      new VaultTransitKeyDestroyer(http, config.VAULT_TRANSIT_MOUNT),
      effectiveOrgKeyPrefix(config.VAULT_TRANSIT_KEY, config.VAULT_TRANSIT_ORG_KEY_PREFIX),
      (m) => console.log(`secrets:shred: ${m}`)
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
