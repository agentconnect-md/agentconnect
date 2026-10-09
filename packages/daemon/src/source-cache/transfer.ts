import { createHash, randomUUID } from 'node:crypto'
import { SOURCE_CACHE_GRACE_SECONDS, sourceCacheEndpoint, type SourceCacheConfig } from './config.js'
import type { CredentialsProvider } from './credentials.js'
import type { SourceCacheObjectClient } from './object-client.js'
import { addressFor, PENDING_TAGGING } from './presigner.js'
import { amzDate, presign } from './sigv4.js'

// Console file transfer through the Source Cache bucket (source-cache-file-transfer.md): uploads in, workspace files out.

/** A key under `src/<org>/transfer/`, built only here; `pending`-tagged, so the bucket's 2-day rule collects it. */
export type TransferObjectKey = string & { readonly __transferObjectKey: true }

const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TRANSFER_KEY_RE = /^src\/[A-Za-z0-9_-]{1,64}\/transfer\/(?:up\/[0-9a-f-]{36}|dl\/[0-9a-f]{64})$/
const CHECKSUM_RE = /^[A-Za-z0-9+/]{43}=$/
/** A cached download is reused only while it is well inside the 2-day `pending` lifecycle rule. */
const CACHED_DOWNLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000

function assertOrg(org: string): void {
  if (!ORG_RE.test(org)) throw new Error('org must be 1-64 characters of [A-Za-z0-9_-]')
}

/** `src/<org>/transfer/up/<uuid>`: one browser upload. */
export function transferUploadKey(org: string, uploadId: string): TransferObjectKey {
  assertOrg(org)
  if (!UUID_RE.test(uploadId)) throw new Error('upload id must be a lower-case v4 UUID')
  return `src/${org}/transfer/up/${uploadId}` as TransferObjectKey
}

/** `src/<org>/transfer/dl/<sha256(identity)>`: one revision of one workspace file. */
export function transferDownloadKey(org: string, identity: readonly unknown[]): TransferObjectKey {
  assertOrg(org)
  const digest = createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex')
  return `src/${org}/transfer/dl/${digest}` as TransferObjectKey
}

export function isTransferObjectKey(key: unknown): key is TransferObjectKey {
  return typeof key === 'string' && TRANSFER_KEY_RE.test(key)
}

/** RFC 6266 attachment disposition with an ASCII fallback, as the CP's own download answers. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

export interface TransferUrl {
  url: string
  headers: Record<string, string>
  expiresAt: number
}

export interface FileTransferDeps {
  config: SourceCacheConfig
  credentials: CredentialsProvider
  objects: SourceCacheObjectClient
  /** False while the bucket lacks its lifecycle rules: nothing would ever collect a transfer. */
  enabled: () => boolean
  now?: () => number
  /** Test seam: endpoints the config schema would refuse (plain-http fixtures). */
  endpointOverride?: { internal?: string; public?: string }
}

export interface FileTransfer {
  enabled(): boolean
  maxBytes: number
  /** Reserve a key and presign the browser's PUT for exactly this length and digest. */
  grantUpload(input: { org: string; size: number; sha256: string }): Promise<TransferUrl & { uploadId: string }>
  /** Presign the agent's GET for an upload, or undefined when the bucket does not hold exactly those bytes. */
  uploadedFileUrl(input: {
    org: string
    uploadId: string
    size: number
    sha256: string
  }): Promise<TransferUrl | undefined>
  /** Presign the browser's GET for one workspace file revision, uploading it first unless a recent copy is there. */
  workspaceFileUrl(input: {
    org: string
    identity: readonly unknown[]
    name: string
    size: number
    upload: (
      put: (file: { bytes: number; sha256: string }) => Promise<TransferUrl>
    ) => Promise<{ bytes: number; sha256: string }>
  }): Promise<TransferUrl & { cached: boolean; sha256: string }>
}

/** A refusal the console can act on; `reason` is the workspace error reason the daemon answers with. */
export class FileTransferError extends Error {
  constructor(
    readonly reason: 'too-large' | 'transfer-unavailable' | 'stale',
    message: string
  ) {
    super(message)
    this.name = 'FileTransferError'
  }
}

export function createFileTransfer(deps: FileTransferDeps): FileTransfer {
  const { config, credentials, objects } = deps
  const now = deps.now ?? Date.now
  const internal = addressFor(
    deps.endpointOverride?.internal ?? sourceCacheEndpoint(config),
    config.bucket,
    config.forcePathStyle
  )
  // Browser URLs name the origin a browser can reach; the agent's pod reaches the same store at the internal one.
  const browser = addressFor(
    deps.endpointOverride?.public ?? config.publicEndpoint ?? sourceCacheEndpoint(config),
    config.bucket,
    config.forcePathStyle
  )
  const { transferMaxBytes, transferUrlSeconds, putUrlSeconds } = config.limits

  const sign = async (input: {
    method: 'GET' | 'PUT'
    key: TransferObjectKey
    address: ReturnType<typeof addressFor>
    lifetimeSeconds: number
    headers?: Record<string, string>
    query?: Record<string, string>
  }): Promise<TransferUrl> => {
    if (!isTransferObjectKey(input.key)) throw new Error('not a transfer key')
    const creds = await credentials.get((input.lifetimeSeconds + SOURCE_CACHE_GRACE_SECONDS) * 1000)
    const signedAt = now()
    const headers = input.headers ?? {}
    const { url } = presign({
      method: input.method,
      protocol: input.address.protocol,
      host: input.address.host,
      path: `${input.address.basePath}${config.prefix ? `${config.prefix}/` : ''}${input.key}`,
      headers,
      ...(input.query ? { query: input.query } : {}),
      credentials: creds,
      region: config.region,
      datetime: amzDate(signedAt),
      expiresSeconds: input.lifetimeSeconds
    })
    return {
      url,
      headers: { ...headers },
      expiresAt: Math.floor(signedAt / 1000) * 1000 + input.lifetimeSeconds * 1000
    }
  }

  const putHeaders = (bytes: number, sha256: string): Record<string, string> => {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > transferMaxBytes) {
      throw new FileTransferError('too-large', `a transfer must be 1 byte to ${transferMaxBytes} bytes`)
    }
    if (!CHECKSUM_RE.test(sha256) || Buffer.from(sha256, 'base64').length !== 32) {
      throw new Error('transfer checksum must be a base64 SHA-256')
    }
    return { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256, 'x-amz-tagging': PENDING_TAGGING }
  }

  const assertEnabled = (): void => {
    if (!deps.enabled()) throw new FileTransferError('transfer-unavailable', 'the bucket lacks its lifecycle rules')
  }

  return {
    enabled: () => deps.enabled(),
    maxBytes: transferMaxBytes,

    async grantUpload({ org, size, sha256 }) {
      assertEnabled()
      const uploadId = randomUUID()
      const key = transferUploadKey(org, uploadId)
      const put = await sign({
        method: 'PUT',
        key,
        address: browser,
        lifetimeSeconds: putUrlSeconds,
        headers: putHeaders(size, sha256)
      })
      return { ...put, uploadId }
    },

    async uploadedFileUrl({ org, uploadId, size, sha256 }) {
      const key = transferUploadKey(org, uploadId)
      const head = await objects.head(key)
      // The PUT signed the checksum, so a matching one proves these bytes; a store that omits it is trusted on length alone.
      if (!head.exists || head.contentLength !== size) return undefined
      if (head.checksumSha256 !== undefined && head.checksumSha256 !== sha256) return undefined
      return await sign({ method: 'GET', key, address: internal, lifetimeSeconds: transferUrlSeconds })
    },

    async workspaceFileUrl({ org, identity, name, size, upload }) {
      assertEnabled()
      if (size < 1 || size > transferMaxBytes) {
        throw new FileTransferError('too-large', `a transfer must be 1 byte to ${transferMaxBytes} bytes`)
      }
      const key = transferDownloadKey(org, identity)
      const head = await objects.head(key)
      // A copy without its checksum cannot prove which bytes it holds, so it is replaced rather than reused.
      const cached =
        head.exists &&
        head.contentLength === size &&
        (head.lastModified === undefined || head.lastModified > now() - CACHED_DOWNLOAD_MAX_AGE_MS)
          ? head.checksumSha256
          : undefined
      let sha256 = cached
      if (sha256 === undefined) {
        const sent = await upload(async (file) =>
          sign({
            method: 'PUT',
            key,
            address: internal,
            lifetimeSeconds: putUrlSeconds,
            headers: putHeaders(file.bytes, file.sha256)
          })
        )
        if (sent.bytes !== size) throw new FileTransferError('stale', 'the file changed while it was uploaded')
        sha256 = sent.sha256
      }
      const get = await sign({
        method: 'GET',
        key,
        address: browser,
        lifetimeSeconds: transferUrlSeconds,
        query: {
          'response-content-disposition': attachmentDisposition(name),
          'response-content-type': 'application/octet-stream'
        }
      })
      return { ...get, cached: cached !== undefined, sha256 }
    }
  }
}
