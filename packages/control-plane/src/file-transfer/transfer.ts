import { createHash, randomUUID } from 'node:crypto'
import type { TransferNetwork } from '@agentconnect.md/protocol'
import {
  addressFor,
  amzDate,
  bucketEndpoint,
  presign,
  SOURCE_CACHE_GRACE_SECONDS,
  type CredentialsProvider,
  type SourceCacheObjectClient
} from '@agentconnect.md/object-store'
import type { FileTransferConfig } from './config.js'

// Console file transfer (source-cache-file-transfer.md): the control plane signs every URL; bytes go straight to the bucket.

/** The tag the bucket's 2-day `pending` lifecycle rule collects (source-cache.md §10). */
const PENDING_TAGGING = 'ac-cache=pending'

/** A key under `src/<org>/transfer/`, built only here; `pending`-tagged, so the bucket's 2-day rule collects it. */
export type TransferObjectKey = string & { readonly __transferObjectKey: true }

const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TRANSFER_KEY_RE =
  /^src\/[A-Za-z0-9_-]{1,64}\/transfer\/(?:up\/[0-9a-f-]{36}|dl\/[0-9a-f]{64}|img\/[0-9a-f-]{36}\/[0-9a-f-]{36})$/
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

/** `src/<org>/transfer/img/<agentId>/<attachmentId>`: one shared image's original (webchat-generated-images.md §5). */
export function sharedImageKey(org: string, agentId: string, attachmentId: string): TransferObjectKey {
  assertOrg(org)
  if (!ANY_UUID_RE.test(agentId) || !ANY_UUID_RE.test(attachmentId)) {
    throw new Error('agent and attachment ids must be lower-case UUIDs')
  }
  return `src/${org}/transfer/img/${agentId}/${attachmentId}` as TransferObjectKey
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
  config: FileTransferConfig
  credentials: CredentialsProvider
  objects: Pick<SourceCacheObjectClient<TransferObjectKey>, 'head'>
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
    network: TransferNetwork
  }): Promise<TransferUrl | undefined>
  /** The digest of a recent copy of this revision, or undefined when it has to be uploaded first. */
  cachedDownload(input: { key: TransferObjectKey; size: number }): Promise<string | undefined>
  /** Presign a daemon's PUT of a snapshot of exactly these bytes. */
  signPut(input: {
    key: TransferObjectKey
    bytes: number
    sha256: string
    network: TransferNetwork
  }): Promise<TransferUrl>
  /** Presign the browser's GET that downloads the object as an attachment named `name`. */
  signDownload(input: { key: TransferObjectKey; name: string }): Promise<TransferUrl>
  /** Presign the GET of a shared image's original while the bucket holds exactly those bytes; no reuse cutoff applies. */
  storedDownload(input: {
    key: TransferObjectKey
    size: number
    sha256: string
    name: string
  }): Promise<TransferUrl | undefined>
}

/** A refusal the console can act on; `reason` mirrors the workspace error reasons. */
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
    deps.endpointOverride?.internal ?? bucketEndpoint(config),
    config.bucket,
    config.forcePathStyle
  )
  // Browsers and daemons outside the cluster reach the bucket at its public origin; sandbox pods at the internal one.
  const external = addressFor(
    deps.endpointOverride?.public ?? config.publicEndpoint ?? bucketEndpoint(config),
    config.bucket,
    config.forcePathStyle
  )
  const addressOn = (network: TransferNetwork) => (network === 'cluster' ? internal : external)
  const { maxBytes, urlSeconds, putUrlSeconds } = config.limits

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
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes) {
      throw new FileTransferError('too-large', `a transfer must be 1 byte to ${maxBytes} bytes`)
    }
    if (!CHECKSUM_RE.test(sha256) || Buffer.from(sha256, 'base64').length !== 32) {
      throw new Error('transfer checksum must be a base64 SHA-256')
    }
    return { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256, 'x-amz-tagging': PENDING_TAGGING }
  }

  const signDownload = async ({ key, name }: { key: TransferObjectKey; name: string }): Promise<TransferUrl> =>
    await sign({
      method: 'GET',
      key,
      address: external,
      lifetimeSeconds: urlSeconds,
      query: {
        'response-content-disposition': attachmentDisposition(name),
        'response-content-type': 'application/octet-stream'
      }
    })

  const assertEnabled = (): void => {
    if (!deps.enabled()) throw new FileTransferError('transfer-unavailable', 'the bucket lacks its lifecycle rules')
  }

  return {
    enabled: () => deps.enabled(),
    maxBytes,

    async grantUpload({ org, size, sha256 }) {
      assertEnabled()
      const uploadId = randomUUID()
      const key = transferUploadKey(org, uploadId)
      const put = await sign({
        method: 'PUT',
        key,
        address: external,
        lifetimeSeconds: putUrlSeconds,
        headers: putHeaders(size, sha256)
      })
      return { ...put, uploadId }
    },

    async uploadedFileUrl({ org, uploadId, size, sha256, network }) {
      const key = transferUploadKey(org, uploadId)
      const head = await objects.head(key)
      // The PUT signed the checksum, so a matching one proves these bytes; a store that omits it is trusted on length alone.
      if (!head.exists || head.contentLength !== size) return undefined
      if (head.checksumSha256 !== undefined && head.checksumSha256 !== sha256) return undefined
      return await sign({ method: 'GET', key, address: addressOn(network), lifetimeSeconds: urlSeconds })
    },

    async cachedDownload({ key, size }) {
      assertEnabled()
      if (size < 1 || size > maxBytes) {
        throw new FileTransferError('too-large', `a transfer must be 1 byte to ${maxBytes} bytes`)
      }
      const head = await objects.head(key)
      // A copy without its checksum cannot prove which bytes it holds, so it is replaced rather than reused.
      const recent =
        head.exists &&
        head.contentLength === size &&
        (head.lastModified === undefined || head.lastModified > now() - CACHED_DOWNLOAD_MAX_AGE_MS)
      return recent ? head.checksumSha256 : undefined
    },

    async signPut({ key, bytes, sha256, network }) {
      assertEnabled()
      return await sign({
        method: 'PUT',
        key,
        address: addressOn(network),
        lifetimeSeconds: putUrlSeconds,
        headers: putHeaders(bytes, sha256)
      })
    },

    async storedDownload({ key, size, sha256, name }) {
      const head = await objects.head(key)
      if (!head.exists || head.contentLength !== size) return undefined
      if (head.checksumSha256 !== undefined && head.checksumSha256 !== sha256) return undefined
      return await signDownload({ key, name })
    },

    signDownload
  }
}
