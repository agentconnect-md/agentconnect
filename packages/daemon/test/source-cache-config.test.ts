import { describe, expect, it } from 'vitest'
import { loadSourceCacheConfig, SOURCE_CACHE_ENV, sourceCacheEndpoint } from '../src/source-cache/config.js'

const GIB = 1024 ** 3
const STATIC = {
  source: 'static',
  dir: '/var/run/ac-source-cache',
  accessKeyIdKey: 'AWS_ACCESS_KEY_ID',
  secretAccessKeyKey: 'AWS_SECRET_ACCESS_KEY'
}

function load(doc: unknown): ReturnType<typeof loadSourceCacheConfig> {
  return loadSourceCacheConfig({ [SOURCE_CACHE_ENV]: typeof doc === 'string' ? doc : JSON.stringify(doc) })
}

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, region: 'us-east-1', bucket: 'ac-cache', credentials: STATIC, ...overrides }
}

describe('Source Cache configuration', () => {
  it('is absent when the variable is unset or blank', () => {
    expect(loadSourceCacheConfig({})).toBeUndefined()
    expect(loadSourceCacheConfig({ [SOURCE_CACHE_ENV]: '  ' })).toBeUndefined()
  })

  it('fills every §10 default and the 5m/15m URL lifetimes', () => {
    const config = load(minimal())!
    expect(config).toEqual({
      version: 1,
      region: 'us-east-1',
      bucket: 'ac-cache',
      prefix: '',
      forcePathStyle: false,
      credentials: STATIC,
      limits: {
        maxBundleBytes: 2 * GIB,
        orgQuotaBytes: 20 * GIB,
        pendingReservationSeconds: 3600,
        unreadPointerDays: 30,
        getUrlSeconds: 300,
        putUrlSeconds: 900
      }
    })
    expect(sourceCacheEndpoint(config)).toBe('https://s3.us-east-1.amazonaws.com')
  })

  it('parses binary quantities, durations and the chart rendering of the full document', () => {
    const config = load(
      minimal({
        endpoint: 'https://minio.example.test:9000/',
        prefix: 'agentconnect/prod',
        forcePathStyle: true,
        credentials: { ...STATIC, sessionTokenKey: 'AWS_SESSION_TOKEN' },
        limits: {
          maxBundleBytes: '512Mi',
          orgQuotaBytes: '1Gi',
          pendingReservationSeconds: '2h',
          unreadPointerDays: 7,
          getUrlSeconds: '2m',
          putUrlSeconds: 600
        }
      })
    )!
    expect(config.endpoint).toBe('https://minio.example.test:9000')
    expect(config.limits).toEqual({
      maxBundleBytes: 512 * 1024 ** 2,
      orgQuotaBytes: GIB,
      pendingReservationSeconds: 7200,
      unreadPointerDays: 7,
      getUrlSeconds: 120,
      putUrlSeconds: 600
    })
  })

  it('accepts both documents the chart renders (scripts/test-chart-render.rb)', () => {
    const limits = {
      getUrlSeconds: '5m',
      maxBundleBytes: '2Gi',
      orgQuotaBytes: '20Gi',
      pendingReservationSeconds: '1h',
      putUrlSeconds: '15m',
      unreadPointerDays: 30
    }
    const secret = load({
      bucket: 'ac-cache',
      credentials: {
        accessKeyIdKey: 'AWS_ACCESS_KEY_ID',
        dir: '/var/run/ac-source-cache',
        secretAccessKeyKey: 'AWS_SECRET_ACCESS_KEY',
        source: 'static'
      },
      endpoint: 'https://minio.example.test',
      forcePathStyle: true,
      limits,
      prefix: 'agentconnect',
      region: 'us-east-1',
      version: 1
    })!
    expect(secret.limits).toEqual({
      maxBundleBytes: 2 * GIB,
      orgQuotaBytes: 20 * GIB,
      pendingReservationSeconds: 3600,
      unreadPointerDays: 30,
      getUrlSeconds: 300,
      putUrlSeconds: 900
    })
    const identity = load({
      bucket: 'ac-cache',
      credentials: {
        roleArn: 'arn:aws:iam::123456789012:role/ac-source-cache',
        source: 'webIdentity',
        tokenFile: '/var/run/ac-source-cache-identity/token'
      },
      forcePathStyle: false,
      limits,
      prefix: '',
      region: 'us-east-1',
      version: 1
    })!
    expect(identity.credentials.source).toBe('webIdentity')
  })

  it('accepts the web identity form with its defaults', () => {
    const config = load(minimal({ credentials: { source: 'webIdentity' } }))!
    expect(config.credentials).toEqual({ source: 'webIdentity', durationSeconds: 3600 })
    const explicit = load(
      minimal({
        credentials: {
          source: 'webIdentity',
          roleArn: 'arn:aws:iam::123456789012:role/ac-source-cache',
          tokenFile: '/var/run/ac-source-cache-identity/token',
          stsEndpoint: 'https://sts.us-east-1.amazonaws.com'
        }
      })
    )!
    expect(explicit.credentials).toMatchObject({ roleArn: 'arn:aws:iam::123456789012:role/ac-source-cache' })
  })

  const refusals: Array<[string, unknown, string]> = [
    ['invalid JSON', '{nope', 'valid JSON'],
    ['an unknown key', minimal({ secretAccessKey: 'leak-me' }), 'unknown key'],
    ['a plain-http endpoint', minimal({ endpoint: 'http://minio.example.test' }), 'endpoint'],
    ['an endpoint with a path', minimal({ endpoint: 'https://minio.example.test/bucket' }), 'endpoint'],
    ['an endpoint with userinfo', minimal({ endpoint: 'https://leak-me:pw@minio.example.test' }), 'endpoint'],
    ['an upper-case bucket', minimal({ bucket: 'AC-Cache' }), 'bucket'],
    ['an IP-shaped bucket', minimal({ bucket: '192.168.1.10' }), 'bucket'],
    ['a bucket with ..', minimal({ bucket: 'ac..cache' }), 'bucket'],
    ['a too-short bucket', minimal({ bucket: 'ac' }), 'bucket'],
    ['a snapshots prefix', minimal({ prefix: 'snapshots/x' }), 'prefix'],
    ['a prefix with ..', minimal({ prefix: 'a/../b' }), 'prefix'],
    ['a prefix with a leading slash', minimal({ prefix: '/a' }), 'prefix'],
    [
      'a reservation shorter than the PUT lifetime plus grace',
      minimal({ limits: { pendingReservationSeconds: '15m' } }),
      'pendingReservationSeconds'
    ],
    [
      'a bundle cap above the org quota',
      minimal({ limits: { maxBundleBytes: '3Gi', orgQuotaBytes: '2Gi' } }),
      'maxBundleBytes'
    ],
    ['a bundle cap above 5Gi', minimal({ limits: { maxBundleBytes: '6Gi' } }), 'maxBundleBytes'],
    ['a GET lifetime under a minute', minimal({ limits: { getUrlSeconds: 30 } }), 'getUrlSeconds'],
    [
      'a PUT lifetime over an hour',
      minimal({ limits: { putUrlSeconds: '2h', pendingReservationSeconds: '3h' } }),
      'putUrlSeconds'
    ],
    ['a malformed quantity', minimal({ limits: { maxBundleBytes: '2GB' } }), 'maxBundleBytes'],
    [
      'a web identity session too short for the PUT lifetime',
      minimal({ credentials: { source: 'webIdentity', durationSeconds: 1000 } }),
      'durationSeconds'
    ],
    ['a static form without key names', minimal({ credentials: { source: 'static', dir: '/x' } }), 'credentials'],
    ['an unknown credential source', minimal({ credentials: { source: 'leak-me' } }), 'credentials'],
    ['a wrong version', minimal({ version: 2 }), 'version']
  ]

  it.each(refusals)('refuses %s without echoing values', (_name, doc, field) => {
    let message = ''
    try {
      load(doc)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain(SOURCE_CACHE_ENV)
    expect(message).toContain(field)
    expect(message).not.toContain('leak-me')
  })
})
