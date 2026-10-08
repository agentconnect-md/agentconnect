import { describe, expect, it, vi } from 'vitest'
import {
  createCredentialsProvider,
  parseStsCredentials,
  STATIC_REREAD_MS,
  staticCredentials,
  STS_FAILURE_BACKOFF_MS,
  webIdentityCredentials
} from '../src/source-cache/credentials.js'

function files(initial: Record<string, string>): {
  read: (path: string) => string
  set: (path: string, v?: string) => void
} {
  const store = new Map(Object.entries(initial))
  return {
    read: (path) => {
      const value = store.get(path)
      if (value === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
      return value
    },
    set: (path, value) => (value === undefined ? store.delete(path) : store.set(path, value))
  }
}

function clock(start = Date.UTC(2026, 9, 3, 12, 0, 0)): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

function stsXml(n: number, expiresAt: number): string {
  return `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>ASIA${n}</AccessKeyId>
      <SecretAccessKey>secret-${n}</SecretAccessKey>
      <SessionToken>session&amp;token-${n}</SessionToken>
      <Expiration>${new Date(expiresAt).toISOString()}</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`
}

const HOUR = 3_600_000

describe('Source Cache static credentials', () => {
  const dir = '/var/run/ac-source-cache'
  const keys = { dir, accessKeyIdKey: 'id', secretAccessKeyKey: 'secret', sessionTokenKey: 'token' }

  it('reads and trims the mounted files; the session token is optional', async () => {
    const fs = files({ [`${dir}/id`]: 'AKID\n', [`${dir}/secret`]: ' s3cr3t \n' })
    const provider = staticCredentials({ ...keys, readFile: fs.read })
    expect(provider.source).toBe('static')
    expect(await provider.get(0)).toEqual({ accessKeyId: 'AKID', secretAccessKey: 's3cr3t' })
    fs.set(`${dir}/token`, 'tok\n')
    const withToken = staticCredentials({ ...keys, readFile: fs.read })
    expect(await withToken.get(0)).toEqual({ accessKeyId: 'AKID', secretAccessKey: 's3cr3t', sessionToken: 'tok' })
  })

  it('fails at construction on a missing or empty key file, without echoing contents', () => {
    expect(() => staticCredentials({ ...keys, readFile: files({ [`${dir}/id`]: 'AKID' }).read })).toThrow(
      'secret access key file is missing'
    )
    expect(() =>
      staticCredentials({ ...keys, readFile: files({ [`${dir}/id`]: ' \n', [`${dir}/secret`]: 'x' }).read })
    ).toThrow('access key id file is empty')
  })

  it('picks up a rotated Secret after the re-read interval and keeps the last good keys on a failed read', async () => {
    const fs = files({ [`${dir}/id`]: 'AKID1', [`${dir}/secret`]: 'one' })
    const t = clock()
    const provider = staticCredentials({ ...keys, readFile: fs.read, now: t.now })
    fs.set(`${dir}/id`, 'AKID2')
    fs.set(`${dir}/secret`, 'two')
    t.advance(STATIC_REREAD_MS - 1)
    expect((await provider.get(0)).accessKeyId).toBe('AKID1')
    t.advance(1)
    expect(await provider.get(0)).toEqual({ accessKeyId: 'AKID2', secretAccessKey: 'two' })
    fs.set(`${dir}/secret`)
    t.advance(STATIC_REREAD_MS)
    expect(await provider.get(0)).toEqual({ accessKeyId: 'AKID2', secretAccessKey: 'two' })
  })
})

describe('Source Cache web identity credentials', () => {
  const tokenFile = '/var/run/ac-source-cache-identity/token'
  const roleArn = 'arn:aws:iam::123456789012:role/ac-source-cache'

  function setup(opts: { responses?: Array<() => Response | Promise<Response>>; env?: NodeJS.ProcessEnv } = {}) {
    const t = clock()
    const fs = files({ [tokenFile]: 'jwt-1\n' })
    let n = 0
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      const next = opts.responses?.shift()
      if (next) return next()
      n += 1
      return new Response(stsXml(n, t.now() + HOUR), { status: 200 })
    })
    const provider = webIdentityCredentials({
      region: 'eu-west-1',
      roleArn,
      tokenFile,
      durationSeconds: 3600,
      env: opts.env ?? { AC_K8S_MEMBER_ID: '0c9f2e8a-5f43-4c9e-9e0b-6a5c1d2e3f4a' },
      fetch: fetch as unknown as typeof globalThis.fetch,
      readFile: fs.read,
      now: t.now
    })
    return { t, fs, fetch, provider }
  }

  it('posts AssumeRoleWithWebIdentity to the regional STS with the token re-read from its file', async () => {
    const { fetch, fs, provider, t } = setup()
    const creds = await provider.get(20 * 60_000)
    expect(creds).toEqual({
      accessKeyId: 'ASIA1',
      secretAccessKey: 'secret-1',
      sessionToken: 'session&token-1',
      expiresAt: t.now() + HOUR
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://sts.eu-west-1.amazonaws.com')
    expect(init?.method).toBe('POST')
    const form = new URLSearchParams(String(init?.body))
    expect(Object.fromEntries(form)).toEqual({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: roleArn,
      RoleSessionName: 'agentconnect-source-cache-0c9f2e8a-5f43-4c9e-9e0b-6a5c1d2e3f4a',
      WebIdentityToken: 'jwt-1',
      DurationSeconds: '3600'
    })
    fs.set(tokenFile, 'jwt-2')
    t.advance(HOUR - 10 * 60_000)
    await provider.get(20 * 60_000)
    expect(new URLSearchParams(String(fetch.mock.calls[1]![1]?.body)).get('WebIdentityToken')).toBe('jwt-2')
  })

  it('shares one STS call among concurrent callers and caches the answer', async () => {
    const { fetch, provider } = setup()
    const results = await Promise.all(Array.from({ length: 10 }, () => provider.get(60_000)))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Set(results.map((c) => c.accessKeyId))).toEqual(new Set(['ASIA1']))
    await provider.get(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the remaining validity drops below what the caller needs', async () => {
    const { fetch, provider, t } = setup()
    await provider.get(20 * 60_000)
    t.advance(HOUR - 20 * 60_000)
    expect((await provider.get(20 * 60_000)).accessKeyId).toBe('ASIA1')
    t.advance(1)
    expect((await provider.get(20 * 60_000)).accessKeyId).toBe('ASIA2')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('serves cached credentials while still sufficient after a failed refresh, then throws and backs off', async () => {
    const failing = () =>
      new Response('<ErrorResponse><Error><Code>InvalidIdentityToken</Code></Error></ErrorResponse>', { status: 400 })
    const { fetch, provider, t } = setup()
    await provider.get(0)
    // 15 minutes left: a PUT (20m) triggers a refresh that fails, a GET (10m) on the same in-flight call is still served.
    t.advance(HOUR - 15 * 60_000)
    fetch.mockImplementationOnce(async () => failing())
    const [put, get] = await Promise.allSettled([provider.get(20 * 60_000), provider.get(10 * 60_000)])
    expect(put.status).toBe('rejected')
    expect(get).toMatchObject({ status: 'fulfilled', value: { accessKeyId: 'ASIA1' } })
    // Within the backoff no STS call is made; a sufficient cache still answers.
    await expect(provider.get(20 * 60_000)).rejects.toThrow('backing off')
    expect((await provider.get(10 * 60_000)).accessKeyId).toBe('ASIA1')
    expect(fetch).toHaveBeenCalledTimes(2)
    t.advance(STS_FAILURE_BACKOFF_MS)
    expect((await provider.get(20 * 60_000)).accessKeyId).toBe('ASIA2')
  })

  it('backs off after an STS answer that expires before the requested validity', async () => {
    const { fetch, provider, t } = setup({
      responses: [() => new Response(stsXml(1, Date.UTC(2026, 9, 3, 12, 5, 0)), { status: 200 })]
    })
    await expect(provider.get(20 * 60_000)).rejects.toThrow('expire before')
    await expect(provider.get(20 * 60_000)).rejects.toThrow('backing off')
    expect((await provider.get(60_000)).accessKeyId).toBe('ASIA1')
    expect(fetch).toHaveBeenCalledTimes(1)
    t.advance(STS_FAILURE_BACKOFF_MS)
    expect((await provider.get(20 * 60_000)).accessKeyId).toBe('ASIA1')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reports only the STS error code, never the token or the body', async () => {
    const { provider } = setup({
      responses: [
        () =>
          new Response(
            '<ErrorResponse><Error><Code>AccessDenied</Code><Message>token jwt-1 rejected secretdetail</Message></Error></ErrorResponse>',
            { status: 403 }
          )
      ]
    })
    const err = await provider.get(0).catch((e: Error) => e)
    expect((err as Error).message).toBe('STS AssumeRoleWithWebIdentity failed: HTTP 403 AccessDenied')
  })

  it('reports a network failure by name only', async () => {
    const { provider } = setup({
      responses: [
        () => {
          throw new TypeError('fetch failed jwt-1')
        }
      ]
    })
    await expect(provider.get(0)).rejects.toThrow('STS AssumeRoleWithWebIdentity request failed: TypeError')
  })

  it('falls back to the webhook-injected environment and requires both values', () => {
    const fs = files({ '/token': 'jwt' })
    const provider = webIdentityCredentials({
      region: 'us-east-1',
      durationSeconds: 3600,
      env: { AWS_ROLE_ARN: roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: '/token' },
      readFile: fs.read
    })
    expect(provider.source).toBe('webIdentity')
    expect(() =>
      webIdentityCredentials({ region: 'us-east-1', durationSeconds: 3600, env: { AWS_ROLE_ARN: roleArn } })
    ).toThrow('token file')
    expect(() =>
      webIdentityCredentials({
        region: 'us-east-1',
        durationSeconds: 3600,
        env: { AWS_WEB_IDENTITY_TOKEN_FILE: '/token' }
      })
    ).toThrow('role ARN')
  })

  it('uses a configured STS endpoint', async () => {
    const t = clock()
    const fetch = vi.fn(async () => new Response(stsXml(1, t.now() + HOUR)))
    const provider = createCredentialsProvider(
      { source: 'webIdentity', roleArn, tokenFile, stsEndpoint: 'https://sts.example.test', durationSeconds: 3600 },
      { region: 'us-east-1', env: {}, fetch: fetch as never, readFile: files({ [tokenFile]: 'jwt' }).read, now: t.now }
    )
    await provider.get(0)
    expect(fetch.mock.calls[0]).toBeDefined()
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe('https://sts.example.test')
  })

  it('refuses an STS answer without complete credentials', () => {
    expect(() => parseStsCredentials('<x/>')).toThrow('no credentials')
    expect(() => parseStsCredentials('<Credentials><AccessKeyId>A</AccessKeyId></Credentials>')).toThrow('incomplete')
  })
})
