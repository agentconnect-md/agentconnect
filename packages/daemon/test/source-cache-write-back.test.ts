import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ShimBundleClient } from '../src/shim/bundle-client.js'
import type { ShimRequestOptions } from '../src/shim/channels.js'
import { anonRepoId, credRepoId, pointerKey, type SourceCacheShape } from '../src/source-cache/keys.js'
import type { SourceCacheWriteTarget } from '../src/source-cache/read-plan.js'
import {
  createSourceCacheWriter,
  type SourceCacheBundleStager,
  type SourceCacheWriteRequest,
  type SourceCacheWriterDeps
} from '../src/source-cache/write-back.js'
import type { SourceCacheReserveResult } from '../src/store/local-store.js'
import type { GitRunner } from '../src/workspace/git-runner.js'

// Write-back orchestration (source-cache.md §9) over fakes: every refusal, the commit order, and that nothing ever throws.

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60_000
const COMMIT = 'c'.repeat(40)
const TIP = 'a'.repeat(40)
const BYTES = 4096
const SHA = createHash('sha256').update('bundle').digest('base64')
const SECRET_URL = 'https://cache.example/src/x.bundle?X-Amz-Signature=TOPSECRET'
const OLD_TARGET = 'src/org_1/anon/old/bundles/x.bundle'

function target(repoClass: 'anon' | 'cred' = 'anon', shape: SourceCacheShape = 'blobless'): SourceCacheWriteTarget {
  const repoId = repoClass === 'anon' ? anonRepoId('https://github.com/acme/widgets') : credRepoId('github', '42')
  const ref = 'refs/heads/main'
  return {
    orgId: 'org_1',
    repoClass,
    repoId,
    ref,
    shape,
    pointerKey: pointerKey({ org: 'org_1', class: repoClass, repo: repoId, ref, shape }),
    observedTargetKey: null
  }
}

interface Options {
  pointerTarget?: string | null
  local?: string
  origin?: string
  deltaObjects?: string
  deltaBytes?: string
  revListError?: boolean
  createError?: Error
  createBytes?: number
  reserve?: SourceCacheReserveResult
  presignError?: Error
  uploadError?: Error
  head?: Awaited<ReturnType<SourceCacheWriterDeps['objects']['head']>> | Error
  commit?: { committed: false; reason: 'missing' | 'expired' | 'claimed' | 'size-exceeds-reservation' }
  retagError?: Error
  pointer?: { set: false; reason: 'pointer-moved' | 'bundle-claimed' }
  noStore?: boolean
  storeThrows?: boolean
  discardError?: Error
  allowWrites?: () => boolean
}

function harness(opts: Options = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const outcomes: unknown[] = []
  const reserved: Array<{ key: string; bytes: number; expiresAt: number }> = []
  const pointed: Array<{ bundleKey: string; expectedTargetKey?: string | null }> = []
  const discarded: string[] = []
  const discardAborts: Array<AbortSignal | undefined> = []
  const store = {
    getSourceCacheObject: async () => {
      calls.push('read-pointer')
      if (opts.storeThrows) throw new Error('store down')
      const t = opts.pointerTarget === undefined ? null : opts.pointerTarget
      return t === null ? undefined : ({ targetKey: t } as never)
    },
    reserveBundle: async (input: { key: string; bytes: number; expiresAt: number }) => {
      calls.push('reserve')
      reserved.push({ key: input.key, bytes: input.bytes, expiresAt: input.expiresAt })
      return opts.reserve ?? { admitted: true as const, committedBytes: 0, pendingBytes: input.bytes }
    },
    commitBundle: async () => {
      calls.push('commit')
      return opts.commit ?? { committed: true as const, alreadyCommitted: false, bytes: BYTES }
    },
    setSourceCachePointer: async (input: { bundleKey: string; expectedTargetKey?: string | null }) => {
      calls.push('pointer')
      pointed.push({ bundleKey: input.bundleKey, expectedTargetKey: input.expectedTargetKey })
      return opts.pointer ?? { set: true as const, previousBundleKey: undefined }
    }
  }
  const deps: SourceCacheWriterDeps = {
    store: () => (opts.noStore ? undefined : (store as never)),
    presigner: {
      presignPut: async (_key, input) => {
        calls.push('presign')
        if (opts.presignError) throw opts.presignError
        return {
          method: 'PUT',
          url: SECRET_URL,
          headers: {
            'content-length': String(input.contentLength),
            'x-amz-checksum-sha256': input.checksumSha256,
            'x-amz-tagging': 'ac-cache=pending'
          },
          expiresAt: NOW + 900_000
        }
      }
    },
    objects: {
      head: async () => {
        calls.push('head')
        if (opts.head instanceof Error) throw opts.head
        return opts.head ?? { exists: true, contentLength: BYTES, checksumSha256: SHA }
      },
      putTagging: async (_key, tag) => {
        calls.push(`retag:${tag}`)
        if (opts.retagError) throw opts.retagError
      }
    },
    limits: { maxBundleBytes: 1024 * 1024, orgQuotaBytes: 10 * 1024 * 1024, pendingReservationSeconds: 3600 },
    now: () => NOW,
    log: { debug: (m) => logs.push(m), info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    onOutcome: (o) => outcomes.push(o),
    ...(opts.allowWrites ? { allowWrites: opts.allowWrites } : {})
  }
  const stager: SourceCacheBundleStager = {
    create: async (input) => {
      calls.push(`create:${input.commit}:${input.shape}`)
      if (opts.createError) throw opts.createError
      return { handle: 'h-1', bytes: opts.createBytes ?? BYTES, sha256: SHA }
    },
    upload: async (input) => {
      calls.push('upload')
      expect(input.url).toBe(SECRET_URL)
      if (opts.uploadError) throw opts.uploadError
      return { bytes: BYTES, sha256: SHA }
    },
    discard: async (handle, abort) => {
      discarded.push(handle)
      discardAborts.push(abort)
      if (opts.discardError) throw opts.discardError
    }
  }
  const git = {
    raw: async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return args[2]!.startsWith('refs/remotes/') ? (opts.origin ?? COMMIT) : (opts.local ?? COMMIT)
      }
      if (args[0] === 'rev-list') {
        calls.push(`rev-list:${args.join(' ')}`)
        if (opts.revListError) throw new Error('rev-list failed')
        return args.includes('--count') ? (opts.deltaObjects ?? '10') : (opts.deltaBytes ?? '1000')
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
  } as unknown as GitRunner
  const writer = createSourceCacheWriter(deps)
  const request = (extra: Partial<SourceCacheWriteRequest> = {}): SourceCacheWriteRequest => ({
    target: target(),
    read: { kind: 'uncached' },
    checkout: '/agent/sessions/s1/workspace',
    git,
    stager,
    credentialed: false,
    ...extra
  })
  return { writer, request, calls, logs, outcomes, reserved, pointed, discarded, discardAborts, stager }
}

describe('Source Cache write-back triggers (§7 item 4)', () => {
  it.each([
    ['a miss', { kind: 'uncached' as const }, 'miss'],
    ['a fallback on a broken bundle', { kind: 'fallback' as const, reason: 'connectivity' as const }, 'fallback'],
    ['a hit on an old bundle', { kind: 'hit' as const, tip: TIP, bundleCreatedAt: NOW - 8 * DAY }, 'stale']
  ])('writes back after %s', async (_label, read, trigger) => {
    const h = harness()
    expect(await h.writer.consider(h.request({ read }))).toMatchObject({ kind: 'written', trigger, bytes: BYTES })
  })

  it.each(['clone-failed', 'no-bundle-refs', 'inspect-failed', 'connectivity', 'cleanup-failed'] as const)(
    'treats a %s fallback as a bad bundle to replace',
    async (reason) => {
      const h = harness()
      const outcome = await h.writer.consider(h.request({ read: { kind: 'fallback', reason } }))
      expect(outcome).toMatchObject({ kind: 'written', trigger: 'fallback' })
    }
  )

  it.each(['download-warning', 'stderr-unavailable', undefined] as const)(
    'skips a %s fallback, which may be transient, without staging a bundle',
    async (reason) => {
      const h = harness()
      const read = { kind: 'fallback' as const, ...(reason ? { reason } : {}) }
      expect(await h.writer.consider(h.request({ read }))).toEqual({
        kind: 'skipped',
        reason: `fallback-${reason ?? 'unknown'}`
      })
      expect(h.calls.filter((c) => c.startsWith('create') || c === 'pointer')).toEqual([])
    }
  )

  it.each([
    ['objects', { deltaObjects: '5001' }],
    ['bytes', { deltaBytes: String(50 * 1024 * 1024 + 1) }]
  ])('writes back after a hit whose origin delta is over the %s threshold', async (_label, opts) => {
    const h = harness(opts)
    const outcome = await h.writer.consider(h.request({ read: { kind: 'hit', tip: TIP, bundleCreatedAt: NOW - DAY } }))
    expect(outcome).toMatchObject({ kind: 'written', trigger: 'delta' })
    // Blobs are filtered for a blobless clone, so the checkout's lazy blob fetch is never counted.
    expect(h.calls.filter((c) => c.startsWith('rev-list'))).toEqual([
      `rev-list:rev-list --objects --missing=allow-any --filter=blob:none --count ${TIP}..${COMMIT}`,
      `rev-list:rev-list --objects --missing=allow-any --filter=blob:none --disk-usage ${TIP}..${COMMIT}`
    ])
  })

  it('measures a full clone without the blob filter', async () => {
    const h = harness({ deltaObjects: '9999' })
    await h.writer.consider(h.request({ target: target('anon', 'full'), read: { kind: 'hit', tip: TIP } }))
    expect(h.calls.find((c) => c.startsWith('rev-list'))).not.toContain('--filter')
  })

  it('skips a fresh hit, an unmeasurable one, and one with no tip', async () => {
    const fresh = harness()
    expect(await fresh.writer.consider(fresh.request({ read: { kind: 'hit', tip: TIP } }))).toEqual({
      kind: 'skipped',
      reason: 'fresh'
    })
    expect(fresh.calls.some((c) => c.startsWith('create'))).toBe(false)
    const broken = harness({ revListError: true })
    expect(await broken.writer.consider(broken.request({ read: { kind: 'hit', tip: TIP } }))).toMatchObject({
      kind: 'skipped',
      reason: expect.stringMatching(/^unmeasured/)
    })
    const tipless = harness()
    expect(await tipless.writer.consider(tipless.request({ read: { kind: 'hit' } }))).toEqual({
      kind: 'skipped',
      reason: 'no-tip'
    })
  })
})

describe('Source Cache write-back refusals', () => {
  it('skips without touching git, the store or the bucket while the lifecycle rules are missing (§14 fallback)', async () => {
    let allowed = false
    const h = harness({ allowWrites: () => allowed })
    expect(await h.writer.consider(h.request())).toEqual({ kind: 'skipped', reason: 'lifecycle-missing' })
    expect(h.calls).toEqual([])
    expect(h.reserved).toEqual([])
    allowed = true
    expect(await h.writer.consider(h.request())).toMatchObject({ kind: 'written', trigger: 'miss' })
  })

  it('skips a shim without the bundle capability', async () => {
    const h = harness()
    expect(await h.writer.consider(h.request({ stager: undefined }))).toEqual({
      kind: 'skipped',
      reason: 'unsupported-shim'
    })
  })

  it('skips when the class the daemon instructed does not match the target', async () => {
    const anonCredentialed = harness()
    expect(await anonCredentialed.writer.consider(anonCredentialed.request({ credentialed: true }))).toEqual({
      kind: 'skipped',
      reason: 'class-mismatch'
    })
    const credAnonymous = harness()
    expect(await credAnonymous.writer.consider(credAnonymous.request({ target: target('cred') }))).toEqual({
      kind: 'skipped',
      reason: 'class-mismatch'
    })
    const cred = harness()
    expect(await cred.writer.consider(cred.request({ target: target('cred'), credentialed: true }))).toMatchObject({
      kind: 'written'
    })
  })

  it('skips when the local branch is not the origin commit, so agent commits are never cached', async () => {
    const h = harness({ local: 'd'.repeat(40) })
    expect(await h.writer.consider(h.request())).toEqual({ kind: 'skipped', reason: 'branch-diverged' })
    expect(h.calls).toEqual([])
  })

  it('skips without creating anything when the pointer moved since planning', async () => {
    const h = harness({ pointerTarget: OLD_TARGET })
    expect(await h.writer.consider(h.request())).toEqual({ kind: 'skipped', reason: 'pointer-moved' })
    expect(h.calls).toEqual(['read-pointer'])
  })

  it('fails at create without reserving', async () => {
    const h = harness({ createError: new Error('bundle moved: refs/heads/main no longer names the origin commit') })
    expect(await h.writer.consider(h.request())).toMatchObject({ kind: 'failed', stage: 'create' })
    expect(h.calls).not.toContain('reserve')
    expect(h.discarded).toEqual([])
  })

  it('skips an over-cap bundle without reserving and discards it', async () => {
    const h = harness({ createBytes: 2 * 1024 * 1024 })
    expect(await h.writer.consider(h.request())).toEqual({ kind: 'skipped', reason: 'over-cap' })
    expect(h.calls).not.toContain('reserve')
    expect(h.discarded).toEqual(['h-1'])
  })

  it.each([
    [{ admitted: false as const, reason: 'too-large' as const }],
    [{ admitted: false as const, reason: 'over-quota' as const, committedBytes: 1, pendingBytes: 1 }],
    [{ admitted: false as const, reason: 'duplicate' as const, committedBytes: 1, pendingBytes: 1 }]
  ])('signs nothing when the reservation is refused (%j)', async (reserve) => {
    const h = harness({ reserve })
    expect(await h.writer.consider(h.request())).toEqual({ kind: 'skipped', reason: `reservation-${reserve.reason}` })
    expect(h.calls).not.toContain('presign')
    expect(h.discarded).toEqual(['h-1'])
  })

  it('reserves under the right class and key before signing, with the pending lifetime', async () => {
    const h = harness()
    await h.writer.consider(h.request({ target: target('cred'), credentialed: true }))
    expect(h.reserved).toEqual([
      {
        key: expect.stringMatching(/^src\/org_1\/cred\/github:42\/bundles\/[0-9a-f-]{36}\.bundle$/),
        bytes: BYTES,
        expiresAt: NOW + 3_600_000
      }
    ])
    expect(h.calls.indexOf('reserve')).toBeLessThan(h.calls.indexOf('presign'))
  })

  it('leaves the pending row for the sweep when signing or the upload fails', async () => {
    const presign = harness({ presignError: new Error('no credentials') })
    expect(await presign.writer.consider(presign.request())).toMatchObject({ kind: 'failed', stage: 'presign' })
    expect(presign.calls).not.toContain('upload')
    const upload = harness({ uploadError: new Error('bundle upload-refused: HTTP 403') })
    expect(await upload.writer.consider(upload.request())).toMatchObject({ kind: 'failed', stage: 'upload' })
    expect(upload.calls).not.toContain('head')
    expect(upload.calls).not.toContain('commit')
    expect(upload.discarded).toEqual(['h-1'])
  })

  it.each([
    ['absent', { exists: false as const }],
    ['the wrong length', { exists: true as const, contentLength: BYTES + 1, checksumSha256: SHA }],
    ['the wrong checksum', { exists: true as const, contentLength: BYTES, checksumSha256: 'x' }],
    ['no checksum', { exists: true as const, contentLength: BYTES }],
    ['a failed HEAD', new Error('HTTP 500')]
  ])('commits nothing when the object is %s', async (_label, head) => {
    const h = harness({ head })
    expect(await h.writer.consider(h.request())).toMatchObject({ kind: 'failed', stage: 'verify' })
    expect(h.calls).not.toContain('commit')
  })
})

describe('Source Cache write-back ordering', () => {
  it('commits after a passing HEAD, retags live after commit, then compares-and-sets the pointer', async () => {
    const h = harness({ pointerTarget: OLD_TARGET })
    const outcome = await h.writer.consider(h.request({ target: { ...target(), observedTargetKey: OLD_TARGET } }))
    expect(outcome).toMatchObject({ kind: 'written' })
    expect(h.calls).toEqual([
      'read-pointer',
      `create:${COMMIT}:blobless`,
      'reserve',
      'presign',
      'upload',
      'head',
      'commit',
      'retag:ac-cache=live',
      'pointer'
    ])
    expect(h.pointed).toEqual([{ bundleKey: h.reserved[0]!.key, expectedTargetKey: OLD_TARGET }])
    expect(h.discarded).toEqual(['h-1'])
  })

  it('retags nothing when the commit is refused, and names no pointer when the retag fails', async () => {
    const refused = harness({ commit: { committed: false, reason: 'expired' } })
    expect(await refused.writer.consider(refused.request())).toMatchObject({ kind: 'failed', stage: 'commit' })
    expect(refused.calls.some((c) => c.startsWith('retag'))).toBe(false)
    const retag = harness({ retagError: new Error('HTTP 403') })
    expect(await retag.writer.consider(retag.request())).toMatchObject({ kind: 'failed', stage: 'retag' })
    expect(retag.calls).not.toContain('pointer')
  })

  it('reports a lost pointer race and leaves the bundle committed and unpointed', async () => {
    const h = harness({ pointer: { set: false, reason: 'pointer-moved' } })
    expect(await h.writer.consider(h.request())).toEqual({ kind: 'lost-race', bundleKey: h.reserved[0]!.key })
    const claimed = harness({ pointer: { set: false, reason: 'bundle-claimed' } })
    expect(await claimed.writer.consider(claimed.request())).toMatchObject({ kind: 'failed', stage: 'pointer' })
  })
})

describe('Source Cache write-back is never an exception into the session', () => {
  it('resolves when the store is closed, throws, or discard throws', async () => {
    const closed = harness({ noStore: true })
    expect(await closed.writer.consider(closed.request())).toEqual({ kind: 'skipped', reason: 'store-unavailable' })
    const broken = harness({ storeThrows: true })
    expect(await broken.writer.consider(broken.request())).toMatchObject({ kind: 'failed' })
    const discard = harness({ discardError: new Error('channel lost') })
    expect(await discard.writer.consider(discard.request())).toMatchObject({ kind: 'written' })
  })

  it("hands discard the writer's shutdown signal", async () => {
    const h = harness()
    const abort = new AbortController().signal
    await h.writer.consider(h.request({ abort }))
    expect(h.discardAborts).toEqual([abort])
  })

  it('never waits on a discard once shutdown has aborted', async () => {
    const sent: Array<{ payload: unknown; options?: ShimRequestOptions }> = []
    const client = new ShimBundleClient({
      request: (_capability, payload, options) => {
        sent.push({ payload, ...(options ? { options } : {}) })
        return new Promise(() => {})
      }
    })
    const shutdown = new AbortController()
    shutdown.abort()
    await client.discard('h-1', shutdown.signal)
    // Still sent so the pod reclaims promptly, but not tied to the aborted signal or awaited.
    expect(sent).toMatchObject([{ payload: { op: 'discard', handle: 'h-1' } }])
    expect(sent[0]!.options?.abort).toBeUndefined()
  })

  it('resolves when every dependency throws', async () => {
    const h = harness()
    const throwing = new Proxy({} as SourceCacheBundleStager, {
      get: () => () => {
        throw new Error('boom')
      }
    })
    const git = { raw: () => Promise.reject(new Error('boom')) } as unknown as GitRunner
    await expect(h.writer.consider(h.request({ stager: throwing, git }))).resolves.toMatchObject({ kind: 'skipped' })
    await expect(h.writer.consider(h.request({ stager: throwing }))).resolves.toMatchObject({
      kind: 'failed',
      stage: 'create'
    })
  })

  it('never logs the presigned URL', async () => {
    const h = harness({ uploadError: new Error(`upload to ${SECRET_URL} failed`) })
    const outcome = await h.writer.consider(h.request())
    expect(JSON.stringify(outcome)).not.toContain('TOPSECRET')
    expect(h.logs.join('\n')).not.toContain('TOPSECRET')
    expect(h.outcomes).toHaveLength(1)
  })

  it('runs one write-back per pointer at a time and caps concurrency', async () => {
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow: SourceCacheBundleStager = {
      ...h.stager,
      create: async (input) => {
        await gate
        return h.stager.create(input)
      }
    }
    const first = h.writer.consider(h.request({ stager: slow }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(await h.writer.consider(h.request({ stager: slow }))).toEqual({ kind: 'skipped', reason: 'in-flight' })
    const other = h.writer.consider(h.request({ stager: slow, target: target('anon', 'full') }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(
      await h.writer.consider(h.request({ stager: slow, target: { ...target(), pointerKey: 'p3' as never } }))
    ).toEqual({ kind: 'skipped', reason: 'busy' })
    release()
    expect(await first).toMatchObject({ kind: 'written' })
    expect(await other).toMatchObject({ kind: 'written' })
  })
})
