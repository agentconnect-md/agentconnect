import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { BaseClient, createRequester } from '@logto/browser'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { enableJwksCacheRecovery } from './logto-jwks'

const keys = ['old', 'current', 'rotated'].map((kid) => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { ...pair, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } }
})
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
let server: Server
let origin: string
let client: BaseClient
let cachedKeys: number
let publishedKeys: number
let forcedReloads: number
let tokenGrants: string[]
let fault: string | undefined

function idToken(): string {
  const now = Math.floor(Date.now() / 1000)
  const kid = fault === 'signature' ? 'old' : fault === 'missing key' ? 'unpublished' : keys[publishedKeys]!.jwk.kid
  const input = `${encode({ alg: 'ES256', kid })}.${encode({
    iss: `${origin}/oidc`,
    aud: fault === 'audience' ? 'another-app' : 'web-app',
    sub: 'example-user',
    iat: now,
    exp: now + 300
  })}`
  const signature = sign('sha256', Buffer.from(input), {
    key: keys[publishedKeys]!.privateKey,
    dsaEncoding: 'ieee-p1363'
  })
  return `${input}.${signature.toString('base64url')}`
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.endsWith('/.well-known/openid-configuration')) {
      res.end(
        JSON.stringify({
          issuer: `${origin}/oidc`,
          authorization_endpoint: `${origin}/oidc/auth`,
          token_endpoint: `${origin}/oidc/token`,
          jwks_uri: `${origin}/oidc/jwks`
        })
      )
    } else if (req.url === '/oidc/jwks') {
      // Model a browser cache that keeps its old response until a reload request replaces it.
      if (req.headers['cache-control'] === 'no-cache') {
        forcedReloads++
        cachedKeys = publishedKeys
      }
      res.end(JSON.stringify({ keys: [keys[cachedKeys]!.jwk] }))
    } else if (req.url === '/oidc/token') {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      tokenGrants.push(new URLSearchParams(body).get('grant_type')!)
      res.end(
        JSON.stringify({
          id_token: idToken(),
          access_token: 'example-access-token',
          refresh_token: 'example-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid'
        })
      )
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(async () => {
  cachedKeys = 0
  publishedKeys = 1
  forcedReloads = 0
  tokenGrants = []
  fault = undefined
  const storage = new Map<string, string>()
  client = new BaseClient(
    { endpoint: origin, appId: 'web-app' },
    {
      requester: createRequester(fetch),
      storage: {
        getItem: async (key) => storage.get(key) ?? null,
        setItem: async (key, value) => {
          storage.set(key, value)
        },
        removeItem: async (key) => {
          storage.delete(key)
        }
      },
      navigate: () => {},
      generateState: () => 'state',
      generateCodeVerifier: () => 'verifier',
      generateCodeChallenge: () => 'challenge'
    }
  )
  enableJwksCacheRecovery(client)
  await client.signIn({ redirectUri: 'https://console.example.test/auth/callback' })
})

const completeLogin = () =>
  client.handleSignInCallback('https://console.example.test/auth/callback?code=code&state=state')

it('recovers key rotation during login and refresh without repeating either token exchange', async () => {
  await completeLogin()
  expect(await client.isAuthenticated()).toBe(true)
  expect(forcedReloads).toBe(1)
  expect(tokenGrants).toEqual(['authorization_code'])

  publishedKeys = 2
  await client.clearAccessToken()
  await expect(client.getAccessToken()).resolves.toBe('example-access-token')
  expect(forcedReloads).toBe(2)
  expect(tokenGrants).toEqual(['authorization_code', 'refresh_token'])
  expect(await client.getIdTokenClaims()).toMatchObject({ sub: 'example-user', aud: 'web-app' })
})

it.each([
  ['signature', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 0],
  ['audience', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 1],
  ['missing key', 'ERR_JWKS_NO_MATCHING_KEY', 1]
] as const)('still rejects a bad %s without looping or reusing the authorization code', async (kind, code, reloads) => {
  fault = kind
  await expect(completeLogin()).rejects.toMatchObject({ code })
  expect(forcedReloads).toBe(reloads)
  expect(tokenGrants).toEqual(['authorization_code'])
  expect(await client.isAuthenticated()).toBe(false)
})
