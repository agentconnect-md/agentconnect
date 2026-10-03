// Source Cache accounting (source-cache.md §9, §10): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { anonRepoId, bundleKey, credRepoId, newBundleId, pointerKey, refHash } from '../src/source-cache/keys.js'
import { LocalStore, SOURCE_CACHE_SCHEMA, type SourceCacheObjectRow } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { canonicalColumns, POOL_STORE_SCHEMA } from '../src/store/postgres-dialect.js'
import { openTestStore, usingPostgresStore } from './store-support.js'

const GiB = 2 ** 30
const QUOTA = 20 * GiB
const MAX_BUNDLE = 2 * GiB
const HOUR = 60 * 60_000
const ANON = anonRepoId('https://github.com/acme/infra')
const OTHER_ANON = anonRepoId('https://github.com/acme/other')
const MAIN = 'refs/heads/main'

const bundle = (org = 'org-a', repo = ANON): string => bundleKey({ org, class: 'anon', repo, id: newBundleId() })
const pointer = (org = 'org-a', ref = MAIN, shape: 'blobless' | 'full' = 'blobless', repo = ANON): string =>
  pointerKey({ org, class: 'anon', repo, ref, shape })

const reserve = (
  store: LocalStore,
  key: string,
  bytes: number,
  overrides: Partial<Parameters<LocalStore['reserveBundle']>[0]> = {}
) =>
  store.reserveBundle({
    orgId: key.split('/')[1]!,
    key,
    refHash: refHash(MAIN),
    shape: 'blobless',
    bytes,
    now: 1_000,
    expiresAt: 1_000 + HOUR,
    quotaBytes: QUOTA,
    maxBundleBytes: MAX_BUNDLE,
    ...overrides
  })

/** Reserve and commit one bundle at its reserved size. */
async function committed(store: LocalStore, key: string, bytes: number, now = 2_000): Promise<void> {
  expect(await reserve(store, key, bytes)).toMatchObject({ admitted: true })
  expect(await store.commitBundle({ orgId: key.split('/')[1]!, key, actualBytes: bytes, now })).toMatchObject({
    committed: true,
    alreadyCommitted: false
  })
}

const keysOf = (rows: SourceCacheObjectRow[]): string[] => rows.map((row) => row.key).sort()

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<LocalStore> {
  store = await openTestStore()
  return store
}

describe('Source Cache reservations (§9 step 2)', () => {
  it('admits under the quota and refuses a bundle over the per-bundle cap', async () => {
    const s = await open()
    const key = bundle()
    expect(await reserve(s, key, MAX_BUNDLE)).toEqual({ admitted: true, committedBytes: 0, pendingBytes: MAX_BUNDLE })
    expect(await reserve(s, bundle(), MAX_BUNDLE + 1)).toEqual({ admitted: false, reason: 'too-large' })
    const row = await s.getSourceCacheObject('org-a', key)
    expect(row).toMatchObject({
      orgId: 'org-a',
      key,
      kind: 'bundle',
      state: 'pending',
      bytes: MAX_BUNDLE,
      repoClass: 'anon',
      repoId: ANON,
      refHash: refHash(MAIN),
      shape: 'blobless',
      createdAt: 1_000,
      expiresAt: 1_000 + HOUR,
      lastReadAt: null,
      targetKey: null,
      unpointedAt: null,
      claimedBy: null
    })
    expect(typeof row!.bytes).toBe('number')
  })

  it('counts committed bytes plus unexpired reservations against the quota, with GiB-scale values exact', async () => {
    const s = await open()
    for (let i = 0; i < 9; i++) await committed(s, bundle(), MAX_BUNDLE)
    expect(await reserve(s, bundle(), GiB, { now: 3_000, expiresAt: 10_000 })).toMatchObject({ admitted: true })
    expect(await s.sourceCacheUsage('org-a', 3_000)).toEqual({ committedBytes: 18 * GiB, pendingBytes: GiB })
    expect(await reserve(s, bundle(), GiB + 1, { now: 3_000 })).toEqual({
      admitted: false,
      reason: 'over-quota',
      committedBytes: 18 * GiB,
      pendingBytes: GiB
    })
    // The 1 GiB reservation expired at 10 000, so it no longer holds quota.
    expect(await reserve(s, bundle(), 2 * GiB, { now: 10_000, expiresAt: 20_000 })).toMatchObject({
      admitted: true,
      committedBytes: 18 * GiB,
      pendingBytes: 2 * GiB
    })
  })

  it('refuses a duplicate key and throws on a key the org cannot reserve', async () => {
    const s = await open()
    const key = bundle()
    await reserve(s, key, GiB)
    expect(await reserve(s, key, GiB)).toMatchObject({ admitted: false, reason: 'duplicate' })
    const foreign = bundle('org-b')
    await expect(reserve(s, foreign, GiB, { orgId: 'org-a' })).rejects.toThrow(/another org/)
    await expect(reserve(s, pointer(), GiB)).rejects.toThrow(/bundle key/)
    await expect(reserve(s, 'src/org-a/anon/nope/bundles/x.bundle', GiB, { orgId: 'org-a' })).rejects.toThrow(
      /not a Source Cache/
    )
    await expect(reserve(s, bundle(), 0)).rejects.toThrow(/positive integer/)
    await expect(reserve(s, bundle(), GiB, { expiresAt: 1_000 })).rejects.toThrow(/expire/)
    await expect(reserve(s, bundle(), GiB, { quotaBytes: Number.NaN })).rejects.toThrow(/quotaBytes/)
    await expect(reserve(s, bundle(), GiB, { maxBundleBytes: Number('x') })).rejects.toThrow(/maxBundleBytes/)
    await expect(reserve(s, bundle(), GiB, { quotaBytes: -1 })).rejects.toThrow(/quotaBytes/)
    expect(await s.getSourceCacheObject('org-a', foreign)).toBeUndefined()
    expect(await s.getSourceCacheObject('org-b', foreign)).toBeUndefined()
  })

  it('never admits past the quota when reservations race on one store', async () => {
    const s = await open()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserve(s, bundle(), 3 * GiB, { maxBundleBytes: 3 * GiB }))
    )
    expect(results.filter((r) => r.admitted)).toHaveLength(6)
    expect(results.filter((r) => !r.admitted).every((r) => r.reason === 'over-quota')).toBe(true)
    expect((await s.sourceCacheUsage('org-a', 1_000)).pendingBytes).toBe(18 * GiB)
  })
})

describe('Source Cache commit (§9 step 5)', () => {
  it('commits once, charges the actual size, and repeats as a no-op', async () => {
    const s = await open()
    const key = bundle()
    await reserve(s, key, 2 * GiB)
    expect(await s.commitBundle({ orgId: 'org-a', key, actualBytes: 2 * GiB - 7, now: 1_500 })).toEqual({
      committed: true,
      alreadyCommitted: false,
      bytes: 2 * GiB - 7
    })
    expect(await s.getSourceCacheObject('org-a', key)).toMatchObject({
      state: 'committed',
      bytes: 2 * GiB - 7,
      expiresAt: null,
      unpointedAt: 1_500
    })
    expect(await s.sourceCacheUsage('org-a', 1_500)).toEqual({ committedBytes: 2 * GiB - 7, pendingBytes: 0 })
    expect(await s.commitBundle({ orgId: 'org-a', key, actualBytes: 2 * GiB - 7, now: 1_600 })).toEqual({
      committed: true,
      alreadyCommitted: true,
      bytes: 2 * GiB - 7
    })
    expect(await s.sourceCacheUsage('org-a', 1_600)).toEqual({ committedBytes: 2 * GiB - 7, pendingBytes: 0 })
  })

  it('refuses an expired, missing, or oversized commit and a pointer key', async () => {
    const s = await open()
    const expired = bundle()
    await reserve(s, expired, GiB, { expiresAt: 5_000 })
    expect(await s.commitBundle({ orgId: 'org-a', key: expired, actualBytes: GiB, now: 5_000 })).toEqual({
      committed: false,
      reason: 'expired'
    })
    expect(await s.commitBundle({ orgId: 'org-a', key: bundle(), actualBytes: GiB, now: 1_000 })).toEqual({
      committed: false,
      reason: 'missing'
    })
    const small = bundle()
    await reserve(s, small, GiB)
    expect(await s.commitBundle({ orgId: 'org-a', key: small, actualBytes: GiB + 1, now: 1_000 })).toEqual({
      committed: false,
      reason: 'size-exceeds-reservation'
    })
    await expect(s.commitBundle({ orgId: 'org-a', key: pointer(), actualBytes: 1, now: 1_000 })).rejects.toThrow(
      /bundle key/
    )
    // A committer whose clock lags the sweep's must not revive a reservation the sweep already claimed.
    const swept = bundle()
    await reserve(s, swept, GiB, { expiresAt: 5_000 })
    await s.claimExpiredPendingSourceCache({ owner: 'sweeper', now: 6_000, leaseMs: 60_000, limit: 10 })
    expect(await s.commitBundle({ orgId: 'org-a', key: swept, actualBytes: GiB, now: 4_000 })).toEqual({
      committed: false,
      reason: 'claimed'
    })
    expect((await s.sourceCacheUsage('org-a', 1_000)).committedBytes).toBe(0)
  })
})

describe('Source Cache pointers and reads (§10)', () => {
  it('records the target, unpoints the replaced bundle at replacement time, and re-points as a no-op', async () => {
    const s = await open()
    const p = pointer()
    const b1 = bundle()
    const b2 = bundle()
    await committed(s, b1, GiB, 2_000)
    await committed(s, b2, GiB, 2_100)
    expect(await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: p, bundleKey: b1, now: 3_000 })).toEqual({
      set: true,
      previousBundleKey: undefined
    })
    expect(await s.getSourceCacheObject('org-a', p)).toMatchObject({
      kind: 'pointer',
      state: 'committed',
      bytes: 0,
      targetKey: b1,
      createdAt: 3_000,
      updatedAt: 3_000,
      refHash: refHash(MAIN),
      shape: 'blobless'
    })
    expect((await s.getSourceCacheObject('org-a', b1))!.unpointedAt).toBeNull()

    expect(await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: p, bundleKey: b2, now: 4_000 })).toEqual({
      set: true,
      previousBundleKey: b1
    })
    expect((await s.getSourceCacheObject('org-a', b1))!.unpointedAt).toBe(4_000)
    expect((await s.getSourceCacheObject('org-a', b2))!.unpointedAt).toBeNull()
    expect(await s.getSourceCacheObject('org-a', p)).toMatchObject({
      targetKey: b2,
      createdAt: 3_000,
      updatedAt: 4_000
    })

    expect(await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: p, bundleKey: b2, now: 5_000 })).toEqual({
      set: true,
      previousBundleKey: undefined
    })
    expect((await s.getSourceCacheObject('org-a', b1))!.unpointedAt).toBe(4_000)
    expect((await s.getSourceCacheObject('org-a', b2))!.unpointedAt).toBeNull()
  })

  it('refuses a pending bundle, a bundle of another ref, shape or repository, and a claimed bundle', async () => {
    const s = await open()
    const pending = bundle()
    await reserve(s, pending, GiB)
    expect(
      await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: pointer(), bundleKey: pending, now: 2 })
    ).toEqual({ set: false, reason: 'bundle-not-committed' })
    const b = bundle()
    await committed(s, b, GiB)
    const devPointer = pointer('org-a', 'refs/heads/dev')
    expect(await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: devPointer, bundleKey: b, now: 2 })).toEqual({
      set: false,
      reason: 'bundle-mismatch'
    })
    const fullPointer = pointer('org-a', MAIN, 'full')
    expect(await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: fullPointer, bundleKey: b, now: 2 })).toEqual({
      set: false,
      reason: 'bundle-mismatch'
    })
    const otherRepo = pointer('org-a', MAIN, 'blobless', OTHER_ANON)
    expect(await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: otherRepo, bundleKey: b, now: 2 })).toEqual({
      set: false,
      reason: 'bundle-mismatch'
    })
    expect(
      await s.claimUnreferencedSourceCacheBundles({
        owner: 'sweeper',
        now: 10_000,
        leaseMs: 60_000,
        limit: 10,
        unpointedBefore: 10_000
      })
    ).toHaveLength(1)
    expect(await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: pointer(), bundleKey: b, now: 10_001 })).toEqual(
      { set: false, reason: 'bundle-claimed' }
    )
    expect(await s.getSourceCacheObject('org-a', pointer())).toBeUndefined()
  })

  it('moves lastReadAt forward only', async () => {
    const s = await open()
    const b = bundle()
    await committed(s, b, GiB)
    expect(await s.touchSourceCacheRead({ orgId: 'org-a', key: b, at: 5_000 })).toBe(true)
    expect(await s.touchSourceCacheRead({ orgId: 'org-a', key: b, at: 4_000 })).toBe(false)
    expect((await s.getSourceCacheObject('org-a', b))!.lastReadAt).toBe(5_000)
    expect(await s.touchSourceCacheRead({ orgId: 'org-a', key: bundle(), at: 6_000 })).toBe(false)
  })
})

describe('Source Cache sweep claims and deletes (§10)', () => {
  const claim = { owner: 'member-1', leaseMs: 60_000, limit: 10 }

  it('claims expired reservations up to the limit, once per lease', async () => {
    const s = await open()
    const expired = [bundle(), bundle(), bundle()]
    for (const key of expired) await reserve(s, key, GiB, { expiresAt: 5_000 })
    await reserve(s, bundle(), GiB, { expiresAt: 500_000 })
    const first = await s.claimExpiredPendingSourceCache({ ...claim, now: 6_000, limit: 2 })
    expect(first).toHaveLength(2)
    expect(first.every((row) => row.claimedBy === 'member-1' && row.claimedAt === 6_000)).toBe(true)
    const second = await s.claimExpiredPendingSourceCache({ ...claim, owner: 'member-2', now: 7_000 })
    expect(keysOf([...first, ...second])).toEqual([...expired].sort())
    expect(await s.claimExpiredPendingSourceCache({ ...claim, owner: 'member-3', now: 7_000 })).toEqual([])
    // member-1 died: its lease lapses and another member retakes the rows.
    const retaken = await s.claimExpiredPendingSourceCache({ ...claim, owner: 'member-3', now: 66_500 })
    expect(keysOf(retaken)).toEqual(keysOf(first))
  })

  it('claims an unpointed bundle only after the cutoff, never a pointed or pending one', async () => {
    const s = await open()
    const p = pointer()
    const pointed = bundle()
    const replaced = bundle()
    const orphan = bundle()
    await committed(s, replaced, GiB, 1_000)
    await committed(s, pointed, GiB, 1_000)
    await committed(s, orphan, GiB, 2_000)
    await reserve(s, bundle(), GiB)
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: p, bundleKey: replaced, now: 1_500 })
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: p, bundleKey: pointed, now: 3_000 })
    const at = (cutoff: number, owner: string) =>
      s.claimUnreferencedSourceCacheBundles({ ...claim, owner, now: 100_000, unpointedBefore: cutoff })
    expect(await at(1_999, 'a')).toEqual([])
    expect(keysOf(await at(2_000, 'b'))).toEqual([orphan])
    expect(keysOf(await at(3_000, 'c'))).toEqual([replaced])
    expect(await at(1_000_000, 'd')).toEqual([])
  })

  it('claims a pointer by its last read, or its last write when never read; a rewrite clears the claim', async () => {
    const s = await open()
    const read = pointer()
    const unread = pointer('org-a', 'refs/heads/dev')
    const b1 = bundle()
    await committed(s, b1, GiB)
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: read, bundleKey: b1, now: 1_000 })
    await s.touchSourceCacheRead({ orgId: 'org-a', key: read, at: 9_000 })
    const devBundle = bundle()
    await s.reserveBundle({
      orgId: 'org-a',
      key: devBundle,
      refHash: refHash('refs/heads/dev'),
      shape: 'blobless',
      bytes: GiB,
      now: 1_000,
      expiresAt: 1_000 + HOUR,
      quotaBytes: QUOTA,
      maxBundleBytes: MAX_BUNDLE
    })
    await s.commitBundle({ orgId: 'org-a', key: devBundle, actualBytes: GiB, now: 1_000 })
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: unread, bundleKey: devBundle, now: 2_000 })
    expect(keysOf(await s.claimUnreadSourceCachePointers({ ...claim, now: 100_000, unreadBefore: 5_000 }))).toEqual([
      unread
    ])
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: unread, bundleKey: devBundle, now: 100_001 })
    expect((await s.getSourceCacheObject('org-a', unread))!.claimedBy).toBeNull()
    expect(keysOf(await s.claimUnreadSourceCachePointers({ ...claim, now: 200_000, unreadBefore: 9_000 }))).toEqual([
      read
    ])
  })

  it('never claims a pointer rewritten after its last read as unread', async () => {
    const s = await open()
    const ptr = pointer('org-a', 'refs/heads/main')
    const first = bundle()
    await committed(s, first, GiB)
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: ptr, bundleKey: first, now: 1_000 })
    await s.touchSourceCacheRead({ orgId: 'org-a', key: ptr, at: 2_000 })
    const second = bundle()
    await committed(s, second, GiB)
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: ptr, bundleKey: second, now: 100_000 })
    expect(await s.claimUnreadSourceCachePointers({ ...claim, now: 100_001, unreadBefore: 5_000 })).toEqual([])
    expect(keysOf(await s.claimUnreadSourceCachePointers({ ...claim, now: 300_000, unreadBefore: 200_000 }))).toEqual([
      ptr
    ])
  })

  it('deletes idempotently, releases committed bytes, honours the claim fence, and unpoints a deleted pointer', async () => {
    const s = await open()
    const b = bundle()
    await committed(s, b, 2 * GiB)
    const pending = bundle()
    await reserve(s, pending, GiB)
    expect(await s.sourceCacheUsage('org-a', 1_000)).toEqual({ committedBytes: 2 * GiB, pendingBytes: GiB })

    expect(await s.deleteSourceCacheObject({ orgId: 'org-a', key: pending, now: 3_000 })).toEqual({
      deleted: true,
      releasedBytes: 0
    })
    expect(await s.sourceCacheUsage('org-a', 1_000)).toEqual({ committedBytes: 2 * GiB, pendingBytes: 0 })

    const p = pointer()
    await s.setSourceCachePointer({ orgId: 'org-a', pointerKey: p, bundleKey: b, now: 4_000 })
    expect(await s.deleteSourceCacheObject({ orgId: 'org-a', key: b, now: 5_000 })).toEqual({
      deleted: false,
      reason: 'referenced'
    })
    const [claimedPointer] = await s.claimUnreadSourceCachePointers({ ...claim, now: 10_000, unreadBefore: 9_000 })
    expect(claimedPointer!.key).toBe(p)
    expect(await s.deleteSourceCacheObject({ orgId: 'org-a', key: p, now: 11_000, claimedBy: 'someone-else' })).toEqual(
      { deleted: false, reason: 'claim-lost' }
    )
    expect(await s.deleteSourceCacheObject({ orgId: 'org-a', key: p, now: 11_000, claimedBy: 'member-1' })).toEqual({
      deleted: true,
      releasedBytes: 0
    })
    expect((await s.getSourceCacheObject('org-a', b))!.unpointedAt).toBe(11_000)

    const [claimedBundle] = await s.claimUnreferencedSourceCacheBundles({
      ...claim,
      now: 20_000,
      unpointedBefore: 11_000
    })
    expect(claimedBundle!.key).toBe(b)
    expect(await s.deleteSourceCacheObject({ orgId: 'org-a', key: b, now: 21_000, claimedBy: 'member-1' })).toEqual({
      deleted: true,
      releasedBytes: 2 * GiB
    })
    expect(await s.deleteSourceCacheObject({ orgId: 'org-a', key: b, now: 21_000 })).toEqual({
      deleted: false,
      reason: 'missing'
    })
    expect(await s.sourceCacheUsage('org-a', 21_000)).toEqual({ committedBytes: 0, pendingBytes: 0 })
  })
})

describe('Source Cache org scoping', () => {
  it('keeps usage, reads, and writes per org while sweep claims span orgs', async () => {
    const s = await open()
    for (let i = 0; i < 10; i++) await committed(s, bundle('org-a'), MAX_BUNDLE)
    expect(await reserve(s, bundle('org-a'), 1)).toMatchObject({ admitted: false, reason: 'over-quota' })
    const b = bundle('org-b')
    expect(await reserve(s, b, MAX_BUNDLE)).toEqual({ admitted: true, committedBytes: 0, pendingBytes: MAX_BUNDLE })
    expect(await s.sourceCacheUsage('org-b', 1_000)).toEqual({ committedBytes: 0, pendingBytes: MAX_BUNDLE })
    expect(await s.sourceCacheUsage('org-a', 1_000)).toEqual({ committedBytes: 20 * GiB, pendingBytes: 0 })

    expect(await s.getSourceCacheObject('org-a', b)).toBeUndefined()
    await expect(s.commitBundle({ orgId: 'org-a', key: b, actualBytes: 1, now: 1_000 })).rejects.toThrow(/another org/)
    await expect(s.deleteSourceCacheObject({ orgId: 'org-a', key: b, now: 1_000 })).rejects.toThrow(/another org/)
    await expect(s.touchSourceCacheRead({ orgId: 'org-a', key: b, at: 1_000 })).rejects.toThrow(/another org/)
    await expect(
      s.setSourceCachePointer({ orgId: 'org-a', pointerKey: pointer('org-a'), bundleKey: b, now: 1_000 })
    ).rejects.toThrow(/another org/)
    expect((await s.getSourceCacheObject('org-b', b))!.state).toBe('pending')

    const credKey = bundleKey({ org: 'org-c', class: 'cred', repo: credRepoId('github', '42'), id: newBundleId() })
    await reserve(s, credKey, GiB, { expiresAt: 2_000 })
    await reserve(s, bundle('org-b'), GiB, { expiresAt: 2_000 })
    const claimed = await s.claimExpiredPendingSourceCache({ owner: 'm', now: 3_000, leaseMs: 1_000, limit: 10 })
    expect(claimed.map((row) => [row.orgId, row.repoClass]).sort()).toEqual([
      ['org-b', 'anon'],
      ['org-c', 'cred']
    ])
    expect(claimed.find((row) => row.orgId === 'org-c')!.repoId).toBe('github:42')
  })

  it('keeps each org usage row equal to the sum of its committed bundles after a mixed sequence', async () => {
    const s = await open()
    const sizes: Record<string, number[]> = { 'org-a': [GiB, 3, 2 * GiB - 1], 'org-b': [7, GiB + 5] }
    const keys: Record<string, string[]> = { 'org-a': [], 'org-b': [] }
    for (const [org, list] of Object.entries(sizes))
      for (const bytes of list) {
        const key = bundle(org)
        keys[org]!.push(key)
        await committed(s, key, bytes)
      }
    await s.deleteSourceCacheObject({ orgId: 'org-a', key: keys['org-a']![1]!, now: 5_000 })
    await s.commitBundle({ orgId: 'org-b', key: keys['org-b']![0]!, actualBytes: 7, now: 5_000 })
    for (const org of ['org-a', 'org-b']) {
      let sum = 0
      for (const key of keys[org]!) {
        const row = await s.getSourceCacheObject(org, key)
        if (row?.state === 'committed') sum += row.bytes
      }
      expect((await s.sourceCacheUsage(org, 5_000)).committedBytes, org).toBe(sum)
    }
  })
})

describe('Source Cache schema', () => {
  it('lists every camelCase column and result alias in canonicalColumns', () => {
    const names = new Set([...SOURCE_CACHE_SCHEMA.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g)].map((m) => m[0]))
    for (const alias of ['committedBytes', 'pendingBytes']) names.add(alias)
    const canonical = new Set<string>(canonicalColumns)
    expect([...names].filter((name) => !canonical.has(name))).toEqual([])
    expect(names.size).toBeGreaterThan(10)
  })
})

// Two pool members on their own connections, plus a raw client to hold row locks: the guarantees §9 and §10 rest on.
describe.skipIf(!usingPostgresStore())('Source Cache across PostgreSQL pool members', () => {
  const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
  const opened: LocalStore[] = []
  const raw: pg.Client[] = []

  afterEach(async () => {
    for (const client of raw.splice(0)) await client.end().catch(() => undefined)
    for (const member of opened.splice(0)) await member.close()
  })

  async function member(): Promise<LocalStore> {
    const database = await PostgresAsyncDatabase.open({ version: 1, databaseUrl, maxConnections: 4 })
    try {
      const store = await LocalStore.open({
        database,
        shared: true,
        ownerId: randomUUID(),
        orgForAgent: () => undefined
      })
      opened.push(store)
      return store
    } finally {
      await database.finishSchemaInitialization()
    }
  }

  async function rawClient(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: databaseUrl, options: `-c search_path=${POOL_STORE_SCHEMA}` })
    await client.connect()
    raw.push(client)
    return client
  }

  const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
    let settled = false
    void promise.then(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise((resolve) => setTimeout(resolve, ms))
    return settled
  }

  it('never admits past the quota when two members reserve concurrently', async () => {
    const a = await member()
    const b = await member()
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reserve(i % 2 === 0 ? a : b, bundle(), 3 * GiB, { maxBundleBytes: 3 * GiB }))
    )
    expect(results.filter((r) => r.admitted)).toHaveLength(Math.floor(QUOTA / (3 * GiB)))
    expect((await a.sourceCacheUsage('org-a', 1_000)).pendingBytes).toBe(18 * GiB)
  })

  it('makes a reservation wait for the usage-row lock and then count what the holder committed', async () => {
    const a = await member()
    expect(await reserve(a, bundle(), 1)).toMatchObject({ admitted: true })
    const holder = await rawClient()
    await holder.query('BEGIN')
    await holder.query("SELECT committedBytes FROM source_cache_usage WHERE orgId = 'org-a' FOR UPDATE")
    const waiting = reserve(a, bundle(), GiB)
    expect(await settledWithin(waiting, 300)).toBe(false)
    await holder.query(
      `INSERT INTO source_cache_object (orgId, key, kind, state, bytes, repoClass, repoId, refHash, shape, createdAt, updatedAt, expiresAt)
       VALUES ('org-a', $1, 'bundle', 'pending', $2, 'anon', $3, $4, 'blobless', 1000, 1000, $5)`,
      [bundle(), QUOTA - 1, ANON, refHash(MAIN), 1_000 + HOUR]
    )
    await holder.query('COMMIT')
    expect(await waiting).toMatchObject({ admitted: false, reason: 'over-quota', pendingBytes: QUOTA })
  })

  it('serializes two members creating the same pointer, so the first bundle is unpointed and claimable', async () => {
    const a = await member()
    const b = await member()
    const first = bundle()
    const second = bundle()
    await committed(a, first, GiB)
    await committed(a, second, GiB)
    const holder = await rawClient()
    await holder.query('BEGIN')
    await holder.query('SELECT key FROM source_cache_object WHERE orgId = $1 AND key = $2 FOR UPDATE', ['org-a', first])
    const fromA = a.setSourceCachePointer({ orgId: 'org-a', pointerKey: pointer(), bundleKey: first, now: 3_000 })
    expect(await settledWithin(fromA, 300)).toBe(false)
    const fromB = b.setSourceCachePointer({ orgId: 'org-a', pointerKey: pointer(), bundleKey: second, now: 4_000 })
    expect(await settledWithin(fromB, 300)).toBe(false)
    await holder.query('COMMIT')
    expect(await fromA).toEqual({ set: true, previousBundleKey: undefined })
    expect(await fromB).toEqual({ set: true, previousBundleKey: first })
    expect(await a.getSourceCacheObject('org-a', pointer())).toMatchObject({ targetKey: second })
    expect(await a.getSourceCacheObject('org-a', first)).toMatchObject({ unpointedAt: 4_000 })
    const claimed = await a.claimUnreferencedSourceCacheBundles({
      owner: 'a',
      now: 5_000,
      leaseMs: 60_000,
      limit: 10,
      unpointedBefore: 4_000
    })
    expect(keysOf(claimed)).toEqual([first])
  })

  it('skips rows another transaction holds and hands concurrent members disjoint claims', async () => {
    const a = await member()
    const b = await member()
    const keys = Array.from({ length: 12 }, () => bundle())
    for (const key of keys) await reserve(a, key, GiB, { expiresAt: 5_000 })
    const holder = await rawClient()
    await holder.query('BEGIN')
    await holder.query('SELECT key FROM source_cache_object WHERE orgId = $1 AND key = $2 FOR UPDATE', [
      'org-a',
      keys[0]
    ])
    const claiming = a.claimExpiredPendingSourceCache({ owner: 'a', now: 6_000, leaseMs: 60_000, limit: 3 })
    expect(await settledWithin(claiming, 1_000)).toBe(true)
    const first = await claiming
    expect(first).toHaveLength(3)
    expect(keysOf(first)).not.toContain(keys[0])
    await holder.query('COMMIT')

    const [fromA, fromB] = await Promise.all([
      a.claimExpiredPendingSourceCache({ owner: 'a', now: 6_000, leaseMs: 60_000, limit: 5 }),
      b.claimExpiredPendingSourceCache({ owner: 'b', now: 6_000, leaseMs: 60_000, limit: 5 })
    ])
    const all = [...first, ...fromA, ...fromB].map((row) => row.key)
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual([...keys].sort())
    expect(fromA.every((row) => row.claimedBy === 'a') && fromB.every((row) => row.claimedBy === 'b')).toBe(true)
  })
})
