/**
 * `shredPendingKeys` — destroy the transit key of every deleted organization
 * (docs/designs/per-org-secret-encryption.md §6), turning that org's ciphertext
 * into permanent noise **including the copies inside older database backups**.
 *
 * Reads `pending_key_shred`, which the org-deletion transaction wrote alongside
 * the delete. Two properties follow from that, and both are the point:
 *
 * - **It never enumerates keys.** Every name is derived from an org id this
 *   deployment recorded itself. A `LIST transit/keys` diff would need list
 *   capability over the whole mount, and Vault cannot restrict a list to a
 *   prefix — so on a mount shared by several deployments, every other
 *   deployment's org keys would look like orphans to this one. There is no key
 *   name this shredder can produce that it did not build from its own tombstone.
 * - **It does not run inside the CP.** A Vault role binds to a workload's
 *   service account, so a second role bound to the CP's account would be
 *   reachable by the CP itself. The destructive capability is separated only by
 *   running as its own workload under its own identity — hence a CLI.
 *
 * Idempotent: destroying an already-absent key counts as done and clears the
 * row, and a failure on one org leaves its tombstone for the next run while the
 * rest proceed. Nothing here logs a key's contents; a key NAME is not secret,
 * but an org id is tenant-identifying, so names are logged only at the caller's
 * discretion via `log`.
 */
import type { PrismaClient } from '../generated/prisma/client.js'
import { describeVaultError, VaultHttp } from './vault-http.js'

export interface KeyDestroyer {
  /** Destroy one transit key. Absent ⇒ resolve (already shredded). */
  destroy(keyName: string): Promise<void>
}

export interface ShredStats {
  /** Tombstones whose key is now gone and whose row was cleared. */
  shredded: number
  /** Tombstones left in place because their destroy failed — retried next run. */
  failed: number
}

export async function shredPendingKeys(
  prisma: PrismaClient,
  destroyer: KeyDestroyer,
  orgKeyPrefix: string,
  log: (message: string) => void = () => {}
): Promise<ShredStats> {
  const pending = await prisma.pendingKeyShred.findMany({ orderBy: { createdAt: 'asc' } })
  let shredded = 0
  let failed = 0

  for (const row of pending) {
    const keyName = `${orgKeyPrefix}${row.orgId}`
    try {
      await destroyer.destroy(keyName)
    } catch (err) {
      failed += 1
      // The tombstone stays: an operator re-run picks it up. Never echo a body.
      log(`failed to destroy ${keyName} — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // Clear only AFTER the key is gone. The reverse order would drop the only
    // record that the key must die.
    await prisma.pendingKeyShred.delete({ where: { orgId: row.orgId } })
    shredded += 1
    log(`destroyed ${keyName}`)
  }
  return { shredded, failed }
}

/**
 * Vault Transit's two-step destroy: a key is undeletable until its config says
 * otherwise, so allow deletion and then delete. A missing key is success — the
 * previous run destroyed it and died before clearing the row.
 */
export class VaultTransitKeyDestroyer implements KeyDestroyer {
  constructor(
    private readonly http: VaultHttp,
    private readonly mount: string
  ) {}

  async destroy(keyName: string): Promise<void> {
    const configured = await this.http.request('POST', `${this.mount}/keys/${keyName}/config`, {
      deletion_allowed: true
    })
    if (configured.status === 404) return // already gone
    if (!configured.ok) {
      throw new Error(`vault transit allow-deletion failed: ${await describeVaultError(configured)}`)
    }
    const deleted = await this.http.request('DELETE', `${this.mount}/keys/${keyName}`)
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`vault transit key delete failed: ${await describeVaultError(deleted)}`)
    }
  }
}
