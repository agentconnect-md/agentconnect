// Webchat shared-image publication (webchat-generated-images.md §4–§6): commit the preview, then deliver the original.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MAX_FRAME_BYTES,
  SHARED_IMAGE_PREVIEW_MAX_BYTES,
  type SharedImage,
  type SharedImageGetOk,
  type SharedImageGetReq,
  type SharedImageOriginal,
  type SharedImagePutOk,
  type SharedImagePutReq,
  type SharedImageResolveOk,
  type TransferNetwork,
  type WebchatImageUpdate,
  type WebchatPost
} from '@agentconnect.md/protocol'
import type { Logger } from '../log.js'
import type { LocalStore, TranscriptAdmission } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { putStagedFile } from '../source-cache/put-object.js'
import type { PreparedPreview, PreviewFailureReason } from '../images/index.js'
import type { WorkspaceFileLinkResolver } from '../messages/workspace-file-links.js'
import { appendWebchatTextRow, closeWebchatSegmentForImage, type WebchatTurnOutput } from './turn-output.js'

/** Envelope, ids and JSON punctuation around one image event, post or history row, beyond its text and preview. */
const FRAME_OVERHEAD_BYTES = 6 * 1024
/** One upload's wall-clock bound, matching a console workspace transfer. */
const ORIGINAL_UPLOAD_TIMEOUT_MS = 15 * 60_000
/** Concurrent original uploads per daemon; later ones wait their turn. */
const ORIGINAL_UPLOAD_CONCURRENCY = 2
/** Staged originals awaiting upload, in bytes; past it a large original stays in the workspace. */
const ORIGINAL_STAGING_MAX_BYTES = 2 * 1024 ** 3

/** Largest workspace image a console share reads; decoding needs the whole file, so this bounds memory, not the transfer. */
export const SHARED_IMAGE_SOURCE_MAX_BYTES = 64 * 1024 * 1024

/** Console image shares one turn may publish. */
export const WEBCHAT_SHARES_PER_TURN = 20
/** Console image shares reading or preparing at once in this process. */
export const WEBCHAT_SHARES_IN_FLIGHT = 4

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A webchat session's channel is its conversation id; any other channel has no browser audience for updates. */
export function webchatConversationIdOf(channel: string): string | undefined {
  return CONVERSATION_ID.test(channel) ? channel : undefined
}

/** Attachment ids whose original delivery is running in THIS process (§4: read-time fallback, not recovery). */
const liveDeliveries = new Set<string>()
let stagedBytes = 0
let activeUploads = 0
const uploadWaiters: (() => void)[] = []

export function isOriginalDeliveryLive(attachmentId: string): boolean {
  return liveDeliveries.has(attachmentId)
}

/** How a stored image reads now: a pending original with no live task is unavailable, never an endless spinner. */
export function displayedSharedImage(image: SharedImage): SharedImage {
  const original = image.original
  if (original.kind !== 'cache' || original.status !== 'pending' || liveDeliveries.has(original.attachmentId))
    return image
  return { ...image, original: { ...original, status: 'unavailable' } }
}

/** The provenance line every copy carries: the model-chosen path plus what was actually published. */
export function sharedImageMarker(path: string, mimeType: string, bytes: number, sha256: string): string {
  return `[shared: ${path} (${mimeType}, ${bytes} bytes, sha256:${sha256.slice(0, 16)})]`
}

/** The decoded preview budget left once the text and envelope of the largest carrier frame are counted. */
export function previewByteBudget(text: string): number {
  const room = MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES - Buffer.byteLength(JSON.stringify(text))
  return Math.max(0, Math.min(SHARED_IMAGE_PREVIEW_MAX_BYTES, Math.floor(room / 4) * 3))
}

export interface SharedImagePublisherDeps {
  store: Pick<LocalStore, 'appendTranscript' | 'transcriptTextAt' | 'updateTranscriptSharedImage'>
  prepare: (input: {
    bytes: Buffer
    name: string
    maxPreviewBytes: number
    signal?: AbortSignal
  }) => Promise<PreparedPreview | { ok: false; reason: PreviewFailureReason; detail?: string }>
  /** The deployment's transfer cache from the last register; undefined ⇒ large originals stay in the workspace. */
  fileTransfer: () => { maxBytes: number } | undefined
  signPut: (req: SharedImagePutReq) => Promise<SharedImagePutOk>
  signGet: (req: SharedImageGetReq) => Promise<SharedImageGetOk>
  network: () => TransferNetwork
  /** This daemon's private directory for originals awaiting upload. */
  stagingRoot: string
  /** Fan an original-state change to the conversation's browsers; never a model turn. */
  sendUpdate: (update: WebchatImageUpdate) => void
  log: Logger
}

/** The trusted coordinates of the turn publishing the image. */
export interface SharedImageTurn {
  agentId: string
  outwardSessionId: string
  transcriptChannel: string
  thread?: string
  admission: TranscriptAdmission
  wc: WebchatTurnOutput
  resolveFileLink?: WorkspaceFileLinkResolver
  signal?: AbortSignal
  /** Persist the reply text streamed before the card, so history keeps it above the image. */
  commitPrecedingText?: () => Promise<void>
  /** Re-checked after preview preparation: cancellation or lost authority before commit publishes nothing. */
  stillPublishable: () => boolean
}

/** The workspace file, already resolved, fenced and read. */
export interface SharedImageSource {
  path: string
  caption?: string
  bytes: Buffer
  /** Hex SHA-256 of `bytes`. */
  sha256: string
}

/** The model-facing receipt: no preview bytes and no URL ever reach the runtime. */
export interface SharedImageReceipt {
  type: 'agentconnect.image'
  version: 1
  postId: string
  published: true
  original: { kind: SharedImageOriginal['kind']; attachmentId?: string; status?: string }
  notice?: string
}

export class SharedImagePublishError extends Error {}

/** The session or attachment is not this daemon's to resolve; the CP answers it as a 404. */
export class SharedImageNotFoundError extends Error {}

const PREPARE_REFUSALS: Record<PreviewFailureReason, string> = {
  'not-image': 'is not a PNG, JPEG, WEBP or SVG image — only those can be shared.',
  gif: 'is a GIF — only PNG, JPEG, WEBP or SVG can be shared. Convert it first.',
  animated: 'is animated — only static images can be shared.',
  corrupt: 'could not be decoded — the file is corrupt or truncated.',
  'too-many-pixels': 'has too many pixels to prepare a preview.',
  'unsafe-svg':
    'is not a self-contained static SVG (scripts, event handlers, external references, entities and embedded HTML are refused).',
  timeout: 'took too long to prepare a preview.',
  busy: 'could not be prepared now — the image processor is busy. Try again shortly.',
  'no-fit': 'could not be reduced to a preview within the display limit.'
}

/** Publish one image into the active webchat turn; resolves once the card is durably committed and emitted. */
export async function publishWebchatSharedImage(
  deps: SharedImagePublisherDeps,
  turn: SharedImageTurn,
  source: SharedImageSource
): Promise<SharedImageReceipt> {
  const marker = (mimeType: string) => sharedImageMarker(source.path, mimeType, source.bytes.byteLength, source.sha256)
  // Budget against the longest marker the sniffed type can produce, so the preview always fits the carrier frames.
  const provisionalText = source.caption ? `${source.caption}\n${marker('image/svg+xml')}` : marker('image/svg+xml')
  const prepared = await deps.prepare({
    bytes: source.bytes,
    name: source.path.split(/[\\/]/).pop() || 'image',
    maxPreviewBytes: previewByteBudget(provisionalText),
    ...(turn.signal ? { signal: turn.signal } : {})
  })
  if (!prepared.ok) {
    throw new SharedImagePublishError(
      `shareFile: "${source.path}" ${PREPARE_REFUSALS[prepared.reason]}${prepared.detail ? ` (${prepared.detail})` : ''}`
    )
  }
  if (turn.signal?.aborted || !turn.stillPublishable()) {
    throw new SharedImagePublishError(
      'shareFile: the turn ended before the image could be published — nothing was posted.'
    )
  }

  const text = source.caption
    ? `${source.caption}\n${marker(prepared.original.mimeType)}`
    : marker(prepared.original.mimeType)
  const bytes = source.bytes.byteLength
  const transfer = deps.fileTransfer()
  const notices: string[] = []
  let original: SharedImageOriginal
  let staged: string | undefined
  if (prepared.inline) original = { kind: 'inline' }
  else if (transfer && bytes <= transfer.maxBytes && stagedBytes + bytes <= ORIGINAL_STAGING_MAX_BYTES) {
    // Snapshot before commit: the upload sends exactly the bytes the preview was made from.
    stagedBytes += bytes
    try {
      staged = await stageOriginal(deps.stagingRoot, source.bytes)
    } catch (err) {
      stagedBytes -= bytes
      deps.log.warn(`shareFile: original staging failed (${(err as Error).message}); keeping it in the workspace`)
    }
    original = staged
      ? {
          kind: 'cache',
          attachmentId: randomUUID(),
          name: prepared.original.name,
          mimeType: prepared.original.mimeType,
          bytes,
          sha256: source.sha256,
          status: 'pending'
        }
      : { kind: 'workspace' }
  } else {
    original = { kind: 'workspace' }
    if (transfer && bytes > transfer.maxBytes)
      notices.push(`The original exceeds the transfer limit (${transfer.maxBytes} bytes); it stays in the workspace.`)
  }

  const image: SharedImage = {
    attachment: {
      name: prepared.preview.name,
      mimeType: prepared.preview.mimeType,
      data: prepared.preview.data.toString('base64'),
      ...(prepared.preview.width ? { width: prepared.preview.width } : {}),
      ...(prepared.preview.height ? { height: prepared.preview.height } : {})
    },
    original,
    revision: 0
  }
  if (turn.signal?.aborted || !turn.stillPublishable()) {
    if (staged) await discardStaged(staged, bytes)
    throw new SharedImagePublishError(
      'shareFile: the turn ended before the image could be published — nothing was posted.'
    )
  }
  const { wc } = turn
  const postId = randomUUID()
  let ts: string
  try {
    // The preceding text is a finished message: it keeps its place above the card, and later text starts a new one.
    closeWebchatSegmentForImage(wc, turn.resolveFileLink)
    await turn.commitPrecedingText?.()
    ts = await appendWebchatTextRow(
      deps.store as LocalStore,
      turn.transcriptChannel,
      turn.thread ?? '',
      monotonicTs(),
      {
        postId,
        sender: turn.agentId,
        admission: turn.admission,
        text,
        sharedImage: image
      }
    )
  } catch (err) {
    if (staged) await discardStaged(staged, bytes)
    throw new SharedImagePublishError(
      `shareFile: the image could not be recorded, so it was not posted (${(err as Error).message}).`
    )
  }
  const at = Number(ts)

  // Committed: from here a delivery problem is a notice, never a failure that invites a duplicate share.
  try {
    wc.sink.output({
      conversationId: wc.conversationId,
      turnId: wc.turnId,
      index: wc.index++,
      event: { kind: 'image', postId, at, text, ...image }
    })
    wc.messageEmitted = true
    if (!wc.continuation) {
      const post: WebchatPost = {
        postId,
        conversationId: wc.conversationId,
        // No hopCount: a shared image is transcript-only for peers and never wakes another agent.
        author: { kind: 'agent', agentId: turn.agentId },
        text,
        at,
        image
      }
      wc.postSink?.({
        conversationId: wc.conversationId,
        agentId: turn.agentId,
        post,
        ...(wc.initiator ? { initiator: wc.initiator } : {})
      })
    }
  } catch (err) {
    notices.push('The image was saved, but the live view may need a refresh to show it.')
    deps.log.warn(`shareFile: live image delivery failed (${(err as Error).message})`)
  }

  if (original.kind === 'cache' && staged) {
    liveDeliveries.add(original.attachmentId)
    void deliverOriginal(deps, turn, { postId, staged, original }).catch((err: unknown) =>
      deps.log.warn(`shareFile: original delivery crashed (${(err as Error).message})`)
    )
  }

  return {
    type: 'agentconnect.image',
    version: 1,
    postId,
    published: true,
    original: {
      kind: original.kind,
      ...(original.kind === 'cache' ? { attachmentId: original.attachmentId, status: original.status } : {})
    },
    ...(notices.length ? { notice: notices.join(' ') } : {})
  }
}

/** Staging directories carry this prefix under the daemon's own staging root, which a restart sweeps. */
const STAGING_PREFIX = 'original-'

async function stageOriginal(root: string, bytes: Buffer): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(root, STAGING_PREFIX))
  const file = join(dir, 'original')
  try {
    await writeFile(file, bytes, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return file
}

/** Remove staging an earlier process left behind; process-local delivery never resumes it (§4). */
export async function sweepSharedImageStaging(root: string): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(STAGING_PREFIX))
      .map((entry) => rm(join(root, entry), { recursive: true, force: true }).catch(() => {}))
  )
}

async function discardStaged(file: string, bytes: number): Promise<void> {
  stagedBytes = Math.max(0, stagedBytes - bytes)
  await rm(join(file, '..'), { recursive: true, force: true }).catch(() => {})
}

async function uploadSlot(): Promise<() => void> {
  while (activeUploads >= ORIGINAL_UPLOAD_CONCURRENCY) await new Promise<void>((resolve) => uploadWaiters.push(resolve))
  activeUploads += 1
  return () => {
    activeUploads -= 1
    uploadWaiters.shift()?.()
  }
}

/** Process-local original delivery: belongs to the published image, so turn end or stop never cancels it. */
async function deliverOriginal(
  deps: SharedImagePublisherDeps,
  turn: SharedImageTurn,
  job: { postId: string; staged: string; original: Extract<SharedImageOriginal, { kind: 'cache' }> }
): Promise<void> {
  const { original } = job
  const sha256 = Buffer.from(original.sha256, 'hex').toString('base64')
  let status: 'ready' | 'upload_failed' = 'upload_failed'
  let download: WebchatImageUpdate['download']
  const release = await uploadSlot()
  try {
    const signed = await deps.signPut({
      agentId: turn.agentId,
      sessionId: turn.outwardSessionId,
      postId: job.postId,
      attachmentId: original.attachmentId,
      bytes: original.bytes,
      sha256,
      network: deps.network()
    })
    await putStagedFile({
      file: job.staged,
      bytes: original.bytes,
      sha256,
      url: new URL(signed.url),
      headers: signed.headers,
      timeoutMs: ORIGINAL_UPLOAD_TIMEOUT_MS
    })
    status = 'ready'
    // The first GET rides the ready update; a signing hiccup leaves the stored object ready and resolvable later.
    const get = await deps
      .signGet({
        agentId: turn.agentId,
        attachmentId: original.attachmentId,
        bytes: original.bytes,
        sha256,
        name: original.name ?? 'image'
      })
      .catch(() => undefined)
    if (get?.url && get.expiresAt) download = { url: get.url, expiresAt: new Date(get.expiresAt).toISOString() }
  } catch (err) {
    deps.log.warn(`shareFile: original upload failed for ${original.attachmentId} (${(err as Error).message})`)
  } finally {
    release()
    await discardStaged(job.staged, original.bytes)
  }
  try {
    await settleOriginal(
      deps,
      turn.transcriptChannel,
      turn.wc.conversationId,
      turn.agentId,
      job.postId,
      status,
      download
    )
  } finally {
    liveDeliveries.delete(original.attachmentId)
  }
}

/** Persist one original-state change and tell the conversation's browsers; returns the stored image. */
export async function settleOriginal(
  deps: Pick<SharedImagePublisherDeps, 'store' | 'sendUpdate' | 'log'>,
  transcriptChannel: string,
  conversationId: string,
  agentId: string,
  postId: string,
  status: 'ready' | 'upload_failed' | 'expired',
  download?: WebchatImageUpdate['download']
): Promise<SharedImage | undefined> {
  const stored = await deps.store
    .updateTranscriptSharedImage(transcriptChannel, postId, (current) =>
      current.original.kind === 'cache' && current.original.status !== status
        ? { ...current, original: { ...current.original, status }, revision: current.revision + 1 }
        : undefined
    )
    .catch((err: unknown) => {
      deps.log.warn(`shareFile: recording the original's ${status} state failed (${(err as Error).message})`)
      return undefined
    })
  if (stored && stored.original.kind === 'cache' && stored.original.status === status) {
    // The state is already durable; a lost live notice is recovered from history.
    try {
      deps.sendUpdate({
        conversationId,
        agentId,
        postId,
        revision: stored.revision,
        original: stored.original,
        ...(download && status === 'ready' ? { download } : {})
      })
    } catch (err) {
      deps.log.warn(`shareFile: the original's ${status} notice was not delivered (${(err as Error).message})`)
    }
  }
  return stored
}

/** Resolve a stored original for an authorized console read; a missing cache object becomes expired, never re-uploaded. */
export async function resolveSharedImageOriginal(
  deps: Pick<SharedImagePublisherDeps, 'store' | 'sendUpdate' | 'log' | 'signGet'>,
  found: { transcriptChannel: string; conversationId?: string; agentId: string; postId: string; image: SharedImage },
  resolveId: string
): Promise<SharedImageResolveOk> {
  const shown = displayedSharedImage(found.image).original
  if (shown.kind !== 'cache' || shown.status !== 'ready') return { original: shown }
  const get = await deps.signGet({
    agentId: found.agentId,
    attachmentId: shown.attachmentId,
    bytes: shown.bytes,
    sha256: Buffer.from(shown.sha256, 'hex').toString('base64'),
    name: shown.name ?? 'image',
    resolveId
  })
  if (get.url && get.expiresAt)
    return { original: shown, download: { url: get.url, expiresAt: new Date(get.expiresAt).toISOString() } }
  if (!get.missing) throw new Error('the transfer cache did not answer with a download')
  const expired: SharedImageOriginal = { ...shown, status: 'expired' }
  if (found.conversationId)
    await settleOriginal(deps, found.transcriptChannel, found.conversationId, found.agentId, found.postId, 'expired')
  else
    await deps.store.updateTranscriptSharedImage(found.transcriptChannel, found.postId, (current) =>
      current.original.kind === 'cache' && current.original.status !== 'expired'
        ? { ...current, original: { ...current.original, status: 'expired' }, revision: current.revision + 1 }
        : undefined
    )
  return { original: expired }
}
