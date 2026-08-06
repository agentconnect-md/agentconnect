/**
 * `shredPendingKeys` + `VaultTransitKeyDestroyer` — the drain half of
 * crypto-shredding (docs/designs/per-org-secret-encryption.md §6).
 *
 * The two properties worth protecting are structural, not behavioural: every
 * destroyed name is DERIVED from a tombstone this deployment wrote, and no key
 * is ever enumerated. Both are asserted here, because losing either turns an
 * irreversible operation loose on names this deployment does not own.
 */
import { describe, it, expect } from 'vitest'
import type { PrismaClient } from '../generated/prisma/client.js'
import { shredPendingKeys, VaultTransitKeyDestroyer, type KeyDestroyer } from './shred.js'
import { loadShredConfig, shredVaultAuth } from './shred-config.js'
import { VaultHttp } from './vault-http.js'

describe('shredPendingKeys', () => {
  it('destroys each tombstone’s PINNED target and clears only the rows that succeeded', async () => {
    const destroyed: string[] = []
    const deleted: string[] = []
    const prisma = {
      pendingKeyShred: {
        findMany: async () => [
          { orgId: 'org-aaa', mount: 'transit', keyName: 'ac-cp-org-org-aaa', createdAt: new Date(1) },
          { orgId: 'org-bbb', mount: 'transit', keyName: 'ac-cp-org-org-bbb', createdAt: new Date(2) }
        ],
        delete: async ({ where }: { where: { orgId: string } }) => {
          deleted.push(where.orgId)
          return where
        }
      }
    } as unknown as PrismaClient
    const destroyer: KeyDestroyer = {
      destroy: async (mount, k) => {
        destroyed.push(`${mount}/${k}`)
        // The second org's key refuses — its tombstone must survive.
        if (k.endsWith('org-bbb')) throw new Error('vault said no')
      }
    }

    const stats = await shredPendingKeys(prisma, destroyer)

    // Names come from the ROW, never from current config and never from a list.
    expect(destroyed).toEqual(['transit/ac-cp-org-org-aaa', 'transit/ac-cp-org-org-bbb'])
    expect(stats).toEqual({ shredded: 1, failed: 1 })
    // Only the successful one lost its tombstone; the failure is retried later.
    expect(deleted).toEqual(['org-aaa'])
  })

  it('uses the pinned mount even after configuration moved on', async () => {
    // A tombstone written before a mount rotation must still aim where its key
    // actually lives; re-deriving would hit a 404 that reads as "already gone"
    // and would clear the row while the real key survived.
    const destroyed: string[] = []
    const prisma = {
      pendingKeyShred: {
        findMany: async () => [
          { orgId: 'org-old', mount: 'transit-legacy', keyName: 'old-prefix-org-old', createdAt: new Date(1) }
        ],
        delete: async ({ where }: { where: { orgId: string } }) => where
      }
    } as unknown as PrismaClient
    await shredPendingKeys(prisma, {
      destroy: async (mount, k) => {
        destroyed.push(`${mount}/${k}`)
      }
    })
    expect(destroyed).toEqual(['transit-legacy/old-prefix-org-old'])
  })

  it('is a no-op with no tombstones', async () => {
    const prisma = {
      pendingKeyShred: { findMany: async () => [], delete: async () => ({}) }
    } as unknown as PrismaClient
    const destroy = async (): Promise<void> => {
      throw new Error('must not be called')
    }
    expect(await shredPendingKeys(prisma, { destroy })).toEqual({ shredded: 0, failed: 0 })
  })
})

describe('VaultTransitKeyDestroyer', () => {
  function fakeVault(handler: (method: string, path: string) => { status: number; body?: unknown }) {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const path = url.slice(url.indexOf('/v1/') + 4)
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      calls.push({ method: init?.method ?? 'GET', path, body })
      const r = handler(init?.method ?? 'GET', path)
      // 204 must carry a null body (Vault's real answer for these two calls).
      return r.status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(r.body ?? {}), {
            status: r.status,
            headers: { 'content-type': 'application/json' }
          })
    }
    return { calls, fetchImpl }
  }

  const http = (fetchImpl: typeof fetch): VaultHttp =>
    new VaultHttp({ addr: 'https://vault.example.com', auth: { method: 'token', token: 't' }, fetchImpl })

  it('allows deletion first, then deletes — a transit key is undeletable until its config says so', async () => {
    const vault = fakeVault(() => ({ status: 204 }))
    await new VaultTransitKeyDestroyer(http(vault.fetchImpl)).destroy('transit', 'ac-cp-org-org-aaa')

    expect(vault.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST transit/keys/ac-cp-org-org-aaa/config',
      'DELETE transit/keys/ac-cp-org-org-aaa'
    ])
    expect(vault.calls[0]!.body).toEqual({ deletion_allowed: true })
    // No enumeration, ever: a list would span the whole shared mount.
    expect(vault.calls.some((c) => c.path.endsWith('keys') || c.method === 'LIST')).toBe(false)
  })

  it('treats an already-absent key as done — the previous run died between destroy and clear', async () => {
    const vault = fakeVault(() => ({ status: 404, body: { errors: [] } }))
    await expect(
      new VaultTransitKeyDestroyer(http(vault.fetchImpl)).destroy('transit', 'ac-cp-org-gone')
    ).resolves.toBeUndefined()
    expect(vault.calls).toHaveLength(1) // stopped after the 404 config call
  })

  it('surfaces a refusal as an error (status + Vault errors[], no payload) so the tombstone survives', async () => {
    const vault = fakeVault((method) =>
      method === 'DELETE' ? { status: 403, body: { errors: ['permission denied'] } } : { status: 204 }
    )
    const err = await new VaultTransitKeyDestroyer(http(vault.fetchImpl))
      .destroy('transit', 'ac-cp-org-org-aaa')
      .catch((e: unknown) => e as Error)
    expect((err as Error).message).toContain('403')
    expect((err as Error).message).toContain('permission denied')
  })
})

describe('loadShredConfig — the shred workload stands on its OWN configuration', () => {
  const MINIMAL = {
    DATABASE_URL: 'postgresql://x:y@localhost:5432/db',
    VAULT_ADDR: 'https://vault.example.com',
    SECRET_SHRED_VAULT_TOKEN: 'shred-token'
  }

  it('parses with NO control-plane variables present — no API_KEY_PEPPER, no CP Vault credential', () => {
    // The blocker this replaced: loadConfig() demanded both before the job could
    // start, so a least-privilege workload had to be handed the CP's own
    // credential (or fake it) — giving back the separation the job exists for.
    const config = loadShredConfig(MINIMAL as NodeJS.ProcessEnv)
    expect(config.DATABASE_URL).toBe(MINIMAL.DATABASE_URL)
    expect(shredVaultAuth(config)).toEqual({ method: 'token', token: 'shred-token' })
  })

  it('refuses with neither credential, and with both', () => {
    expect(() =>
      loadShredConfig({ DATABASE_URL: MINIMAL.DATABASE_URL, VAULT_ADDR: MINIMAL.VAULT_ADDR } as NodeJS.ProcessEnv)
    ).toThrow(/exactly one/)
    expect(() => loadShredConfig({ ...MINIMAL, SECRET_SHRED_VAULT_JWT_ROLE: 'r' } as NodeJS.ProcessEnv)).toThrow(
      /exactly one/
    )
  })

  it('never reads the control plane’s VAULT_TOKEN as a fallback', () => {
    expect(() =>
      loadShredConfig({
        DATABASE_URL: MINIMAL.DATABASE_URL,
        VAULT_ADDR: MINIMAL.VAULT_ADDR,
        VAULT_TOKEN: 'the-control-planes-token'
      } as NodeJS.ProcessEnv)
    ).toThrow(/exactly one/)
  })
})
