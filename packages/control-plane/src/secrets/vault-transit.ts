/**
 * `VaultTransitSecretCipher` — the HashiCorp Vault Transit implementation of the
 * {@link SecretCipher} seam (docs/designs/secret-store-seams.md §3, §6).
 *
 * Envelope encryption as a service: the data key never leaves Vault; the CP
 * sends base64 plaintext to `transit/encrypt/<key>` and stores the returned
 * self-describing `vault:vN:…` ciphertext in the existing text columns.
 *
 * Contract (pinned on the port):
 * - `open` PASSES THROUGH values it did not seal (no `vault:vN:` prefix ⇒
 *   return as-is): existing plaintext rows keep reading after the flip, and the
 *   next write re-seals them — the rollout is online, no backfill required.
 * - No argument or response body is ever logged; errors carry only the HTTP
 *   status and Vault's `errors[]` strings.
 *
 * Auth is either a static token, or a workload JWT read from a file and
 * exchanged for a client token at `auth/<mount>/login` — re-logged-in before
 * the lease runs out (single-flight) and once more on a 403 (revoked/expired
 * server-side). Vault's `kubernetes` and generic `jwt`/OIDC auth methods share
 * that exact login wire shape ({role, jwt}), so nothing here is bound to
 * Kubernetes — a k8s ServiceAccount token is just the common jwtPath.
 *
 * `open` results are cached in-process keyed by ciphertext (bounded, insertion-
 * order eviction): reconcile opens every owned agent's secrets per register, and
 * Transit ciphertexts are stable until re-sealed, so the cache turns that into
 * one network call per distinct value. `seal` is never cached — Transit returns
 * fresh ciphertext per call by design.
 */
import { readFile } from 'node:fs/promises'
import type { SecretCipher } from './cipher.js'

type FetchLike = typeof fetch

export type VaultTransitAuth =
  { method: 'token'; token: string } | { method: 'jwt'; role: string; jwtPath: string; authMount: string }

export interface VaultTransitOpts {
  /** Vault origin, e.g. `https://vault.example.com:8200`. */
  addr: string
  /** Transit key name (`transit/encrypt/<key>`). */
  key: string
  /** Transit engine mount path (default `transit`). */
  mount?: string
  /** Vault Enterprise namespace (sent as `X-Vault-Namespace`). */
  namespace?: string
  auth: VaultTransitAuth
  /** Test seams. */
  fetchImpl?: FetchLike
  now?: () => number
  /** Max cached `open` results (default 5000 — far above the fleet's secret count). */
  openCacheMax?: number
}

/** Transit ciphertext is self-describing: `vault:v<key-version>:<base64>`. */
const CIPHERTEXT_RE = /^vault:v\d+:/

/** Renew the JWT login after 80% of the lease (floor 10s so a tiny lease can't thrash). */
const RENEW_FRACTION = 0.8

export class VaultTransitSecretCipher implements SecretCipher {
  private readonly base: string
  private readonly key: string
  private readonly mount: string
  private readonly namespace: string | undefined
  private readonly auth: VaultTransitAuth
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly openCacheMax: number

  private readonly openCache = new Map<string, string>()
  private clientToken: { value: string; renewAtMs: number } | undefined
  private loginInFlight: Promise<string> | undefined

  constructor(opts: VaultTransitOpts) {
    this.base = `${opts.addr.replace(/\/+$/, '')}/v1`
    this.key = opts.key
    this.mount = opts.mount ?? 'transit'
    this.namespace = opts.namespace
    this.auth = opts.auth
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
    this.openCacheMax = opts.openCacheMax ?? 5000
  }

  async seal(plaintext: string): Promise<string> {
    const data = await this.transit('encrypt', {
      plaintext: Buffer.from(plaintext, 'utf8').toString('base64')
    })
    if (typeof data.ciphertext !== 'string') throw new Error('vault transit encrypt: no ciphertext in response')
    return data.ciphertext
  }

  async open(stored: string): Promise<string> {
    // The pass-through arm of the contract: a value without the transit prefix
    // was never sealed (legacy plaintext row) — return it unchanged.
    if (!CIPHERTEXT_RE.test(stored)) return stored
    const hit = this.openCache.get(stored)
    if (hit !== undefined) return hit
    const data = await this.transit('decrypt', { ciphertext: stored })
    if (typeof data.plaintext !== 'string') throw new Error('vault transit decrypt: no plaintext in response')
    const value = Buffer.from(data.plaintext, 'base64').toString('utf8')
    this.cacheOpen(stored, value)
    return value
  }

  private cacheOpen(ciphertext: string, plaintext: string): void {
    if (this.openCache.size >= this.openCacheMax) {
      // Bounded, oldest-inserted-first — plenty for a stable working set.
      const oldest = this.openCache.keys().next().value
      if (oldest !== undefined) this.openCache.delete(oldest)
    }
    this.openCache.set(ciphertext, plaintext)
  }

  private async transit(
    op: 'encrypt' | 'decrypt',
    body: Record<string, string>
  ): Promise<{ ciphertext?: string; plaintext?: string }> {
    const path = `${this.mount}/${op}/${this.key}`
    let res = await this.post(path, body, await this.token())
    if (res.status === 403 && this.auth.method === 'jwt') {
      // Client token revoked/expired server-side — drop it, re-login, retry ONCE.
      this.clientToken = undefined
      res = await this.post(path, body, await this.token())
    }
    if (!res.ok) throw new Error(`vault transit ${op} failed: ${await describeError(res)}`)
    const json = (await res.json()) as { data?: { ciphertext?: string; plaintext?: string } }
    return json.data ?? {}
  }

  private post(path: string, body: unknown, token: string): Promise<Response> {
    return this.fetchImpl(`${this.base}/${path}`, {
      method: 'POST',
      headers: {
        'X-Vault-Token': token,
        'content-type': 'application/json',
        ...(this.namespace ? { 'X-Vault-Namespace': this.namespace } : {})
      },
      body: JSON.stringify(body)
    })
  }

  private token(): Promise<string> | string {
    if (this.auth.method === 'token') return this.auth.token
    if (this.clientToken && this.now() < this.clientToken.renewAtMs) return this.clientToken.value
    // Single-flight: concurrent seals/opens during (re-)login share one exchange.
    this.loginInFlight ??= this.jwtLogin(this.auth).finally(() => {
      this.loginInFlight = undefined
    })
    return this.loginInFlight
  }

  private async jwtLogin(auth: Extract<VaultTransitAuth, { method: 'jwt' }>): Promise<string> {
    const jwt = (await readFile(auth.jwtPath, 'utf8')).trim()
    const res = await this.fetchImpl(`${this.base}/auth/${auth.authMount}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.namespace ? { 'X-Vault-Namespace': this.namespace } : {})
      },
      body: JSON.stringify({ role: auth.role, jwt })
    })
    if (!res.ok) throw new Error(`vault jwt login failed: ${await describeError(res)}`)
    const json = (await res.json()) as { auth?: { client_token?: string; lease_duration?: number } }
    const token = json.auth?.client_token
    if (!token) throw new Error('vault jwt login: no client_token in response')
    const leaseMs = (json.auth?.lease_duration ?? 3600) * 1000
    this.clientToken = { value: token, renewAtMs: this.now() + Math.max(leaseMs * RENEW_FRACTION, 10_000) }
    return token
  }
}

/** Status + Vault's `errors[]` only — NEVER the request/response payloads. */
async function describeError(res: Response): Promise<string> {
  let errors = ''
  try {
    const json = (await res.json()) as { errors?: string[] }
    if (Array.isArray(json.errors) && json.errors.length > 0) errors = ` (${json.errors.join('; ')})`
  } catch {
    // non-JSON error body — status alone is enough (and never echo the body)
  }
  return `HTTP ${res.status}${errors}`
}
