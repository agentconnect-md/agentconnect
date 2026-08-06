/**
 * `VaultTransitSecretCipher` — driven against a fake Transit API (no network):
 * wire shape (paths, headers, base64), the plaintext pass-through arm of the
 * SecretCipher contract, the open() cache, JWT login + 403 re-login, and
 * the never-echo-payloads error discipline.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultTransitSecretCipher } from './vault-transit.js'
import { makeSecretCipher, PlaintextSecretCipher } from './cipher.js'
import { DEPLOYMENT_SCOPE, orgScope } from './scope.js'
import { OrgId } from '../domain/ids.js'
import { loadConfig } from '../config/env.js'

const ORG_A = orgScope(OrgId('org-aaa'))
const ORG_B = orgScope(OrgId('org-bbb'))

type Call = { url: string; token: string | null; namespace: string | null; body: Record<string, unknown> }

/** A tiny in-memory Transit: "encrypt" wraps the base64 plaintext into the
 *  ciphertext envelope; "decrypt" unwraps it. Records every call. */
function fakeVault(opts: { failFirstWith403?: boolean; leaseSec?: number } = {}) {
  const calls: Call[] = []
  let fail403Remaining = opts.failFirstWith403 ? 1 : 0
  let loginCount = 0
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, token: headers.get('x-vault-token'), namespace: headers.get('x-vault-namespace'), body })

    if (url.includes('/auth/') && url.endsWith('/login')) {
      loginCount += 1
      if (typeof body.jwt !== 'string' || typeof body.role !== 'string') return json(400, { errors: ['bad login'] })
      return json(200, { auth: { client_token: `k8s-token-${loginCount}`, lease_duration: opts.leaseSec ?? 3600 } })
    }
    if (fail403Remaining > 0) {
      fail403Remaining -= 1
      return json(403, { errors: ['permission denied'] })
    }
    // Transit binds a ciphertext to the key that produced it, so the fake stamps
    // the key name in and refuses a mismatch — that refusal IS the cross-tenant
    // fence under test.
    const keyName = url.slice(url.lastIndexOf('/') + 1)
    if (url.includes('/encrypt/')) {
      return json(200, { data: { ciphertext: `vault:v1:${keyName}.${body.plaintext as string}` } })
    }
    if (url.includes('/decrypt/')) {
      const stored = (body.ciphertext as string).replace(/^vault:v\d+:/, '')
      const dot = stored.indexOf('.')
      if (stored.slice(0, dot) !== keyName) return json(400, { errors: ['invalid ciphertext: unable to decrypt'] })
      return json(200, { data: { plaintext: stored.slice(dot + 1) } })
    }
    return json(404, { errors: ['no handler'] })
  }
  return { fetchImpl, calls, loginCount: () => loginCount }
}

const TOKEN_OPTS = {
  addr: 'https://vault.example.com',
  key: 'ac-cp',
  orgKeyPrefix: 'ac-cp-org-',
  auth: { method: 'token', token: 't-static' }
} as const

describe('VaultTransitSecretCipher', () => {
  it('seal → transit/encrypt with base64 plaintext; open round-trips utf8', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl: vault.fetchImpl })

    const sealed = await cipher.seal('xoxb-secret-🔐-token', DEPLOYMENT_SCOPE)
    expect(sealed).toMatch(/^acv1:vault:v1:/)
    expect(vault.calls[0]!.url).toBe('https://vault.example.com/v1/transit/encrypt/ac-cp')
    expect(vault.calls[0]!.token).toBe('t-static')
    expect(vault.calls[0]!.body.plaintext).toBe(Buffer.from('xoxb-secret-🔐-token', 'utf8').toString('base64'))

    expect(await cipher.open(sealed, DEPLOYMENT_SCOPE)).toBe('xoxb-secret-🔐-token')
    expect(vault.calls[1]!.url).toBe('https://vault.example.com/v1/transit/decrypt/ac-cp')
  })

  it('open PASSES THROUGH values it did not seal — no network call (lazy migration arm)', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl: vault.fetchImpl })
    expect(await cipher.open('xoxb-legacy-plaintext', ORG_A)).toBe('xoxb-legacy-plaintext')
    expect(vault.calls).toHaveLength(0)
  })

  it('caches open() by ciphertext — the second read costs no request', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl: vault.fetchImpl })
    const sealed = await cipher.seal('sk-1', ORG_A)
    await cipher.open(sealed, ORG_A)
    const callsAfterFirstOpen = vault.calls.length
    expect(await cipher.open(sealed, ORG_A)).toBe('sk-1')
    expect(vault.calls.length).toBe(callsAfterFirstOpen)
  })

  it('honors a custom transit mount and sends the Enterprise namespace header', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({
      ...TOKEN_OPTS,
      mount: 'transit-eu',
      namespace: 'team-a',
      fetchImpl: vault.fetchImpl
    })
    await cipher.seal('v', DEPLOYMENT_SCOPE)
    expect(vault.calls[0]!.url).toBe('https://vault.example.com/v1/transit-eu/encrypt/ac-cp')
    expect(vault.calls[0]!.namespace).toBe('team-a')
  })

  it('jwt auth (k8s-shaped config): logs in once with the SA JWT, reuses the client token, re-logs-in after the lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-vault-'))
    const jwtPath = join(dir, 'token')
    await writeFile(jwtPath, 'sa-jwt\n', 'utf8')
    const vault = fakeVault({ leaseSec: 100 })
    let nowMs = 1_000_000
    const cipher = new VaultTransitSecretCipher({
      addr: 'https://vault.example.com',
      key: 'ac-cp',
      orgKeyPrefix: 'ac-cp-org-',
      auth: { method: 'jwt', role: 'agentconnect-cp', jwtPath, authMount: 'kubernetes' },
      fetchImpl: vault.fetchImpl,
      now: () => nowMs
    })

    await cipher.seal('a', DEPLOYMENT_SCOPE)
    await cipher.seal('b', DEPLOYMENT_SCOPE)
    // One login serves both seals; the login carried the role + trimmed JWT.
    expect(vault.loginCount()).toBe(1)
    const login = vault.calls.find((c) => c.url.endsWith('/auth/kubernetes/login'))!
    expect(login.body).toEqual({ role: 'agentconnect-cp', jwt: 'sa-jwt' })
    expect(vault.calls.at(-1)!.token).toBe('k8s-token-1')

    // Past 80% of the 100s lease ⇒ the next call re-logs-in.
    nowMs += 81_000
    await cipher.seal('c', DEPLOYMENT_SCOPE)
    expect(vault.loginCount()).toBe(2)
    expect(vault.calls.at(-1)!.token).toBe('k8s-token-2')
  })

  it('jwt auth: a 403 (token revoked server-side) triggers ONE re-login retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-vault-'))
    const jwtPath = join(dir, 'token')
    await writeFile(jwtPath, 'sa-jwt', 'utf8')
    const vault = fakeVault({ failFirstWith403: true })
    const cipher = new VaultTransitSecretCipher({
      addr: 'https://vault.example.com',
      key: 'ac-cp',
      orgKeyPrefix: 'ac-cp-org-',
      auth: { method: 'jwt', role: 'r', jwtPath, authMount: 'kubernetes' },
      fetchImpl: vault.fetchImpl
    })

    expect(await cipher.seal('v', DEPLOYMENT_SCOPE)).toMatch(/^acv1:vault:v1:/)
    expect(vault.loginCount()).toBe(2) // initial login + the post-403 re-login
  })

  it('picks the key from the SCOPE: deployment key vs <prefix><orgId> per org', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl: vault.fetchImpl })

    await cipher.seal('d', DEPLOYMENT_SCOPE)
    await cipher.seal('a', ORG_A)
    await cipher.seal('b', ORG_B)

    expect(vault.calls.map((c) => c.url)).toEqual([
      'https://vault.example.com/v1/transit/encrypt/ac-cp',
      'https://vault.example.com/v1/transit/encrypt/ac-cp-org-org-aaa',
      'https://vault.example.com/v1/transit/encrypt/ac-cp-org-org-bbb'
    ])
  })

  it('FAILS CLOSED across scopes: org A ciphertext handed to org B does not decrypt', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl: vault.fetchImpl })
    const sealed = await cipher.seal('org-a-bot-token', ORG_A)

    expect(await cipher.open(sealed, ORG_A)).toBe('org-a-bot-token')
    // The whole reason scope is a parameter: a row fetched for the wrong tenant
    // errors instead of silently handing back another org's plaintext.
    await expect(cipher.open(sealed, ORG_B)).rejects.toThrow(/unable to decrypt/)
    await expect(cipher.open(sealed, DEPLOYMENT_SCOPE)).rejects.toThrow(/unable to decrypt/)
  })

  it('legacy arm: a pre-envelope vault: value opens under the DEPLOYMENT key whatever the scope says', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl: vault.fetchImpl })
    // Shaped like a value sealed before scoping existed: no envelope tag.
    const legacy = 'vault:v1:ac-cp.bGVnYWN5' // "legacy" base64 under the deployment key
    expect(await cipher.open(legacy, ORG_A)).toBe('legacy')
    expect(vault.calls.at(-1)!.url).toBe('https://vault.example.com/v1/transit/decrypt/ac-cp')
  })

  it('the open cache is keyed by KEY + ciphertext, so scopes cannot share an entry', async () => {
    const vault = fakeVault()
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl: vault.fetchImpl })
    const sealed = await cipher.seal('shared-looking', ORG_A)
    await cipher.open(sealed, ORG_A)
    const before = vault.calls.length
    // A different scope must NOT be served the cached plaintext — it must go ask
    // Vault (and be refused). A ciphertext-only cache key would leak here.
    await expect(cipher.open(sealed, ORG_B)).rejects.toThrow()
    expect(vault.calls.length).toBe(before + 1)
  })

  it('errors carry status + Vault errors[], never the secret payload', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ errors: ['permission denied'] }), { status: 403 })
    const cipher = new VaultTransitSecretCipher({ ...TOKEN_OPTS, fetchImpl })
    // token auth has no re-login arm — the 403 surfaces directly.
    const err = await cipher.seal('super-secret-value', DEPLOYMENT_SCOPE).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('403')
    expect((err as Error).message).toContain('permission denied')
    expect((err as Error).message).not.toContain('super-secret-value')
  })
})

describe('makeSecretCipher / SECRET_CIPHER config', () => {
  const BASE_ENV = {
    DATABASE_URL: 'postgresql://x:y@localhost:5432/db',
    API_KEY_PEPPER: 'test-api-key-pepper-0123456789abcdef'
  }

  it('none (default) selects the identity cipher', () => {
    const config = loadConfig({ ...BASE_ENV })
    expect(config.SECRET_CIPHER).toBe('none')
    expect(makeSecretCipher(config)).toBeInstanceOf(PlaintextSecretCipher)
  })

  it('vault-transit + VAULT_TOKEN selects the Vault cipher', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SECRET_CIPHER: 'vault-transit',
      VAULT_ADDR: 'https://vault.example.com',
      VAULT_TOKEN: 't'
    })
    expect(makeSecretCipher(config)).toBeInstanceOf(VaultTransitSecretCipher)
  })

  it('refuses to boot when VAULT_TRANSIT_KEY falls inside the org key prefix', () => {
    // Whatever the cipher mode: the naming mistake is what makes the deployment
    // key shreddable, so it must never reach a running process.
    expect(() =>
      loadConfig({ ...BASE_ENV, VAULT_TRANSIT_KEY: 'ac-org-shared', VAULT_TRANSIT_ORG_KEY_PREFIX: 'ac-org-' })
    ).toThrow()
    expect(() => loadConfig({ ...BASE_ENV, VAULT_TRANSIT_ORG_KEY_PREFIX: '' })).toThrow()
    // The derived default is always safe.
    expect(() => loadConfig({ ...BASE_ENV, VAULT_TRANSIT_KEY: 'ac-cp-prod' })).not.toThrow()
  })

  it('fail-fast: vault-transit without VAULT_ADDR, or with both/neither auth mode', () => {
    expect(() => loadConfig({ ...BASE_ENV, SECRET_CIPHER: 'vault-transit', VAULT_TOKEN: 't' })).toThrow()
    expect(() =>
      loadConfig({ ...BASE_ENV, SECRET_CIPHER: 'vault-transit', VAULT_ADDR: 'https://v.example.com' })
    ).toThrow()
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        SECRET_CIPHER: 'vault-transit',
        VAULT_ADDR: 'https://v.example.com',
        VAULT_TOKEN: 't',
        VAULT_JWT_ROLE: 'r'
      })
    ).toThrow()
  })
})
