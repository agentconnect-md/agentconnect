/**
 * `icons/icon-store.ts` — the uploaded-icon object store (docs/designs/icon-uploads.md).
 *
 * A neutral S3-compatible client (SigV4 over `aws4fetch`), never bound to a vendor:
 * hosted services and local development stores differ only by the configured
 * `endpoint`. Uploaded icon bytes live here, NOT in Postgres; the
 * agent/org row keeps only the image descriptor (plus an optional opaque generation),
 * and the display/serve URL is the store's public URL for the owner's key
 * (→ `<img src>` + Slack icon_url).
 *
 * Assembled ONLY when the full `S3_*` config is present (see container.ts). Absent ⇒
 * `undefined`, the upload routes are not mounted, and the console hides Upload.
 */
import { AwsClient } from 'aws4fetch'

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

class S3IconStore implements IconStore {
  private readonly aws: AwsClient
  private readonly base: string // endpoint/bucket, no trailing slash
  private readonly publicBase: string

  constructor(cfg: IconStoreConfig) {
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: 's3'
    })
    this.base = `${cfg.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(cfg.bucket)}`
    this.publicBase = cfg.publicBaseUrl.replace(/\/+$/, '')
  }

  private objectUrl(key: string): string {
    // Path-style; encode each segment but keep the `/` separators.
    const path = key.split('/').map(encodeURIComponent).join('/')
    return `${this.base}/${path}`
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    // `content-type` becomes the object's stored type and its served `Content-Type`,
    // pinning every object to a (server-sniffed) image type. Note PutObject cannot set
    // arbitrary RESPONSE headers on the public path — `X-Content-Type-Options: nosniff`
    // for `icon/*` is enforced by deployment-specific CDN/bucket configuration.
    const res = await this.aws.fetch(this.objectUrl(key), {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': contentType }
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`icon store PUT ${key} failed: ${res.status} ${detail.slice(0, 200)}`)
    }
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const res = await this.aws.fetch(this.objectUrl(key))
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
    const res = await this.aws.fetch(this.objectUrl(key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => '')
      throw new Error(`icon store DELETE ${key} failed: ${res.status} ${detail.slice(0, 200)}`)
    }
  }

  publicUrl(key: string, version?: string | number): string {
    return joinPublicUrl(this.publicBase, key, version)
  }
}

export function createIconStore(cfg: IconStoreConfig): IconStore {
  return new S3IconStore(cfg)
}
