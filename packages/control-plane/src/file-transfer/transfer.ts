import { createHash, randomUUID } from 'node:crypto'
import type { TransferNetwork } from '@agentconnect.md/protocol'
import {
  addressFor,
  amzDate,
  bucketEndpoint,
  compositeSha256,
  headHolds,
  presign,
  S3_MAX_OBJECT_BYTES,
  S3_MAX_PARTS,
  S3_MIN_PART_BYTES,
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
  /^src\/[A-Za-z0-9_-]{1,64}\/transfer\/(?:up\/[0-9a-f-]{36}\/[0-9a-f-]{36}|dl\/[0-9a-f]{64}|img\/[0-9a-f-]{36}\/[0-9a-f-]{36})$/
const CHECKSUM_RE = /^[A-Za-z0-9+/]{43}=$/
/** A cached download is reused only while it is well inside the 2-day `pending` lifecycle rule. */
const CACHED_DOWNLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DAY_SECONDS = 86_400
/** The most part URLs one grant or `parts` call signs; a larger upload asks for the rest as it goes. */
export const PART_URL_BATCH = 100

/** The shortest `pending` window, in days, that outlives a reused download plus the GET signed for it. */
export function transferPendingMinimumDays(urlSeconds: number): number {
  return Math.ceil((CACHED_DOWNLOAD_MAX_AGE_MS / 1000 + urlSeconds + SOURCE_CACHE_GRACE_SECONDS) / DAY_SECONDS)
}

function assertOrg(org: string): void {
  if (!ORG_RE.test(org)) throw new Error('org must be 1-64 characters of [A-Za-z0-9_-]')
}

/** `src/<org>/transfer/up/<agentId>/<uuid>`: one browser upload, readable only through the agent it was reserved for. */
export function transferUploadKey(org: string, agentId: string, uploadId: string): TransferObjectKey {
  assertOrg(org)
  if (!ANY_UUID_RE.test(agentId)) throw new Error('agent id must be a lower-case UUID')
  if (!UUID_RE.test(uploadId)) throw new Error('upload id must be a lower-case v4 UUID')
  return `src/${org}/transfer/up/${agentId}/${uploadId}` as TransferObjectKey
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

/** One part's presigned PUT: send exactly these headers and the part's bytes. */
export interface PartUrl {
  partNumber: number
  url: string
  headers: Record<string, string>
}

/** How a browser upload is cut: every part is `partBytes` but the last, and `parts[i]` is part i+1's base64 SHA-256. */
export interface UploadLayout {
  size: number
  partBytes: number
  parts: readonly string[]
}

export interface MultipartGrant {
  uploadId: string
  /** The store's id for this multipart upload; every later part or complete URL names it. */
  multipartId: string
  /** The first `PART_URL_BATCH` parts' PUTs. */
  parts: PartUrl[]
  /** The presigned CompleteMultipartUpload POST the browser sends its part list to. */
  complete: TransferUrl
  expiresAt: number
}

export interface FileTransferDeps {
  config: FileTransferConfig
  credentials: CredentialsProvider
  objects: Pick<SourceCacheObjectClient<TransferObjectKey>, 'head' | 'createMultipartUpload'>
  /** False while the bucket's pending rule is missing (nothing collects a transfer) or too short (live links break). */
  enabled: () => boolean
  /** False while no lifecycle rule aborts unfinished multipart uploads, so an abandoned one's parts would never be reaped. */
  multipart?: () => boolean
  now?: () => number
  /** Test seam: endpoints the config schema would refuse (plain-http fixtures). */
  endpointOverride?: { internal?: string; public?: string }
}

export interface FileTransfer {
  enabled(): boolean
  /** The largest object one PUT carries: a daemon's snapshot or shared image, or a browser upload sent whole. */
  maxBytes: number
  /** What the console may upload right now: its cap, and the largest part when uploads may go in parts. */
  uploadLimits(): { maxBytes: number; partBytes?: number }
  /** Reserve a key under `agentId` and presign the browser's PUT for exactly this length and digest. */
  grantUpload(input: {
    org: string
    agentId: string
    size: number
    sha256: string
  }): Promise<TransferUrl & { uploadId: string }>
  /** Reserve a key under `agentId`, start a multipart upload of exactly this layout, and presign its first parts. */
  grantMultipartUpload(input: {
    org: string
    agentId: string
    sha256: string
    layout: UploadLayout
  }): Promise<MultipartGrant>
  /** Presign more part PUTs, or fresh ones, and a fresh complete, for a multipart upload under `agentId`. */
  signParts(input: {
    org: string
    agentId: string
    uploadId: string
    multipartId: string
    size: number
    partBytes: number
    parts: ReadonlyArray<{ partNumber: number; sha256: string }>
  }): Promise<{ parts: PartUrl[]; complete: TransferUrl; expiresAt: number }>
  /** Presign the agent's GET for an upload reserved for it, or undefined when the bucket does not hold exactly those bytes. */
  uploadedFileUrl(input: {
    org: string
    agentId: string
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
    readonly reason: 'too-large' | 'transfer-unavailable' | 'stale' | 'invalid',
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
  const { urlSeconds, putUrlSeconds, partBytes: maxPartBytes } = config.limits
  const capBytes = config.limits.maxBytes ?? Number.POSITIVE_INFINITY
  const maxBytes = Math.min(capBytes, maxPartBytes)
  const multipart = () => deps.multipart?.() ?? false

  const sign = async (input: {
    method: 'GET' | 'PUT' | 'POST'
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

  const assertChecksum = (sha256: string): void => {
    if (!CHECKSUM_RE.test(sha256) || Buffer.from(sha256, 'base64').length !== 32) {
      throw new Error('transfer checksum must be a base64 SHA-256')
    }
  }

  const putHeaders = (bytes: number, sha256: string): Record<string, string> => {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes) {
      throw new FileTransferError('too-large', `a transfer must be 1 byte to ${maxBytes} bytes`)
    }
    assertChecksum(sha256)
    return { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256, 'x-amz-tagging': PENDING_TAGGING }
  }

  const uploadLimits = (): { maxBytes: number; partBytes?: number } =>
    multipart()
      ? { maxBytes: Math.min(capBytes, S3_MAX_PARTS * maxPartBytes, S3_MAX_OBJECT_BYTES), partBytes: maxPartBytes }
      : { maxBytes }

  /** The number of parts a layout has, once its size and part size are ones this deployment admits. */
  const partCount = (size: number, partBytes: number): number => {
    if (!multipart()) throw new FileTransferError('transfer-unavailable', 'the bucket does not reap unfinished uploads')
    if (!Number.isSafeInteger(partBytes) || partBytes < S3_MIN_PART_BYTES || partBytes > maxPartBytes) {
      throw new FileTransferError('too-large', `a part must be ${S3_MIN_PART_BYTES} to ${maxPartBytes} bytes`)
    }
    const cap = uploadLimits().maxBytes
    if (!Number.isSafeInteger(size) || size < 1 || size > cap) {
      throw new FileTransferError('too-large', `a transfer must be 1 byte to ${cap} bytes`)
    }
    const count = Math.ceil(size / partBytes)
    if (count > S3_MAX_PARTS) throw new FileTransferError('too-large', `an upload has at most ${S3_MAX_PARTS} parts`)
    return count
  }

  const signPart = async (
    key: TransferObjectKey,
    multipartId: string,
    layout: { size: number; partBytes: number; count: number },
    partNumber: number,
    sha256: string
  ): Promise<PartUrl> => {
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > layout.count) {
      throw new FileTransferError('invalid', `part number must be 1 to ${layout.count}`)
    }
    assertChecksum(sha256)
    const bytes = partNumber < layout.count ? layout.partBytes : layout.size - (layout.count - 1) * layout.partBytes
    // The tag rides the CreateMultipartUpload; a part signs only its own length and checksum.
    const put = await sign({
      method: 'PUT',
      key,
      address: external,
      lifetimeSeconds: putUrlSeconds,
      headers: { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256 },
      query: { partNumber: String(partNumber), uploadId: multipartId }
    })
    return { partNumber, url: put.url, headers: put.headers }
  }

  const signComplete = async (key: TransferObjectKey, multipartId: string): Promise<TransferUrl> =>
    await sign({
      method: 'POST',
      key,
      address: external,
      lifetimeSeconds: putUrlSeconds,
      query: { uploadId: multipartId }
    })

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
    if (!deps.enabled())
      throw new FileTransferError('transfer-unavailable', 'the bucket lacks a long enough pending lifecycle rule')
  }

  return {
    enabled: () => deps.enabled(),
    maxBytes,
    uploadLimits,

    async grantUpload({ org, agentId, size, sha256 }) {
      assertEnabled()
      const uploadId = randomUUID()
      const key = transferUploadKey(org, agentId, uploadId)
      const put = await sign({
        method: 'PUT',
        key,
        address: external,
        lifetimeSeconds: putUrlSeconds,
        headers: putHeaders(size, sha256)
      })
      return { ...put, uploadId }
    },

    async grantMultipartUpload({ org, agentId, sha256, layout }) {
      assertEnabled()
      const count = partCount(layout.size, layout.partBytes)
      if (layout.parts.length !== count)
        throw new FileTransferError('invalid', `a ${layout.size}-byte upload in this part size has ${count} parts`)
      layout.parts.forEach(assertChecksum)
      // The turn names the upload by the digest the store will report, so it must be the parts' composite.
      if (compositeSha256(layout.parts) !== sha256)
        throw new FileTransferError('invalid', 'sha256 must be the composite of the part digests')
      const uploadId = randomUUID()
      const key = transferUploadKey(org, agentId, uploadId)
      const multipartId = await objects.createMultipartUpload(key, PENDING_TAGGING)
      const shape = { size: layout.size, partBytes: layout.partBytes, count }
      const parts = await Promise.all(
        layout.parts.slice(0, PART_URL_BATCH).map((part, i) => signPart(key, multipartId, shape, i + 1, part))
      )
      const complete = await signComplete(key, multipartId)
      return { uploadId, multipartId, parts, complete, expiresAt: complete.expiresAt }
    },

    async signParts({ org, agentId, uploadId, multipartId, size, partBytes, parts }) {
      assertEnabled()
      const count = partCount(size, partBytes)
      if (parts.length > PART_URL_BATCH)
        throw new FileTransferError('invalid', `at most ${PART_URL_BATCH} parts per call`)
      const key = transferUploadKey(org, agentId, uploadId)
      const shape = { size, partBytes, count }
      const signed = await Promise.all(parts.map((p) => signPart(key, multipartId, shape, p.partNumber, p.sha256)))
      const complete = await signComplete(key, multipartId)
      return { parts: signed, complete, expiresAt: complete.expiresAt }
    },

    async uploadedFileUrl({ org, agentId, uploadId, size, sha256, network }) {
      // Another agent's upload is a different key, so it reads as absent.
      const key = transferUploadKey(org, agentId, uploadId)
      if (!headHolds(await objects.head(key), { bytes: size, sha256, composite: true })) return undefined
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
        (head.contentLength === undefined || head.contentLength === size) &&
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
      if (!headHolds(await objects.head(key), { bytes: size, sha256 })) return undefined
      return await signDownload({ key, name })
    },

    signDownload
  }
}
