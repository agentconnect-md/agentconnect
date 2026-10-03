import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { createBundleHandler } from '../src/shim/bundle-handler.js'
import {
  BundleCreateResultSchema,
  BundleUploadResultSchema,
  type BundleCreateRequest,
  type BundleUploadRequest
} from '../src/shim/bundle-protocol.js'
import { prepareBundleStaging } from '../src/shim/bundle-staging.js'
import type { CredentialsProvider } from '../src/source-cache/credentials.js'
import { systemClock } from '@agentconnect.md/connection'
import {
  anonRepoId,
  bundleKey,
  newBundleId,
  pointerKey,
  refHash,
  type SourceCacheObjectKey
} from '../src/source-cache/keys.js'
import { evaluateSourceCacheLifecycle, sourceCacheLifecycleRules } from '../src/source-cache/lifecycle.js'
import { createObjectClient } from '../src/source-cache/object-client.js'
import { createPresigner, type SourceCachePresignerConfig } from '../src/source-cache/presigner.js'
import { amzDate, presign } from '../src/source-cache/sigv4.js'
import { createSourceCacheSweeper } from '../src/source-cache/sweep.js'
import { createSourceCacheWriter, type SourceCacheBundleStager } from '../src/source-cache/write-back.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { openTestStore } from './store-support.js'

// The P0 store-matrix facts (source-cache.md §14) re-proved through this presigner against MinIO.

const minio = inject('sourceCacheMinio')
const BUCKET = 'ac-source-cache'
const PREFIX = 'agentconnect'

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function send(url: string, method: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe.skipIf(!minio)('Source Cache presigned URLs on MinIO', () => {
  // The describe body still runs when skipped, so it needs a value to build against.
  const env = minio ?? {
    endpoint: 'http://127.0.0.1:9',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
    region: 'us-east-1'
  }
  const credentials: CredentialsProvider = {
    source: 'static',
    get: async () => ({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey })
  }
  const config: SourceCachePresignerConfig = {
    region: env.region,
    bucket: BUCKET,
    prefix: PREFIX,
    forcePathStyle: true,
    limits: { getUrlSeconds: 300, putUrlSeconds: 900, maxBundleBytes: 1024 * 1024 }
  }
  const signer = createPresigner({ config, credentials, endpointOverride: env.endpoint })
  const host = new URL(env.endpoint).host

  /** A header-free admin request signed by the low-level core, for steps the presigner does not offer. */
  function adminUrl(method: string, path: string, query?: Record<string, string>): string {
    return presign({
      method,
      protocol: 'http:',
      host,
      path,
      ...(query ? { query } : {}),
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      region: env.region,
      datetime: amzDate(Date.now()),
      expiresSeconds: 60
    }).url
  }

  const objectPath = (key: SourceCacheObjectKey): string => `/${BUCKET}/${PREFIX}/${key}`
  const freshKey = (): SourceCacheObjectKey =>
    bundleKey({ org: 'org_1', class: 'cred', repo: 'github:42', id: newBundleId() })
  const sha = (body: Buffer): string => createHash('sha256').update(body).digest('base64')

  beforeAll(async () => {
    const created = await send(adminUrl('PUT', `/${BUCKET}`), 'PUT')
    expect(created.status).toBe(200)
  })

  it('accepts the exact signed PUT, stores the declared length and the pending tag, and serves it by GET', async () => {
    const key = freshKey()
    const body = randomBytes(4096)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const uploaded = await send(put.url, 'PUT', put.headers, body)
    expect(uploaded.status, uploaded.body).toBe(200)

    const head = await send(adminUrl('HEAD', objectPath(key)), 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(body.length))

    const tagging = await send(adminUrl('GET', objectPath(key), { tagging: '' }), 'GET')
    expect(tagging.status).toBe(200)
    const tags = [...tagging.body.matchAll(/<Tag><Key>([^<]*)<\/Key><Value>([^<]*)<\/Value><\/Tag>/g)].map(
      ([, k, v]) => `${k}=${v}`
    )
    expect(tags).toEqual(['ac-cache=pending'])

    const get = await signer.presignGet(key)
    const fetched = await new Promise<Buffer>((resolve, reject) => {
      httpRequest(get.url, { method: 'GET' }, (res) => {
        expect(res.statusCode).toBe(200)
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
        .on('error', reject)
        .end()
    })
    expect(fetched.equals(body)).toBe(true)
  })

  it('refuses a body of a different length than the signed one', async () => {
    const key = freshKey()
    const body = randomBytes(1024)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const longer = Buffer.concat([body, Buffer.from('x')])
    const reply = await send(put.url, 'PUT', { ...put.headers, 'content-length': String(longer.length) }, longer)
    expect(reply.status).toBe(403)
  })

  it('refuses a same-length body whose bytes do not match the signed checksum', async () => {
    const key = freshKey()
    const body = randomBytes(1024)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const other = randomBytes(1024)
    const reply = await send(put.url, 'PUT', put.headers, other)
    expect(reply.status).toBe(400)
    expect(reply.body).toMatch(/XAmzContentChecksumMismatch|BadDigest/)
    expect((await send(adminUrl('HEAD', objectPath(key)), 'HEAD')).status).toBe(404)
  })

  it('refuses an altered or omitted tag', async () => {
    const key = freshKey()
    const body = randomBytes(512)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const altered = await send(put.url, 'PUT', { ...put.headers, 'x-amz-tagging': 'ac-cache=live' }, body)
    expect(altered.status).toBe(403)
    const { 'x-amz-tagging': _omitted, ...withoutTag } = put.headers
    const omitted = await send(put.url, 'PUT', withoutTag, body)
    // MinIO answers a missing signed header with 400 AccessDenied, not 403; refused either way.
    expect(omitted.status).toBe(400)
    expect(omitted.body).toContain('<Code>AccessDenied</Code>')
    expect((await send(adminUrl('HEAD', objectPath(key)), 'HEAD')).status).toBe(404)
  })

  it('refuses an expired GET', async () => {
    const key = freshKey()
    const body = randomBytes(64)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    expect((await send(put.url, 'PUT', put.headers, body)).status).toBe(200)
    const past = createPresigner({
      config: { ...config, limits: { ...config.limits, getUrlSeconds: 60 } },
      credentials,
      endpointOverride: env.endpoint,
      now: () => Date.now() - 5 * 60_000
    })
    const expired = await past.presignGet(key)
    expect((await send(expired.url, 'GET')).status).toBe(403)
  })

  it("round-trips a key whose cred repo id carries ':'", async () => {
    const key = freshKey()
    expect(key).toContain('github:42')
    const body = Buffer.from('bundle bytes')
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    expect((await send(put.url, 'PUT', put.headers, body)).status).toBe(200)
    const reply = await send((await signer.presignGet(key)).url, 'GET')
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('bundle bytes')
  })

  it('writes a workspace back end to end: reserve, presign, shim upload, HEAD, commit, retag live, pointer', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-writeback-ws-')))
    const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'ac-writeback-rt-')))
    const store = await openTestStore()
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e'
      }
      const seed = join(root, 'seed')
      execFileSync('git', ['init', '-q', '--initial-branch=main', seed])
      writeFileSync(join(seed, 'a.txt'), 'a\n')
      execFileSync('git', ['add', '.'], { cwd: seed })
      execFileSync('git', ['commit', '-qm', 'a'], { cwd: seed, env: gitEnv })
      const origin = join(root, 'origin.git')
      execFileSync('git', ['clone', '-q', '--bare', seed, origin])
      execFileSync('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: origin })
      const checkout = join(root, 'checkout')
      execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, checkout])

      const staging = join(runtime, 'bundle-staging')
      prepareBundleStaging(staging)
      const handler = createBundleHandler({ workspaceRoot: root, stagingDir: staging, allowHttpUpload: true })
      // The shim side in process: the same handler the pod serves, reached without a channel.
      const stager: SourceCacheBundleStager = {
        create: async (input, abort) =>
          BundleCreateResultSchema.parse(
            await handler({ op: 'create', ...input } satisfies BundleCreateRequest, abort)
          ),
        upload: async (input, abort) =>
          BundleUploadResultSchema.parse(
            await handler({ op: 'upload', ...input } satisfies BundleUploadRequest, abort)
          ),
        discard: async (handle) => {
          await handler({ op: 'discard', handle })
        }
      }
      const git = {
        raw: async (args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' })
      } as unknown as GitRunner
      const objects = createObjectClient({ config, credentials, endpointOverride: env.endpoint })
      const writer = createSourceCacheWriter({
        store: () => store,
        presigner: signer,
        objects,
        limits: { maxBundleBytes: 1024 * 1024, orgQuotaBytes: 10 * 1024 * 1024, pendingReservationSeconds: 3600 },
        log: { debug: () => {}, info: () => {}, warn: () => {} }
      })
      const repoId = anonRepoId('https://github.com/acme/widgets')
      const latest = pointerKey({
        org: 'org_1',
        class: 'anon',
        repo: repoId,
        ref: 'refs/heads/main',
        shape: 'blobless'
      })
      const outcome = await writer.consider({
        target: {
          orgId: 'org_1',
          repoClass: 'anon',
          repoId,
          ref: 'refs/heads/main',
          shape: 'blobless',
          pointerKey: latest,
          observedTargetKey: null
        },
        read: { kind: 'uncached' },
        checkout,
        git,
        stager,
        credentialed: false
      })
      expect(outcome).toMatchObject({ kind: 'written', trigger: 'miss' })
      const written = (outcome as { bundleKey: string }).bundleKey as SourceCacheObjectKey

      // MinIO returns the stored checksum under checksum mode, which is what the commit gate requires.
      const head = await objects.head(written)
      expect(head).toMatchObject({ exists: true, checksumSha256: expect.stringMatching(/=$/) })
      const tagging = await send(adminUrl('GET', objectPath(written), { tagging: '' }), 'GET')
      expect(tagging.body).toContain('<Key>ac-cache</Key><Value>live</Value>')
      expect(await store.getSourceCacheObject('org_1', written)).toMatchObject({
        state: 'committed',
        unpointedAt: null
      })
      expect(await store.getSourceCacheObject('org_1', latest)).toMatchObject({ targetKey: written })
      expect(readdirSync(staging)).toEqual([])

      // The committed bundle reads back through an ordinary presigned GET.
      const fetched = await send((await signer.presignGet(written)).url, 'GET')
      expect(fetched.status).toBe(200)
    } finally {
      await store.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(runtime, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!minio)('Source Cache sweep and lifecycle on MinIO (§9, §10)', () => {
  const env = minio ?? {
    endpoint: 'http://127.0.0.1:9',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
    region: 'us-east-1'
  }
  const SWEEP_BUCKET = 'ac-source-cache-sweep'
  const credentials: CredentialsProvider = {
    source: 'static',
    get: async () => ({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey })
  }
  const config: SourceCachePresignerConfig = {
    region: env.region,
    bucket: SWEEP_BUCKET,
    prefix: PREFIX,
    forcePathStyle: true,
    limits: { getUrlSeconds: 300, putUrlSeconds: 900, maxBundleBytes: 1024 * 1024 }
  }
  const signer = createPresigner({ config, credentials, endpointOverride: env.endpoint })
  const objects = createObjectClient({ config, credentials, endpointOverride: env.endpoint })
  const host = new URL(env.endpoint).host
  const HOUR = 3_600_000
  const DAY = 24 * HOUR

  function adminUrl(method: string, path: string, query?: Record<string, string>, headers?: Record<string, string>) {
    return presign({
      method,
      protocol: 'http:',
      host,
      path,
      ...(query ? { query } : {}),
      ...(headers ? { headers } : {}),
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      region: env.region,
      datetime: amzDate(Date.now()),
      expiresSeconds: 60
    }).url
  }
  const objectPath = (key: string): string => `/${SWEEP_BUCKET}/${PREFIX}/${key}`
  const repoId = anonRepoId('https://github.com/acme/sweep')
  const freshKey = (): SourceCacheObjectKey =>
    bundleKey({ org: 'org_1', class: 'anon', repo: repoId, id: newBundleId() })
  const tagsOf = async (key: string): Promise<string[]> => {
    const reply = await send(adminUrl('GET', objectPath(key), { tagging: '' }), 'GET')
    return [...reply.body.matchAll(/<Tag><Key>([^<]*)<\/Key><Value>([^<]*)<\/Value><\/Tag>/g)].map(
      ([, k, v]) => `${k}=${v}`
    )
  }
  const exists = async (key: string): Promise<boolean> =>
    (await send(adminUrl('HEAD', objectPath(key)), 'HEAD')).status === 200

  async function upload(key: SourceCacheObjectKey): Promise<void> {
    const body = randomBytes(256)
    const put = await signer.presignPut(key, {
      contentLength: body.length,
      checksumSha256: createHash('sha256').update(body).digest('base64')
    })
    expect((await send(put.url, 'PUT', put.headers, body)).status).toBe(200)
  }

  async function reserve(store: Awaited<ReturnType<typeof openTestStore>>, key: string, at: number, expiresAt: number) {
    expect(
      await store.reserveBundle({
        orgId: 'org_1',
        key,
        refHash: refHash('refs/heads/main'),
        shape: 'blobless',
        bytes: 256,
        now: at,
        expiresAt,
        quotaBytes: 10 * 1024 * 1024,
        maxBundleBytes: 1024 * 1024
      })
    ).toMatchObject({ admitted: true })
  }

  async function committed(store: Awaited<ReturnType<typeof openTestStore>>, key: string, at: number) {
    await reserve(store, key, at, at + HOUR)
    expect(await store.commitBundle({ orgId: 'org_1', key, actualBytes: 256, now: at + 1 })).toMatchObject({
      committed: true
    })
  }

  const sweeperFor = (store: Awaited<ReturnType<typeof openTestStore>>) =>
    createSourceCacheSweeper({
      store: () => store,
      objects,
      config: { prefix: PREFIX, limits: { getUrlSeconds: 300, unreadPointerDays: 30 } },
      clock: systemClock,
      log: { debug: () => {}, info: () => {}, warn: () => {} }
    })

  beforeAll(async () => {
    expect((await send(adminUrl('PUT', `/${SWEEP_BUCKET}`), 'PUT')).status).toBe(200)
  })

  it('deletes expired uploads, retags unpointed bundles unreferenced, drops unread pointers, and repeats safely', async () => {
    const store = await openTestStore()
    try {
      const now = Date.now()
      const sweeper = sweeperFor(store)

      const abandoned = freshKey()
      await upload(abandoned)
      await reserve(store, abandoned, now - 2 * HOUR, now - HOUR)
      const neverUploaded = freshKey()
      await reserve(store, neverUploaded, now - 2 * HOUR, now - HOUR)

      const orphan = freshKey()
      await upload(orphan)
      await committed(store, orphan, now - 2 * HOUR)
      await objects.putTagging(orphan, 'ac-cache=live')

      const stale = freshKey()
      await upload(stale)
      await committed(store, stale, now - 40 * DAY)
      await objects.putTagging(stale, 'ac-cache=live')
      const latest = pointerKey({
        org: 'org_1',
        class: 'anon',
        repo: repoId,
        ref: 'refs/heads/main',
        shape: 'blobless'
      })
      expect(
        await store.setSourceCachePointer({ orgId: 'org_1', pointerKey: latest, bundleKey: stale, now: now - 40 * DAY })
      ).toMatchObject({ set: true })

      const first = await sweeper.runPass('member-1/minio')
      expect(first).toMatchObject({
        kind: 'done',
        pending: { claimed: 2, objectDeleted: 1, alreadyGone: 1, deleted: 2 },
        unreferenced: { claimed: 1, retagged: 1, deleted: 1, releasedBytes: 256 },
        pointers: { claimed: 1, deleted: 1 }
      })
      expect(await exists(abandoned)).toBe(false)
      expect(await store.getSourceCacheObject('org_1', abandoned)).toBeUndefined()
      expect(await store.getSourceCacheObject('org_1', neverUploaded)).toBeUndefined()
      // The object stays for the lifecycle rule; only its row and bytes go.
      expect(await exists(orphan)).toBe(true)
      expect(await tagsOf(orphan)).toEqual(['ac-cache=unreferenced'])
      expect(await store.getSourceCacheObject('org_1', orphan)).toBeUndefined()
      expect(await store.getSourceCacheObject('org_1', latest)).toBeUndefined()
      // The pointer's bundle is unpointed from now, so it waits out the GET lifetime before a retag.
      expect(await store.getSourceCacheObject('org_1', stale)).toMatchObject({ unpointedAt: expect.any(Number) })
      expect(await tagsOf(stale)).toEqual(['ac-cache=live'])
      expect((await store.sourceCacheUsage('org_1', Date.now())).committedBytes).toBe(256)

      expect(await sweeper.runPass('member-1/minio')).toMatchObject({
        pending: { claimed: 0 },
        unreferenced: { claimed: 0 },
        pointers: { claimed: 0 }
      })

      // An object removed out of band: the retag finds it gone and the row still goes.
      const vanished = freshKey()
      await upload(vanished)
      await committed(store, vanished, now - 2 * HOUR)
      expect((await send(adminUrl('DELETE', objectPath(vanished)), 'DELETE')).status).toBe(204)
      expect(await sweeper.runPass('member-2/minio')).toMatchObject({ unreferenced: { alreadyGone: 1, deleted: 1 } })
      expect(await store.getSourceCacheObject('org_1', vanished)).toBeUndefined()

      // DELETE is idempotent on a missing key.
      await objects.delete(vanished)
    } finally {
      await store.close()
    }
  })

  it('finds the lifecycle rules missing on a bare bucket and present once applied beside a foreign rule', async () => {
    const store = await openTestStore()
    try {
      const sweeper = sweeperFor(store)
      expect(await objects.getBucketLifecycle()).toEqual({ kind: 'none' })
      expect(await sweeper.checkLifecycle()).toBe('missing')

      const rules = sourceCacheLifecycleRules(PREFIX).Rules.map(
        (rule) =>
          `<Rule><ID>${rule.ID}</ID><Status>${rule.Status}</Status><Filter><And><Prefix>${rule.Filter.And.Prefix}</Prefix>${rule.Filter.And.Tags.map((t) => `<Tag><Key>${t.Key}</Key><Value>${t.Value}</Value></Tag>`).join('')}</And></Filter><Expiration><Days>${rule.Expiration.Days}</Days></Expiration></Rule>`
      )
      const foreign =
        '<Rule><ID>logs</ID><Status>Enabled</Status><Filter><Prefix>logs/</Prefix></Filter><Expiration><Days>1</Days></Expiration></Rule>'
      const body = `<LifecycleConfiguration>${foreign}${rules.join('')}</LifecycleConfiguration>`
      const md5 = createHash('md5').update(body).digest('base64')
      const put = await send(
        adminUrl('PUT', `/${SWEEP_BUCKET}`, { lifecycle: '' }, { 'content-md5': md5 }),
        'PUT',
        { 'content-md5': md5 },
        Buffer.from(body)
      )
      expect(put.status, put.body).toBe(200)
      const read = await objects.getBucketLifecycle()
      expect(read.kind).toBe('rules')
      expect(evaluateSourceCacheLifecycle((read as { xml: string }).xml, PREFIX)).toEqual({
        pending: true,
        unreferenced: true,
        warnings: []
      })
      expect(await sweeper.checkLifecycle()).toBe('present')
    } finally {
      await store.close()
    }
  })
})
