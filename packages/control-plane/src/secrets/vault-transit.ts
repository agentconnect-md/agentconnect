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
 * - `open` PASSES THROUGH values it did not seal (no envelope tag ⇒ return
 *   as-is): plaintext rows under `SECRET_CIPHER=none` keep reading, and the next
 *   write seals them — the flip is online, no backfill required. It does NOT
 *   pass through something that is sealed but unreadable here (a pre-scoping
 *   `vault:vN:` value, or a newer envelope version); those throw, because
 *   handing ciphertext back as plaintext is silent corruption.
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

/** A bare Transit ciphertext — what this cipher produced BEFORE scoping existed. */
const LEGACY_CIPHERTEXT_RE = /^vault:v\d+:/
/** Any version of our own envelope, including ones this build predates. */
const ENVELOPE_RE = /^acv\d+:/

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
    // Two arms (docs/designs/per-org-secret-encryption.md §4):
    //   envelope-tagged ⇒ opens under THIS scope's key — a value of another
    //     scope fails here, which is the whole reason scope is a parameter;
    //   anything else ⇒ never sealed, return unchanged (pass-through contract).
    // Everything the pass-through must NOT swallow is rejected first.
    if (!stored.startsWith(SECRET_ENVELOPE_PREFIX)) {
      assertNotUnreadableCiphertext(stored)
      return stored
    }
    const key = this.keyFor(scope)
    const ciphertext = stored.slice(SECRET_ENVELOPE_PREFIX.length)
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

/**
 * The pass-through arm exists for values that were never sealed (plaintext rows
 * under `SECRET_CIPHER=none`). It must never swallow a value that IS sealed but
 * unreadable by this build — returning ciphertext as if it were plaintext is
 * silent corruption: the caller ships it to a daemon or a platform API as a
 * credential. Both cases below are loud instead.
 */
function assertNotUnreadableCiphertext(stored: string): void {
  if (LEGACY_CIPHERTEXT_RE.test(stored)) {
    // Sealed before scoping (docs/designs/per-org-secret-encryption.md §7). The
    // deployment-key fallback that used to read these is gone — it ignored the
    // asserted scope, which was a hole in the cross-tenant fence it only earned
    // by being temporary. Recovering such a value needs a pre-scoping build to
    // run the rewrap sweep first.
    throw new Error('secret cipher: unscoped legacy ciphertext — run the rewrap sweep on a pre-scoping build first')
  }
  if (ENVELOPE_RE.test(stored)) {
    // A NEWER envelope version than this build knows. Happens on a rolling
    // update where a new replica writes and an old one reads; failing here is
    // what keeps that window loud rather than silently wrong.
    throw new Error('secret cipher: stored value uses a newer envelope version than this build supports')
  }
}
