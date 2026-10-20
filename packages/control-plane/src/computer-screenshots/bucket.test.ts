import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CredentialsProvider, SourceCacheObjectHead } from '@agentconnect.md/object-store'
import { ComputerScreenshotsConfigSchema, loadComputerScreenshotsConfig } from './config.js'
import { createScreenshotBucket, isScreenshotObjectKey, screenshotObjectKey, sha256HexToBase64 } from './bucket.js'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)
const COMPUTER = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
const SHA = createHash('sha256').update('png').digest('hex')

const credentials: CredentialsProvider = {
  source: 'static',
  get: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' })
}

const document = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  endpoint: 'https://store.internal.example.test',
  publicEndpoint: 'https://store.example.test',
  region: 'us-east-1',
  bucket: 'ac-screens',
  forcePathStyle: true,
  credentials: { source: 'static', dir: '/creds', accessKeyIdKey: 'id', secretAccessKeyKey: 'secret' },
  ...overrides
})

function bucket(head: SourceCacheObjectHead = { exists: false }, deleted: string[] = []) {
  return createScreenshotBucket({
    config: ComputerScreenshotsConfigSchema.parse(document()),
    credentials,
    objects: {
      head: async () => head,
      delete: async (key) => void deleted.push(key)
    },
    now: () => NOW
  })
}

const key = (sessionId = 'sess-1') =>
  screenshotObjectKey({
    orgId: 'org_1',
    computerId: COMPUTER,
    sessionId,
    takenAt: new Date(NOW),
    sha256: SHA,
    contentType: 'image/png'
  })

describe('screenshot storage config', () => {
  it('defaults the limits and the retention', () => {
    const config = ComputerScreenshotsConfigSchema.parse(document())
    expect(config.limits).toEqual({ maxBytes: 8 * 1024 ** 2, putUrlSeconds: 300, getUrlSeconds: 300 })
    expect(config.retention).toEqual({ defaultDays: 30, maxDays: 365 })
  })

  it('refuses a default above the maximum, a plain-http endpoint and an oversized cap', () => {
    expect(ComputerScreenshotsConfigSchema.safeParse(document({ retention: { defaultDays: 400 } })).success).toBe(false)
    expect(ComputerScreenshotsConfigSchema.safeParse(document({ endpoint: 'http://store.test' })).success).toBe(false)
    expect(ComputerScreenshotsConfigSchema.safeParse(document({ limits: { maxBytes: '64Mi' } })).success).toBe(false)
  })

  it('is off when unset and names the variable, not its value, when invalid', () => {
    expect(loadComputerScreenshotsConfig({})).toBeUndefined()
    expect(() => loadComputerScreenshotsConfig({ AC_COMPUTER_SCREENSHOTS: '{"version":1,"secret":"x"}' })).toThrow(
      /^AC_COMPUTER_SCREENSHOTS is invalid/
    )
  })
})

describe('screenshot keys', () => {
  it('places a screenshot under its org, Computer and session', () => {
    expect(key()).toBe(`computer-screenshots/org_1/${COMPUTER}/sess-1/${NOW}-${SHA}.png`)
    expect(isScreenshotObjectKey(key())).toBe(true)
    expect(isScreenshotObjectKey(`src/org_1/transfer/dl/${SHA}`)).toBe(false)
  })

  it('names a session id that is not a safe path segment by its digest', () => {
    const odd = key('a/../b')
    expect(odd).toMatch(new RegExp(`^computer-screenshots/org_1/${COMPUTER}/h-[0-9a-f]{40}/`))
    expect(isScreenshotObjectKey(odd)).toBe(true)
  })
})

describe('screenshot bucket', () => {
  it('signs a PUT bound to the length, type and checksum, at the public origin', async () => {
    const put = await bucket().signPut({ key: key(), bytes: 10, sha256: SHA, contentType: 'image/png' })
    expect(put.url.startsWith(`https://store.example.test/ac-screens/computer-screenshots/org_1/`)).toBe(true)
    expect(put.headers).toEqual({
      'content-length': '10',
      'content-type': 'image/png',
      'x-amz-checksum-sha256': sha256HexToBase64(SHA)
    })
    expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-checksum-sha256'
    )
    expect(put.expiresAt).toBe(NOW + 300_000)
    await expect(
      bucket().signPut({ key: key(), bytes: 9 * 1024 ** 2, sha256: SHA, contentType: 'image/png' })
    ).rejects.toThrow()
  })

  it('signs an inline GET', async () => {
    const get = await bucket().signGet({ key: key(), contentType: 'image/png' })
    expect(new URL(get.url).searchParams.get('response-content-type')).toBe('image/png')
  })

  it('holds only exactly the announced bytes', async () => {
    const checksum = sha256HexToBase64(SHA)
    expect(
      await bucket({ exists: true, contentLength: 10, checksumSha256: checksum }).holds({
        key: key(),
        bytes: 10,
        sha256: SHA
      })
    ).toBe(true)
    expect(
      await bucket({ exists: true, contentLength: 11, checksumSha256: checksum }).holds({
        key: key(),
        bytes: 10,
        sha256: SHA
      })
    ).toBe(false)
    expect(
      await bucket({ exists: true, contentLength: 10, checksumSha256: 'x' }).holds({
        key: key(),
        bytes: 10,
        sha256: SHA
      })
    ).toBe(false)
    expect(await bucket({ exists: false }).holds({ key: key(), bytes: 10, sha256: SHA })).toBe(false)
  })

  it('deletes through the object client', async () => {
    const deleted: string[] = []
    await bucket(undefined, deleted).delete(key())
    expect(deleted).toEqual([key()])
  })
})
