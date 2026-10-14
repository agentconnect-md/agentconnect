// Uploaded-icon bytes in a vendor-neutral S3-compatible store, gated on the full `S3_*` config (docs/designs/icon-uploads.md).
import {
  addressFor,
  amzDate,
  canonicalUri,
  sha256Hex,
  signHeaders,
  type BucketAddressing
} from '@agentconnect.md/object-store'

export interface IconStoreConfig {
  endpoint: string // full S3 API origin, e.g. https://objects.example.test
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  region: string // provider-specific region identifier
  publicBaseUrl: string // the origin objects are served from (custom domain / CDN)
}

export interface IconStore {
  /** Overwrite the object at `key` with `bytes` (path-style PUT). Throws on non-2xx. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** Read the object at `key` for a platform profile sync. Null means absent. */
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  /** Delete the object at `key`. A 404 is treated as success (idempotent). */
  delete(key: string): Promise<void>
  /** The public URL an `<img>`/Slack fetches. `version` cache-busts (e.g. updatedAt epoch). */
  publicUrl(key: string, version?: string | number): string
}

/** S3 object keys for icon owners, namespaced under `icon/`. Stable per owner —
 *  a re-upload overwrites the same key. */
export const agentIconKey = (agentId: string) => `icon/agents/${agentId}`
export const orgIconKey = (orgId: string) => `icon/orgs/${orgId}`
export const profilePictureKey = (userId: string) => `icon/profiles/${userId}`

/** The profile photo visible in the console: a user-uploaded image wins over the
 * OIDC provider's `picture` claim, while the latter remains the fallback after a
 * custom image is removed. */
export function resolveProfilePictureUrl(
  userId: string,
  oidcPicture: string | null,
  profilePictureUpdatedAt: Date | null,
  store?: IconStore
): string | null {
  return profilePictureUpdatedAt && store
    ? store.publicUrl(profilePictureKey(userId), profilePictureUpdatedAt.getTime())
    : oidcPicture
}

/** Build the public serve URL for `key` under `publicBase`, with an optional `?v=`
 *  cache-buster. Shared by the store's `publicUrl` and the icon-URL resolver so the
 *  key encoding lives in one place. */
export function joinPublicUrl(publicBase: string, key: string, version?: string | number): string {
  const base = publicBase.replace(/\/+$/, '')
  const path = key.split('/').map(encodeURIComponent).join('/')
  const v = version !== undefined ? `?v=${encodeURIComponent(String(version))}` : ''
  return `${base}/${path}${v}`
}

export interface IconStoreDeps {
  fetch?: typeof fetch
  now?: () => number
}

class S3IconStore implements IconStore {
  private readonly address: BucketAddressing
  private readonly basePath: string // the endpoint's own path, then /<bucket>/
  private readonly publicBase: string
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly cfg: IconStoreConfig,
    deps: IconStoreDeps
  ) {
    // Always path style, as before: a local store has no per-bucket DNS.
    this.address = addressFor(cfg.endpoint, cfg.bucket, true)
    this.basePath = `${new URL(cfg.endpoint).pathname.replace(/\/+$/, '')}${this.address.basePath}`
    this.publicBase = cfg.publicBaseUrl.replace(/\/+$/, '')
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  private async send(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const path = `${this.basePath}${key}`
    const payloadHash = sha256Hex(Buffer.from(body ?? new Uint8Array()))
    const headers = { ...extraHeaders, 'x-amz-date': amzDate(this.now()), 'x-amz-content-sha256': payloadHash }
    const { authorization } = signHeaders({
      method,
      protocol: this.address.protocol,
      host: this.address.host,
      path,
      headers,
      credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
      region: this.cfg.region,
      datetime: headers['x-amz-date'],
      payloadHash
    })
    return await this.fetch(`${this.address.protocol}//${this.address.host}${canonicalUri(path)}`, {
      method,
      headers: { ...headers, authorization },
      ...(body ? { body } : {})
    })
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    // The stored content-type is the served one; `nosniff` on `icon/*` is the deployment's CDN/bucket config.
    const res = await this.send('PUT', key, bytes, { 'content-type': contentType })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`icon store PUT ${key} failed: ${res.status} ${detail.slice(0, 200)}`)
    }
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const res = await this.send('GET', key)
    if (res.status === 404) return null
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`icon store GET ${key} failed: ${res.status} ${detail.slice(0, 200)}`)
    }
    const contentType = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (!contentType) throw new Error(`icon store GET ${key} returned no content type`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType }
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key)
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => '')
      throw new Error(`icon store DELETE ${key} failed: ${res.status} ${detail.slice(0, 200)}`)
    }
  }

  publicUrl(key: string, version?: string | number): string {
    return joinPublicUrl(this.publicBase, key, version)
  }
}

export function createIconStore(cfg: IconStoreConfig, deps: IconStoreDeps = {}): IconStore {
  return new S3IconStore(cfg, deps)
}
