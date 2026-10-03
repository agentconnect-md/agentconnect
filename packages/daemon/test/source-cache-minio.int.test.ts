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
import { anonRepoId, bundleKey, newBundleId, pointerKey, type SourceCacheObjectKey } from '../src/source-cache/keys.js'
import { createObjectClient } from '../src/source-cache/object-client.js'
import { createPresigner, type SourceCachePresignerConfig } from '../src/source-cache/presigner.js'
import { amzDate, presign } from '../src/source-cache/sigv4.js'
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
