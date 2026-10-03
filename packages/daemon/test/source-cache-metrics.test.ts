import type { Attributes, ObservableCallback, ObservableResult } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import { createSourceCacheMetrics } from '../src/source-cache/metrics.js'
import type { SourceCacheMissReason, SourceCacheReadOutcome } from '../src/source-cache/read-plan.js'
import type { SourceCacheSweepCounts } from '../src/source-cache/sweep.js'
import type { SourceCacheWriteOutcome, SourceCacheWriteSkipReason } from '../src/source-cache/write-back.js'
import type { BundleFallbackReason } from '../src/workspace/bundled-clone.js'

// Source Cache metrics (source-cache.md §12) over a fake meter: each hook path's instrument calls, and no high-cardinality label.

const ORG = 'org-zz9-plural-z-alpha'
const REPO = 'repo-4f3c2b1a0e9d8c7b'
const KEY = `src/${ORG}/anon/${REPO}/bundles/0b5c3f8e.bundle`
const URL_SECRET = 'https://cache.example/x?X-Amz-Signature=TOPSECRET'

interface Sample {
  name: string
  value: number
  attributes: Attributes
}

function fakeMeter() {
  const samples: Sample[] = []
  const callbacks = new Map<string, ObservableCallback>()
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number, attributes: Attributes = {}) => samples.push({ name, value, attributes })
    }),
    createObservableGauge: (name: string) => ({
      addCallback: (cb: ObservableCallback) => callbacks.set(name, cb),
      removeCallback: () => {}
    })
  }
  const observe = (name: string): Array<{ value: number; attributes: Attributes }> => {
    const seen: Array<{ value: number; attributes: Attributes }> = []
    const result: ObservableResult = { observe: (value, attributes = {}) => seen.push({ value, attributes }) }
    void callbacks.get(name)?.(result)
    return seen
  }
  const metrics = createSourceCacheMetrics(meter as never)
  const of = (name: string) => samples.filter((s) => s.name === `agentconnect.source_cache.${name}`)
  return { metrics, samples, of, observe }
}

const MISS_REASONS: SourceCacheMissReason[] = [
  'no-org',
  'unsupported-credential',
  'unauthorized',
  'no-pointer',
  'unusable-pointer',
  'unusable-bundle',
  'not-https',
  'error'
]
const FALLBACK_REASONS: BundleFallbackReason[] = [
  'clone-failed',
  'stderr-unavailable',
  'download-warning',
  'no-bundle-refs',
  'inspect-failed',
  'connectivity',
  'cleanup-failed'
]
const SKIP_REASONS: SourceCacheWriteSkipReason[] = [
  'lifecycle-missing',
  'class-mismatch',
  'unsupported-shim',
  'branch-diverged',
  'unresolved',
  ...FALLBACK_REASONS.map((r) => `fallback-${r}` as const),
  'fallback-unknown',
  'no-tip',
  'unmeasured',
  'fresh',
  'in-flight',
  'busy',
  'store-unavailable',
  'pointer-moved',
  'over-cap',
  'reservation-too-large',
  'reservation-over-quota',
  'reservation-duplicate'
]

const counts = (extra: Partial<SourceCacheSweepCounts> = {}): SourceCacheSweepCounts => ({
  claimed: 0,
  deleted: 0,
  objectDeleted: 0,
  alreadyGone: 0,
  retagged: 0,
  failed: 0,
  lost: 0,
  changed: 0,
  referenced: 0,
  releasedBytes: 0,
  ...extra
})

describe('Source Cache read metrics', () => {
  it('counts a hit with its class and the bundle row bytes', () => {
    const m = fakeMeter()
    m.metrics.read({ kind: 'hit', bundleKey: KEY, shape: 'blobless', repoClass: 'cred', bytes: 2048 })
    expect(m.of('reads')).toEqual([
      {
        name: 'agentconnect.source_cache.reads',
        value: 1,
        attributes: { outcome: 'hit', reason: 'none', shape: 'blobless', class: 'cred' }
      }
    ])
    expect(m.of('read_bytes')).toEqual([
      { name: 'agentconnect.source_cache.read_bytes', value: 2048, attributes: { shape: 'blobless', class: 'cred' } }
    ])
  })

  it.each(MISS_REASONS)('counts a %s miss, with its class or as unknown, and no bytes', (reason) => {
    const m = fakeMeter()
    m.metrics.read({ kind: 'miss', reason, shape: 'full', repoClass: 'anon', detail: KEY })
    m.metrics.read({ kind: 'miss', reason, shape: 'full', detail: ORG })
    expect(m.of('reads').map((s) => s.attributes)).toEqual([
      { outcome: 'miss', reason, shape: 'full', class: 'anon' },
      { outcome: 'miss', reason, shape: 'full', class: 'unknown' }
    ])
    expect(m.of('read_bytes')).toEqual([])
  })

  it.each(FALLBACK_REASONS)('counts a %s fallback and no bytes', (reason) => {
    const m = fakeMeter()
    m.metrics.read({ kind: 'fallback', bundleKey: KEY, shape: 'full', repoClass: 'anon', reason, detail: URL_SECRET })
    expect(m.of('reads').map((s) => s.attributes)).toEqual([
      { outcome: 'fallback', reason, shape: 'full', class: 'anon' }
    ])
    expect(m.of('read_bytes')).toEqual([])
  })

  it('labels a reason outside the closed set as other', () => {
    const m = fakeMeter()
    m.metrics.read({ kind: 'miss', reason: `no-pointer: ${KEY}`, shape: 'full' } as unknown as SourceCacheReadOutcome)
    m.metrics.read({ kind: 'hit', bundleKey: KEY, shape: REPO, repoClass: ORG, bytes: 1 } as never)
    expect(m.of('reads').map((s) => s.attributes)).toEqual([
      { outcome: 'miss', reason: 'other', shape: 'full', class: 'unknown' },
      { outcome: 'hit', reason: 'none', shape: 'other', class: 'other' }
    ])
  })
})

describe('Source Cache write-back metrics', () => {
  const scope = { shape: 'blobless', repoClass: 'anon' } as const

  it('counts a written bundle with its trigger and bytes', () => {
    const m = fakeMeter()
    m.metrics.writeBack({ kind: 'written', trigger: 'delta', bundleKey: KEY, bytes: 4096 }, scope)
    expect(m.of('write_backs').map((s) => s.attributes)).toEqual([
      { outcome: 'written', reason: 'delta', shape: 'blobless', class: 'anon' }
    ])
    expect(m.of('write_bytes')).toEqual([
      {
        name: 'agentconnect.source_cache.write_bytes',
        value: 4096,
        attributes: { trigger: 'delta', shape: 'blobless', class: 'anon' }
      }
    ])
  })

  it.each(SKIP_REASONS)('counts a %s skip, never its detail', (reason) => {
    const m = fakeMeter()
    m.metrics.writeBack({ kind: 'skipped', reason, detail: `${ORG} ${URL_SECRET}` }, scope)
    expect(m.of('write_backs').map((s) => s.attributes)).toEqual([
      { outcome: 'skipped', reason, shape: 'blobless', class: 'anon' }
    ])
    expect(m.of('write_bytes')).toEqual([])
  })

  it('counts a failure by stage and a lost race with no reason', () => {
    const m = fakeMeter()
    m.metrics.writeBack({ kind: 'failed', stage: 'upload', detail: URL_SECRET, bundleKey: KEY }, scope)
    m.metrics.writeBack({ kind: 'lost-race', bundleKey: KEY }, { shape: 'full', repoClass: 'cred' })
    expect(m.of('write_backs').map((s) => s.attributes)).toEqual([
      { outcome: 'failed', reason: 'upload', shape: 'blobless', class: 'anon' },
      { outcome: 'lost_race', reason: 'none', shape: 'full', class: 'cred' }
    ])
    expect(m.of('write_bytes')).toEqual([])
  })

  it('labels a skip reason outside the closed set as other', () => {
    const m = fakeMeter()
    m.metrics.writeBack({ kind: 'skipped', reason: `unmeasured: ${KEY}` } as unknown as SourceCacheWriteOutcome, scope)
    expect(m.of('write_backs')[0]!.attributes).toMatchObject({ reason: 'other' })
  })
})

describe('Source Cache sweep metrics', () => {
  it('counts the pass, each non-zero row result per step, and released bytes', () => {
    const m = fakeMeter()
    m.metrics.sweepPass({
      kind: 'done',
      pending: counts({ claimed: 2, objectDeleted: 1, alreadyGone: 1, deleted: 2 }),
      unreferenced: counts({ claimed: 1, retagged: 1, deleted: 1, releasedBytes: 500 }),
      pointers: counts({ claimed: 3, deleted: 1, changed: 1, failed: 1, lost: 0, referenced: 0 })
    })
    expect(m.of('sweep.passes').map((s) => s.value)).toEqual([1])
    expect(m.of('sweep.rows').map((s) => [s.attributes['step'], s.attributes['result'], s.value])).toEqual([
      ['pending', 'claimed', 2],
      ['pending', 'deleted', 2],
      ['pending', 'object_deleted', 1],
      ['pending', 'already_gone', 1],
      ['unreferenced', 'claimed', 1],
      ['unreferenced', 'deleted', 1],
      ['unreferenced', 'retagged', 1],
      ['pointers', 'claimed', 3],
      ['pointers', 'deleted', 1],
      ['pointers', 'failed', 1],
      ['pointers', 'changed', 1]
    ])
    expect(m.of('sweep.released_bytes')).toEqual([
      { name: 'agentconnect.source_cache.sweep.released_bytes', value: 500, attributes: { step: 'unreferenced' } }
    ])
  })

  it('counts an empty pass and no rows', () => {
    const m = fakeMeter()
    m.metrics.sweepPass({ kind: 'done', pending: counts(), unreferenced: counts(), pointers: counts() })
    expect(m.of('sweep.passes')).toHaveLength(1)
    expect(m.of('sweep.rows')).toEqual([])
    expect(m.of('sweep.released_bytes')).toEqual([])
  })
})

describe('Source Cache lifecycle metrics', () => {
  it('observes nothing before the first check, then a state set that follows the status', () => {
    const m = fakeMeter()
    expect(m.observe('agentconnect.source_cache.lifecycle.status')).toEqual([])
    m.metrics.lifecycle('missing')
    expect(m.observe('agentconnect.source_cache.lifecycle.status')).toEqual([
      { value: 0, attributes: { status: 'present' } },
      { value: 1, attributes: { status: 'missing' } },
      { value: 0, attributes: { status: 'unknown' } }
    ])
    m.metrics.lifecycle('present')
    expect(m.observe('agentconnect.source_cache.lifecycle.status').filter((o) => o.value === 1)).toEqual([
      { value: 1, attributes: { status: 'present' } }
    ])
    expect(m.of('lifecycle.checks').map((s) => s.attributes)).toEqual([{ status: 'missing' }, { status: 'present' }])
  })
})

describe('Source Cache metric cardinality', () => {
  it('emits only closed label keys and values, never an org, key, URL or repository', () => {
    const m = fakeMeter()
    m.metrics.read({ kind: 'hit', bundleKey: KEY, shape: 'full', repoClass: 'anon', bytes: 10 })
    for (const reason of MISS_REASONS)
      m.metrics.read({ kind: 'miss', reason, shape: 'blobless', detail: `${ORG} ${KEY}` })
    for (const reason of FALLBACK_REASONS)
      m.metrics.read({ kind: 'fallback', bundleKey: KEY, shape: 'full', repoClass: 'cred', reason, detail: URL_SECRET })
    const scope = { shape: 'full', repoClass: 'cred' } as const
    m.metrics.writeBack({ kind: 'written', trigger: 'miss', bundleKey: KEY, bytes: 1 }, scope)
    for (const reason of SKIP_REASONS) m.metrics.writeBack({ kind: 'skipped', reason, detail: REPO }, scope)
    m.metrics.writeBack({ kind: 'failed', stage: 'verify', detail: URL_SECRET, bundleKey: KEY }, scope)
    m.metrics.writeBack({ kind: 'lost-race', bundleKey: KEY }, scope)
    m.metrics.read({ kind: 'miss', reason: KEY, shape: ORG, repoClass: REPO } as never)
    m.metrics.writeBack({ kind: 'skipped', reason: URL_SECRET } as never, { shape: ORG, repoClass: REPO } as never)
    m.metrics.sweepPass({
      kind: 'done',
      pending: counts({ claimed: 1 }),
      unreferenced: counts({ retagged: 1, releasedBytes: 1 }),
      pointers: counts({ referenced: 1 })
    })
    m.metrics.lifecycle('unknown')
    const observed = m.observe('agentconnect.source_cache.lifecycle.status')

    const allowedKeys = new Set(['outcome', 'reason', 'shape', 'class', 'trigger', 'step', 'result', 'status'])
    const attributeSets = [...m.samples.map((s) => s.attributes), ...observed.map((o) => o.attributes)]
    expect(attributeSets.length).toBeGreaterThan(40)
    for (const attributes of attributeSets) {
      for (const [key, value] of Object.entries(attributes)) {
        expect(allowedKeys.has(key)).toBe(true)
        expect(String(value)).toMatch(/^[a-z_-]+$/)
        for (const id of [ORG, REPO, KEY, URL_SECRET, 'TOPSECRET']) expect(String(value)).not.toContain(id)
      }
    }
  })
})
