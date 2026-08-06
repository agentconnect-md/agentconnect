/**
 * `VaultTransitSecretCipher` — the HashiCorp Vault Transit implementation of the
 * {@link SecretCipher} seam (docs/designs/secret-store-seams.md §3, §6).
 *
 * Envelope encryption as a service: the data key never leaves Vault; the CP
 * sends base64 plaintext to `transit/encrypt/<key>` and stores the returned
 * ciphertext, behind this deployment's envelope tag, in the existing text
 * columns. WHICH key is chosen comes from the {@link SecretScope} the caller
 * passes — the deployment's key, or `<orgKeyPrefix><orgId>` — so an
 * organization's material can be destroyed with its key
 * (docs/designs/per-org-secret-encryption.md).
 *
 * Contract (pinned on the port):
 * - `open` PASSES THROUGH values it did not seal (neither the envelope tag nor
 *   a bare `vault:vN:` prefix ⇒ return as-is): existing plaintext rows keep
 *   reading after the flip, and the next write re-seals them — the rollout is
 *   online, no backfill required.
 * - A value sealed under one scope does NOT open under another: Transit rejects
 *   a ciphertext presented to a different key, which is the cross-tenant fence.
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
 * `open` results are cached in-process keyed by key name AND ciphertext
 * (bounded, insertion-order eviction): reconcile opens every owned agent's
 * secrets per register, and Transit ciphertexts are stable until re-sealed, so
 * the cache turns that into one network call per distinct value. The key name
 * belongs in the cache key because the stored string alone no longer implies
 * one. `seal` is never cached — Transit returns fresh ciphertext per call by
 * design.
 */
import type { SecretCipher } from './cipher.js'
import { SECRET_ENVELOPE_PREFIX, type SecretScope } from './scope.js'
import { describeVaultError, VaultHttp, type FetchLike, type VaultAuth } from './vault-http.js'

/** The auth shape now lives in `vault-http.ts`; re-exported for existing callers. */
export type VaultTransitAuth = VaultAuth

export interface VaultTransitOpts {
  /** Vault origin, e.g. `https://vault.example.com:8200`. */
  addr: string
  /** Deployment-scope transit key name (`transit/encrypt/<key>`). */
  key: string
  /** Org-scope key names are this prefix + the org id. MUST NOT prefix `key`. */
  orgKeyPrefix: string
  /** Transit engine mount path (default `transit`). */
  mount?: string
  /** Vault Enterprise namespace (sent as `X-Vault-Namespace`). */
  namespace?: string
  auth: VaultAuth
  /** Test seams. */
  fetchImpl?: FetchLike
  now?: () => number
  /** Max cached `open` results (default 5000 — far above the fleet's secret count). */
  openCacheMax?: number
}

/** Transit ciphertext is self-describing: `vault:v<key-version>:<base64>`. */
const CIPHERTEXT_RE = /^vault:v\d+:/

export class VaultTransitSecretCipher implements SecretCipher {
  private readonly http: VaultHttp
  private readonly key: string
  private readonly orgKeyPrefix: string
  private readonly mount: string
  private readonly openCacheMax: number

  private readonly openCache = new Map<string, string>()

  constructor(opts: VaultTransitOpts) {
    this.http = new VaultHttp({
      addr: opts.addr,
      namespace: opts.namespace,
      auth: opts.auth,
      fetchImpl: opts.fetchImpl,
      now: opts.now
    })
    this.key = opts.key
    this.orgKeyPrefix = opts.orgKeyPrefix
    this.mount = opts.mount ?? 'transit'
    this.openCacheMax = opts.openCacheMax ?? 5000
  }

  /**
   * The key a scope resolves to. Org keys are created lazily by Transit on the
   * first encrypt (the policy must permit creation on that path); nothing here
   * is coupled to organization creation.
   */
  private keyFor(scope: SecretScope): string {
    return scope.kind === 'deployment' ? this.key : `${this.orgKeyPrefix}${scope.orgId}`
  }

  async seal(plaintext: string, scope: SecretScope): Promise<string> {
    const data = await this.transit('encrypt', this.keyFor(scope), {
      plaintext: Buffer.from(plaintext, 'utf8').toString('base64')
    })
    if (typeof data.ciphertext !== 'string') throw new Error('vault transit encrypt: no ciphertext in response')
    return `${SECRET_ENVELOPE_PREFIX}${data.ciphertext}`
  }

  async open(stored: string, scope: SecretScope): Promise<string> {
    // Three arms, in order (docs/designs/per-org-secret-encryption.md §4):
    //   envelope-tagged ⇒ scoped value, opens under THIS scope's key — a value
    //     of another scope fails here, which is the reason scope is a parameter;
    //   bare `vault:vN:` ⇒ sealed before scoping existed, opens under the
    //     deployment key regardless of scope (the migration arm, §7);
    //   anything else ⇒ never sealed, return unchanged (pass-through contract).
    const scoped = stored.startsWith(SECRET_ENVELOPE_PREFIX)
    if (!scoped && !CIPHERTEXT_RE.test(stored)) return stored
    const key = scoped ? this.keyFor(scope) : this.key
    const ciphertext = scoped ? stored.slice(SECRET_ENVELOPE_PREFIX.length) : stored
    // Cache by KEY + ciphertext: the stored string no longer implies a key, and
    // two scopes must never share an entry.
    const cacheKey = `${key}\u0000${ciphertext}`
    const hit = this.openCache.get(cacheKey)
    if (hit !== undefined) return hit
    const data = await this.transit('decrypt', key, { ciphertext })
    if (typeof data.plaintext !== 'string') throw new Error('vault transit decrypt: no plaintext in response')
    const value = Buffer.from(data.plaintext, 'base64').toString('utf8')
    this.cacheOpen(cacheKey, value)
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
    key: string,
    body: Record<string, string>
  ): Promise<{ ciphertext?: string; plaintext?: string }> {
    const res = await this.http.request('POST', `${this.mount}/${op}/${key}`, body)
    if (!res.ok) throw new Error(`vault transit ${op} failed: ${await describeVaultError(res)}`)
    const json = (await res.json()) as { data?: { ciphertext?: string; plaintext?: string } }
    return json.data ?? {}
  }
}
