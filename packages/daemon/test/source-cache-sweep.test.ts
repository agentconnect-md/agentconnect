import { FakeClock } from '@agentconnect.md/connection'
import { describe, expect, it } from 'vitest'
import { anonRepoId, bundleKey, newBundleId, pointerKey, refHash } from '../src/source-cache/keys.js'
import type { SourceCacheBucketLifecycle } from '../src/source-cache/object-client.js'
import { SourceCacheObjectError } from '../src/source-cache/object-client.js'
import {
  createSourceCacheSweeper,
  SWEEP_LEASE_MS,
  type SourceCacheSweeperDeps,
  type SourceCacheSweepStore
} from '../src/source-cache/sweep.js'
import type { SourceCacheDeleteResult, SourceCacheObjectRow } from '../src/store/local-store.js'

// The Source Cache sweep pass and loop (source-cache.md §9, §10) over an in-memory store and a scripted object client.

const T0 = 1_700_000_000_000
const DAY = 86_400_000
const GET_URL_SECONDS = 300
const CUTOFF_MS = (GET_URL_SECONDS + 300) * 1000
const REPO = anonRepoId('https://github.com/acme/widgets')
const OWNER = 'member-1/abcd1234'

const newBundle = (): string => bundleKey({ org: 'org_1', class: 'anon', repo: REPO, id: newBundleId() })
const newPointer = (ref = 'refs/heads/main'): string =>
  pointerKey({ org: 'org_1', class: 'anon', repo: REPO, ref, shape: 'blobless' })

function row(key: string, fields: Partial<SourceCacheObjectRow>): SourceCacheObjectRow {
  return {
    orgId: 'org_1',
    key,
    kind: 'bundle',
    state: 'committed',
    bytes: 1000,
    repoClass: 'anon',
    repoId: REPO,
    refHash: refHash('refs/heads/main'),
    shape: 'blobless',
    createdAt: T0 - 30 * DAY,
    updatedAt: T0 - 30 * DAY,
    expiresAt: null,
    lastReadAt: null,
    targetKey: null,
    unpointedAt: null,
    claimedBy: null,
    claimedAt: null,
    ...fields
  }
}

class FakeStore implements SourceCacheSweepStore {
  readonly rows = new Map<string, SourceCacheObjectRow>()
  readonly calls: string[] = []
  readonly claimInputs: Array<Record<string, unknown>> = []
  readonly deletes: Array<Record<string, unknown>> = []
  releasedBytes = 0
  /** Lets a test change a row between the claim and the delete, as a concurrent writer or reader would. */
  beforeDelete?: (key: string) => SourceCacheDeleteResult | undefined
  failClaims = false

  add(r: SourceCacheObjectRow): string {
    this.rows.set(r.key, { ...r })
    return r.key
  }

  private claim(
    filter: (r: SourceCacheObjectRow) => boolean,
    input: { owner: string; now: number; leaseMs: number; limit: number }
  ) {
    if (this.failClaims) throw new Error('store down')
    const out: SourceCacheObjectRow[] = []
    for (const r of this.rows.values()) {
      if (out.length >= input.limit) break
      if (!filter(r) || (r.claimedAt !== null && r.claimedAt > input.now - input.leaseMs)) continue
      r.claimedBy = input.owner
      r.claimedAt = input.now
      out.push({ ...r })
    }
    return out
  }

  claimExpiredPendingSourceCache: SourceCacheSweepStore['claimExpiredPendingSourceCache'] = async (input) => {
    this.calls.push('claim-pending')
    this.claimInputs.push({ step: 'pending', ...input })
    return this.claim((r) => r.state === 'pending' && r.expiresAt !== null && r.expiresAt <= input.now, input)
  }

  claimUnreferencedSourceCacheBundles: SourceCacheSweepStore['claimUnreferencedSourceCacheBundles'] = async (input) => {
    this.calls.push('claim-unreferenced')
    this.claimInputs.push({ step: 'unreferenced', ...input })
    const pointed = new Set([...this.rows.values()].map((r) => r.targetKey))
    return this.claim(
      (r) =>
        r.kind === 'bundle' &&
        r.state === 'committed' &&
        r.unpointedAt !== null &&
        r.unpointedAt <= input.unpointedBefore &&
        !pointed.has(r.key),
      input
    )
  }

  claimUnreadSourceCachePointers: SourceCacheSweepStore['claimUnreadSourceCachePointers'] = async (input) => {
    this.calls.push('claim-pointers')
    this.claimInputs.push({ step: 'pointers', ...input })
    return this.claim(
      (r) =>
        r.kind === 'pointer' &&
        (r.lastReadAt ?? r.updatedAt) <= input.unreadBefore &&
        r.updatedAt <= input.unreadBefore,
      input
    )
  }

  deleteSourceCacheObject: SourceCacheSweepStore['deleteSourceCacheObject'] = async (input) => {
    this.calls.push(`delete-row:${input.key}`)
    this.deletes.push({ ...input })
    const forced = this.beforeDelete?.(input.key)
    if (forced) return forced
    const r = this.rows.get(input.key)
    if (!r) return { deleted: false, reason: 'missing' }
    if (input.claimedBy !== undefined && r.claimedBy !== input.claimedBy)
      return { deleted: false, reason: 'claim-lost' }
    const guard = input.unchanged
    if (
      guard &&
      (guard.targetKey !== r.targetKey || guard.updatedAt !== r.updatedAt || guard.lastReadAt !== r.lastReadAt)
    )
      return { deleted: false, reason: 'changed' }
    this.rows.delete(input.key)
    const released = r.kind === 'bundle' && r.state === 'committed' ? r.bytes : 0
    this.releasedBytes += released
    if (r.kind === 'pointer' && r.targetKey) {
      const target = this.rows.get(r.targetKey)
      if (target) target.unpointedAt = input.now
    }
    return { deleted: true, releasedBytes: released }
  }
}

interface ObjectScript {
  head?: (key: string) => Promise<{ exists: boolean }>
  delete?: (key: string) => Promise<void>
  putTagging?: (key: string, tag: string) => Promise<void>
  lifecycle?: () => Promise<SourceCacheBucketLifecycle>
}

function harness(script: ObjectScript = {}, extra: Partial<SourceCacheSweeperDeps> = {}) {
  const clock = new FakeClock(T0)
  const store = new FakeStore()
  const calls: string[] = []
  const logs: Array<[string, string]> = []
  const objects: SourceCacheSweeperDeps['objects'] = {
    head: async (key) => {
      calls.push(`head:${key}`)
      const scripted = await script.head?.(key)
      return scripted?.exists === false ? { exists: false } : { exists: true, contentLength: 1, checksumSha256: 'x' }
    },
    delete: async (key) => {
      calls.push(`delete:${key}`)
      await script.delete?.(key)
    },
    putTagging: async (key, tag) => {
      calls.push(`retag:${key}:${tag}`)
      await script.putTagging?.(key, tag)
    },
    getBucketLifecycle: async () => {
      calls.push('lifecycle')
      return (await script.lifecycle?.()) ?? { kind: 'none' }
    }
  }
  const sweeper = createSourceCacheSweeper({
    store: () => store,
    objects,
    config: { prefix: 'agentconnect', limits: { getUrlSeconds: GET_URL_SECONDS, unreadPointerDays: 30 } },
    clock,
    random: () => 0.5,
    log: {
      debug: (m) => logs.push(['debug', m]),
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m])
    },
    ...extra
  })
  return { clock, store, calls, logs, sweeper }
}

const expiredPending = (h: ReturnType<typeof harness>) =>
  h.store.add(row(newBundle(), { state: 'pending', expiresAt: T0 - 1 }))
const unpointed = (h: ReturnType<typeof harness>, at = T0 - CUTOFF_MS) =>
  h.store.add(row(newBundle(), { unpointedAt: at }))

const done = async (h: ReturnType<typeof harness>) => {
  const result = await h.sweeper.runPass(OWNER)
  if (result.kind !== 'done') throw new Error('expected a pass')
  return result
}

const s3Error = (status: number, code: string) => new SourceCacheObjectError(status, code, 'test')

describe('Source Cache sweep: expired reservations (§9)', () => {
  it('HEADs, deletes the object, then deletes the row under the claim fence', async () => {
    const h = harness()
    const key = expiredPending(h)
    h.store.add(row(newBundle(), { state: 'pending', expiresAt: T0 + 60_000 }))
    const result = await done(h)
    expect(h.calls).toEqual([`head:${key}`, `delete:${key}`])
    expect(h.store.deletes).toEqual([{ orgId: 'org_1', key, now: T0, claimedBy: OWNER }])
    expect(h.store.rows.has(key)).toBe(false)
    expect(h.store.rows.size).toBe(1)
    expect(result.pending).toMatchObject({ claimed: 1, objectDeleted: 1, deleted: 1, failed: 0 })
  })

  it('deletes the row without a DELETE when the object is already gone', async () => {
    const h = harness({ head: async () => ({ exists: false }) })
    const key = expiredPending(h)
    expect((await done(h)).pending).toMatchObject({ alreadyGone: 1, deleted: 1, objectDeleted: 0 })
    expect(h.calls).toEqual([`head:${key}`])
    expect(h.store.rows.has(key)).toBe(false)
  })

  it('leaves the row claimed on a HEAD or DELETE failure, and a pass after the lease finishes it', async () => {
    let failing = true
    const h = harness({
      head: async () => {
        if (failing) throw s3Error(503, 'SlowDown')
        return { exists: true }
      }
    })
    const key = expiredPending(h)
    expect((await done(h)).pending).toMatchObject({ claimed: 1, failed: 1, deleted: 0 })
    expect(h.store.rows.get(key)!.claimedBy).toBe(OWNER)
    expect(h.store.deletes).toEqual([])
    failing = false
    expect((await done(h)).pending.claimed).toBe(0)
    h.clock.advance(SWEEP_LEASE_MS)
    expect((await done(h)).pending).toMatchObject({ claimed: 1, deleted: 1 })
    expect(h.store.rows.has(key)).toBe(false)

    const d = harness({ delete: async () => Promise.reject(s3Error(500, 'InternalError')) })
    const other = expiredPending(d)
    expect((await done(d)).pending).toMatchObject({ failed: 1, deleted: 0 })
    expect(d.store.rows.has(other)).toBe(true)
  })
})

describe('Source Cache sweep: unreferenced bundles (§10)', () => {
  it('retags unreferenced before deleting the row, releasing its bytes, past the GET lifetime plus grace', async () => {
    const h = harness()
    const due = unpointed(h)
    const recent = unpointed(h, T0 - CUTOFF_MS + 1)
    const result = await done(h)
    expect(h.store.claimInputs.find((c) => c.step === 'unreferenced')).toMatchObject({
      unpointedBefore: T0 - CUTOFF_MS,
      owner: OWNER,
      leaseMs: SWEEP_LEASE_MS,
      limit: 25
    })
    expect(h.calls).toEqual([`retag:${due}:ac-cache=unreferenced`])
    expect(h.store.calls.indexOf(`delete-row:${due}`)).toBeGreaterThan(-1)
    expect(h.store.rows.has(due)).toBe(false)
    expect(h.store.rows.has(recent)).toBe(true)
    expect(h.store.releasedBytes).toBe(1000)
    expect(result.unreferenced).toMatchObject({ claimed: 1, retagged: 1, deleted: 1, releasedBytes: 1000 })
  })

  it('keeps the row and its bytes when the retag fails', async () => {
    const h = harness({ putTagging: async () => Promise.reject(s3Error(403, 'AccessDenied')) })
    const key = unpointed(h)
    expect((await done(h)).unreferenced).toMatchObject({ claimed: 1, failed: 1, deleted: 0 })
    expect(h.store.deletes).toEqual([])
    expect(h.store.rows.has(key)).toBe(true)
    expect(h.store.releasedBytes).toBe(0)
  })

  it('deletes the row when the retag finds the object gone, but not when the bucket is missing', async () => {
    const h = harness({ putTagging: async () => Promise.reject(s3Error(404, 'NoSuchKey')) })
    const key = unpointed(h)
    expect((await done(h)).unreferenced).toMatchObject({ alreadyGone: 1, deleted: 1 })
    expect(h.store.rows.has(key)).toBe(false)
    const b = harness({ putTagging: async () => Promise.reject(s3Error(404, 'NoSuchBucket')) })
    const kept = unpointed(b)
    expect((await done(b)).unreferenced).toMatchObject({ failed: 1, deleted: 0 })
    expect(b.store.rows.has(kept)).toBe(true)
  })

  it('restores the live tag when the store refuses the delete as referenced', async () => {
    const h = harness()
    const key = unpointed(h)
    h.store.beforeDelete = () => ({ deleted: false, reason: 'referenced' })
    expect((await done(h)).unreferenced).toMatchObject({ retagged: 1, referenced: 1, deleted: 0 })
    expect(h.calls).toEqual([`retag:${key}:ac-cache=unreferenced`, `retag:${key}:ac-cache=live`])
    expect(h.logs.some(([level, m]) => level === 'warn' && m.includes('referenced again'))).toBe(true)
  })
})

describe('Source Cache sweep: unread pointers (§10, CP1.6 note)', () => {
  it('deletes an unread pointer with the claim fence and an unchanged guard, which unpoints its target', async () => {
    const h = harness()
    const target = h.store.add(row(newBundle(), {}))
    const ptr = h.store.add(
      row(newPointer(), {
        kind: 'pointer',
        bytes: 0,
        targetKey: target,
        updatedAt: T0 - 40 * DAY,
        lastReadAt: T0 - 31 * DAY
      })
    )
    h.store.add(
      row(newPointer('refs/heads/dev'), { kind: 'pointer', bytes: 0, updatedAt: T0 - 40 * DAY, lastReadAt: T0 - DAY })
    )
    const result = await done(h)
    expect(h.store.claimInputs.find((c) => c.step === 'pointers')).toMatchObject({ unreadBefore: T0 - 30 * DAY })
    expect(h.store.deletes).toEqual([
      {
        orgId: 'org_1',
        key: ptr,
        now: T0,
        claimedBy: OWNER,
        unchanged: { targetKey: target, updatedAt: T0 - 40 * DAY, lastReadAt: T0 - 31 * DAY }
      }
    ])
    expect(result.pointers).toMatchObject({ claimed: 1, deleted: 1 })
    expect(h.store.rows.get(target)!.unpointedAt).toBe(T0)
    expect(h.calls).toEqual([])
  })

  it('skips a pointer read or retargeted after the claim', async () => {
    const h = harness()
    const ptr = h.store.add(row(newPointer(), { kind: 'pointer', bytes: 0, targetKey: newBundle() }))
    h.store.beforeDelete = (key) => {
      // A GET issued after the claim stamps lastReadAt but leaves the claim in place.
      h.store.rows.get(key)!.lastReadAt = T0
      return undefined
    }
    expect((await done(h)).pointers).toMatchObject({ claimed: 1, changed: 1, deleted: 0 })
    expect(h.store.rows.has(ptr)).toBe(true)
  })
})

describe('Source Cache sweep: fencing, limits and budgets', () => {
  it('treats a lost claim and a vanished row as no-ops at every step', async () => {
    const h = harness()
    expiredPending(h)
    unpointed(h)
    h.store.add(row(newPointer(), { kind: 'pointer', bytes: 0 }))
    let n = 0
    h.store.beforeDelete = () =>
      n++ % 2 === 0 ? { deleted: false, reason: 'claim-lost' } : { deleted: false, reason: 'missing' }
    const result = await done(h)
    expect([result.pending.lost, result.unreferenced.lost, result.pointers.lost]).toEqual([1, 1, 1])
    expect(result.unreferenced.deleted).toBe(0)
  })

  it('claims at most the batch size per step, so a backlog drains over passes', async () => {
    const h = harness({}, { batchSize: 2 })
    for (let i = 0; i < 5; i++) expiredPending(h)
    expect((await done(h)).pending.deleted).toBe(2)
    expect((await done(h)).pending.deleted).toBe(2)
    expect((await done(h)).pending.deleted).toBe(1)
    expect(h.store.claimInputs.every((c) => c.limit === 2)).toBe(true)
  })

  it('stops object steps after consecutive object-store failures but still sweeps pointers', async () => {
    const h = harness({ head: async () => Promise.reject(s3Error(503, 'SlowDown')) })
    for (let i = 0; i < 5; i++) expiredPending(h)
    unpointed(h)
    h.store.add(row(newPointer(), { kind: 'pointer', bytes: 0 }))
    const result = await done(h)
    expect(result.pending).toMatchObject({ claimed: 5, failed: 3 })
    expect(h.calls.filter((c) => c.startsWith('head:'))).toHaveLength(3)
    expect(h.store.calls).not.toContain('claim-unreferenced')
    expect(result.pointers.deleted).toBe(1)
  })

  it('starts no row past half the lease', async () => {
    const h = harness()
    const first = expiredPending(h)
    const second = expiredPending(h)
    let advanced = false
    h.store.beforeDelete = () => {
      if (!advanced) h.clock.advance(SWEEP_LEASE_MS / 2)
      advanced = true
      return undefined
    }
    await done(h)
    expect(h.store.rows.has(first)).toBe(false)
    expect(h.store.rows.has(second)).toBe(true)
    expect(h.store.calls).not.toContain('claim-pointers')
  })

  it('is a no-op pass without a store, and a failing claim never throws', async () => {
    const none = harness({}, { store: () => undefined })
    expect(await none.sweeper.runPass(OWNER)).toMatchObject({ kind: 'done', pending: { claimed: 0 } })
    const h = harness()
    h.store.failClaims = true
    const result = await done(h)
    expect([result.pending.failed, result.unreferenced.failed, result.pointers.failed]).toEqual([1, 1, 1])
  })

  it('runs one pass at a time per member', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = harness({ head: async () => (await gate, { exists: false }) })
    expiredPending(h)
    const first = h.sweeper.runPass(OWNER)
    await Promise.resolve()
    const callsBefore = h.store.calls.length
    expect(await h.sweeper.runPass(OWNER)).toEqual({ kind: 'busy' })
    expect(h.store.calls.length).toBe(callsBefore)
    release()
    expect(await first).toMatchObject({ kind: 'done', pending: { deleted: 1 } })
  })

  it('hands each completed pass to onPass, whose failure never fails the pass', async () => {
    const passes: unknown[] = []
    const h = harness(
      {},
      {
        onPass: (p) => {
          passes.push(p)
          throw new Error('metrics down')
        }
      }
    )
    expiredPending(h)
    expect(await h.sweeper.runPass(OWNER)).toMatchObject({ kind: 'done' })
    expect(passes).toHaveLength(1)
  })
})

describe('Source Cache sweep loop', () => {
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  it('first ticks within one interval, re-arms with jitter, skips paused ticks, and stops for good', async () => {
    let paused = false
    const h = harness({}, { intervalMs: 1000, lifecycleCheckMs: 10 * DAY, paused: () => paused })
    h.sweeper.start(OWNER)
    await flush()
    h.clock.advance(499)
    await flush()
    expect(h.store.calls).toEqual([])
    h.clock.advance(1)
    await flush()
    expect(h.store.calls.filter((c) => c === 'claim-pending')).toHaveLength(1)
    // random() 0.5 puts the next tick at exactly one interval.
    paused = true
    h.clock.advance(1000)
    await flush()
    expect(h.store.calls.filter((c) => c === 'claim-pending')).toHaveLength(1)
    paused = false
    h.clock.advance(1000)
    await flush()
    expect(h.store.calls.filter((c) => c === 'claim-pending')).toHaveLength(2)
    await h.sweeper.stop()
    h.clock.advance(10_000)
    await flush()
    expect(h.store.calls.filter((c) => c === 'claim-pending')).toHaveLength(2)
    expect(h.clock.pending).toBe(0)
  })

  it('stop() lets the pass in flight finish its row, then starts no other', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = harness({ head: async () => (await gate, { exists: false }) }, { intervalMs: 1000 })
    const first = expiredPending(h)
    const second = expiredPending(h)
    h.sweeper.start(OWNER)
    h.clock.advance(500)
    await flush()
    const stopping = h.sweeper.stop()
    release()
    await stopping
    expect(h.store.rows.has(first)).toBe(false)
    expect(h.store.rows.has(second)).toBe(true)
    expect(h.store.calls).not.toContain('claim-unreferenced')
  })
})

describe('Source Cache sweep: lifecycle check (§10, §14)', () => {
  const both =
    '<LifecycleConfiguration><Rule><ID>p</ID><Filter><And><Prefix>agentconnect/src/</Prefix><Tag><Key>ac-cache</Key><Value>pending</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>2</Days></Expiration></Rule><Rule><ID>u</ID><Filter><And><Prefix>agentconnect/src/</Prefix><Tag><Key>ac-cache</Key><Value>unreferenced</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>7</Days></Expiration></Rule></LifecycleConfiguration>'

  it('is missing without a configuration and warns with the rules to apply', async () => {
    const h = harness()
    expect(h.sweeper.lifecycle()).toBe('unknown')
    expect(await h.sweeper.checkLifecycle()).toBe('missing')
    expect(h.sweeper.lifecycle()).toBe('missing')
    const warning = h.logs.find(([level, m]) => level === 'warn' && m.includes('write-back is disabled'))
    expect(warning?.[1]).toContain('"Prefix":"agentconnect/src/"')
    expect(warning?.[1]).toContain('ac-cache=pending and ac-cache=unreferenced')
  })

  it('is missing when only one rule exists, present when both do', async () => {
    const only = harness({
      lifecycle: async () => ({ kind: 'rules', xml: both.replace(/<Rule><ID>u<\/ID>[\s\S]*?<\/Rule>/, '') })
    })
    expect(await only.sweeper.checkLifecycle()).toBe('missing')
    expect(only.logs.some(([, m]) => m.includes('expiring ac-cache=unreferenced under'))).toBe(true)
    const full = harness({ lifecycle: async () => ({ kind: 'rules', xml: both }) })
    expect(await full.sweeper.checkLifecycle()).toBe('present')
  })

  it('is unknown when the configuration cannot be read, naming the permission', async () => {
    const h = harness({ lifecycle: async () => Promise.reject(s3Error(403, 'AccessDenied')) })
    expect(await h.sweeper.checkLifecycle()).toBe('unknown')
    expect(h.logs.some(([level, m]) => level === 'warn' && m.includes('s3:GetLifecycleConfiguration'))).toBe(true)
  })

  it('checks at start and again every lifecycleCheckMs, so adding the rules re-enables write-back', async () => {
    const bucket: { xml?: string } = {}
    const h = harness(
      { lifecycle: async () => (bucket.xml ? { kind: 'rules', xml: bucket.xml } : { kind: 'none' }) },
      { intervalMs: DAY, lifecycleCheckMs: 1000 }
    )
    h.sweeper.start(OWNER)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.sweeper.lifecycle()).toBe('missing')
    bucket.xml = both
    h.clock.advance(1000)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(h.sweeper.lifecycle()).toBe('present')
    expect(h.calls.filter((c) => c === 'lifecycle')).toHaveLength(2)
    await h.sweeper.stop()
  })
})
