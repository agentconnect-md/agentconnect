/**
 * `VaultHttp` — the authenticated request plumbing every Vault caller in the CP
 * shares: token or workload-JWT login, single-flight re-login before the lease
 * runs out, one retry after a 403 (revoked/expired server-side), the Enterprise
 * namespace header, and the never-echo-payloads error discipline.
 *
 * Extracted so the {@link VaultTransitSecretCipher} and the shred CLI's key
 * destroyer (docs/designs/per-org-secret-encryption.md §6) share one
 * implementation rather than two copies that drift. They deliberately do NOT
 * share a credential: the destroyer runs as its own workload under its own
 * identity, because a Vault role binds to a service account and a second role
 * bound to the CP's account would be reachable from the CP itself.
 *
 * Never logs a request or response body; errors carry the HTTP status and
 * Vault's `errors[]` strings only.
 */
import { readFile } from 'node:fs/promises'

export type FetchLike = typeof fetch

export type VaultAuth =
  { method: 'token'; token: string } | { method: 'jwt'; role: string; jwtPath: string; authMount: string }

export interface VaultHttpOpts {
  /** Vault origin, e.g. `https://vault.example.com:8200`. */
  addr: string
  /** Vault Enterprise namespace (sent as `X-Vault-Namespace`). */
  namespace?: string | undefined
  auth: VaultAuth
  /** Test seams. */
  fetchImpl?: FetchLike | undefined
  now?: (() => number) | undefined
}

/** Renew the JWT login after 80% of the lease (floor 10s so a tiny lease can't thrash). */
const RENEW_FRACTION = 0.8

export class VaultHttp {
  private readonly base: string
  private readonly namespace: string | undefined
  private readonly auth: VaultAuth
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  private clientToken: { value: string; renewAtMs: number } | undefined
  private loginInFlight: Promise<string> | undefined

  constructor(opts: VaultHttpOpts) {
    this.base = `${opts.addr.replace(/\/+$/, '')}/v1`
    this.namespace = opts.namespace
    this.auth = opts.auth
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
  }

  /**
   * One authenticated call, with the 403 re-login retry. `body` is omitted for
   * verbs that carry none (DELETE). Returns the raw `Response`; callers decide
   * what a non-2xx means for them.
   */
  async request(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    let res = await this.send(method, path, body, await this.token())
    if (res.status === 403 && this.auth.method === 'jwt') {
      // Client token revoked/expired server-side — drop it, re-login, retry ONCE.
      this.clientToken = undefined
      res = await this.send(method, path, body, await this.token())
    }
    return res
  }

  private send(method: 'POST' | 'DELETE', path: string, body: unknown, token: string): Promise<Response> {
    return this.fetchImpl(`${this.base}/${path}`, {
      method,
      headers: {
        'X-Vault-Token': token,
        'content-type': 'application/json',
        ...(this.namespace ? { 'X-Vault-Namespace': this.namespace } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }

  private token(): Promise<string> | string {
    if (this.auth.method === 'token') return this.auth.token
    if (this.clientToken && this.now() < this.clientToken.renewAtMs) return this.clientToken.value
    // Single-flight: concurrent callers during (re-)login share one exchange.
    this.loginInFlight ??= this.jwtLogin(this.auth).finally(() => {
      this.loginInFlight = undefined
    })
    return this.loginInFlight
  }

  private async jwtLogin(auth: Extract<VaultAuth, { method: 'jwt' }>): Promise<string> {
    const jwt = (await readFile(auth.jwtPath, 'utf8')).trim()
    const res = await this.fetchImpl(`${this.base}/auth/${auth.authMount}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.namespace ? { 'X-Vault-Namespace': this.namespace } : {})
      },
      body: JSON.stringify({ role: auth.role, jwt })
    })
    if (!res.ok) throw new Error(`vault jwt login failed: ${await describeVaultError(res)}`)
    const json = (await res.json()) as { auth?: { client_token?: string; lease_duration?: number } }
    const token = json.auth?.client_token
    if (!token) throw new Error('vault jwt login: no client_token in response')
    const leaseMs = (json.auth?.lease_duration ?? 3600) * 1000
    this.clientToken = { value: token, renewAtMs: this.now() + Math.max(leaseMs * RENEW_FRACTION, 10_000) }
    return token
  }
}

/** Vault's `errors[]` strings — empty for a non-JSON or non-Vault body, which is never echoed. */
export async function readVaultErrors(res: Response): Promise<string[]> {
  try {
    const json = (await res.json()) as { errors?: unknown }
    return Array.isArray(json.errors) ? json.errors.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}

/** Status + Vault's `errors[]` only — NEVER the request/response payloads. */
export function formatVaultError(status: number, errors: string[]): string {
  return `HTTP ${status}${errors.length > 0 ? ` (${errors.join('; ')})` : ''}`
}

/** {@link readVaultErrors} + {@link formatVaultError} for callers that only need the message. */
export async function describeVaultError(res: Response): Promise<string> {
  return formatVaultError(res.status, await readVaultErrors(res))
}
