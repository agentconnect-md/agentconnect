// Shared-image cards (webchat-generated-images.md): the client state, the cross-surface update store, and original retrieval.
import type {
  SharedImageDownload,
  SharedImageOriginal,
  SharedImagePreview,
  WebchatImageUpdate
} from '@agentconnect.md/protocol'
import { ApiError, downloadSessionFile, resolveSharedImageOriginal } from '@/lib/api'
import type { SharedFile } from '@/lib/shared-file'

export type { SharedImageDownload, SharedImageOriginal, SharedImagePreview, WebchatImageUpdate }

/** One shared image as a card renders it: the persisted descriptor plus a transient signed GET. */
export interface SharedImageState {
  attachment: SharedImagePreview
  original: SharedImageOriginal
  revision: number
  download?: SharedImageDownload
}

/** Keep the newer of two states; an equal revision may still bring a fresher download. */
export function newerImageState(held: SharedImageState, next: SharedImageState): SharedImageState {
  if (next.revision < held.revision) return held
  if (next.revision === held.revision)
    return next.download && !held.download ? { ...held, download: next.download } : held
  return {
    ...held,
    original: next.original,
    revision: next.revision,
    ...(next.download ? { download: next.download } : { download: undefined })
  }
}

/** Apply an `image_update` to a held state; older revisions are ignored. */
export function applyImageUpdate(
  held: SharedImageState,
  update: Pick<WebchatImageUpdate, 'revision' | 'original' | 'download'>
): SharedImageState {
  return newerImageState(held, {
    attachment: held.attachment,
    original: update.original,
    revision: update.revision,
    ...(update.download ? { download: update.download } : {})
  })
}

type Listener = () => void
const updates = new Map<string, Omit<SharedImageState, 'attachment'>>()
const listeners = new Set<Listener>()

/** Record the latest original state for a post, so every surface showing it (live lane, history row, other views) converges; at an equal revision the later report wins, since a resolver read is fresher than the descriptor it was asked about. */
export function publishImageState(postId: string, state: Omit<SharedImageState, 'attachment'>): void {
  const held = updates.get(postId)
  if (held && held.revision > state.revision) return
  updates.set(postId, state)
  for (const listener of listeners) listener()
}

export function subscribeImageStates(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The stored state published for a post; a stable reference until the next publish, so it can back a store snapshot. */
export function publishedImageState(postId: string | undefined): Omit<SharedImageState, 'attachment'> | undefined {
  return postId ? updates.get(postId) : undefined
}

/** The newest known state for a post: its own descriptor, or a published state at least as new. */
export function currentImageState(postId: string | undefined, base: SharedImageState): SharedImageState {
  const update = postId ? updates.get(postId) : undefined
  return update && update.revision >= base.revision ? { attachment: base.attachment, ...update } : base
}

/** Test seam: forget every published state. */
export function resetImageStates(): void {
  updates.clear()
}

/** Base64 to bytes, without a network round trip. */
export function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Why an original could not be produced; a card keeps its preview in every case. */
export type OriginalRefusal =
  'expired' | 'unavailable' | 'uploading' | 'uploadFailed' | 'changed' | 'tooLarge' | 'gone' | 'unsupported' | 'failed'

export class OriginalError extends Error {
  constructor(readonly refusal: OriginalRefusal) {
    super(refusal)
  }
}

/** Bound concurrent original fetches and decodes so a page full of cards cannot stampede. */
const MAX_ORIGINAL_FETCHES = 2
let active = 0
const waiting: Array<() => void> = []
async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_ORIGINAL_FETCHES) await new Promise<void>((resolve) => waiting.push(resolve))
  active += 1
  try {
    return await run()
  } finally {
    active -= 1
    waiting.shift()?.()
  }
}

/** Where a card's original lives and who may read it. */
export interface OriginalSource {
  postId?: string
  state: SharedImageState
  /** The share marker's file, for the workspace fallback and the download name. */
  file?: SharedFile
  agentId?: string
  sessionId?: string
}

/** The original's file name: the cached descriptor's, else the marker's, else the preview's. */
export function originalName(source: Pick<OriginalSource, 'file' | 'state'>): string {
  const original = source.state.original
  if (original.kind === 'cache' && original.name) return original.name
  return source.file?.name ?? source.state.attachment.name
}

function unexpired(download: SharedImageDownload | undefined, now: number): download is SharedImageDownload {
  return !!download && Date.parse(download.expiresAt) - 15_000 > now
}

/** A usable signed GET for a cached original: the held one while fresh, else a resolver round trip. */
export async function originalDownload(source: OriginalSource, now = Date.now()): Promise<SharedImageDownload> {
  const { state } = source
  if (state.original.kind !== 'cache') throw new OriginalError('failed')
  if (unexpired(state.download, now) && state.original.status === 'ready') return state.download
  if (!source.sessionId) throw new OriginalError('unavailable')
  let resolved: Awaited<ReturnType<typeof resolveSharedImageOriginal>>
  try {
    resolved = await resolveSharedImageOriginal(source.sessionId, state.original.attachmentId)
  } catch (err) {
    throw new OriginalError(err instanceof ApiError && err.code === 'DAEMON_FEATURE_MISSING' ? 'unsupported' : 'failed')
  }
  if (source.postId) {
    publishImageState(source.postId, {
      original: resolved.original,
      revision: state.revision,
      ...(resolved.download ? { download: resolved.download } : {})
    })
  }
  if (resolved.original.kind === 'cache' && resolved.download) return resolved.download
  const status = resolved.original.kind === 'cache' ? resolved.original.status : 'unavailable'
  throw new OriginalError(refusalOfStatus(status))
}

export function refusalOfStatus(status: string): OriginalRefusal {
  if (status === 'expired') return 'expired'
  if (status === 'pending') return 'uploading'
  if (status === 'upload_failed') return 'uploadFailed'
  return 'unavailable'
}

function workspaceRefusal(err: unknown): OriginalRefusal {
  if (!(err instanceof ApiError)) return 'failed'
  if (err.code === 'WORKSPACE_FILE_TOO_LARGE') return 'tooLarge'
  if (err.code === 'WORKSPACE_FILE_CHANGED') return 'changed'
  if (err.code === 'WORKSPACE_FILE_NOT_FOUND') return 'gone'
  if (err.code === 'DAEMON_FEATURE_MISSING' || err.code === 'WORKSPACE_SANDBOX_OUTDATED') return 'unsupported'
  return 'failed'
}

/** Fetch the full-resolution original as a Blob of its own MIME type, refusing bytes whose length or digest differ. */
export async function fetchOriginal(source: OriginalSource, fetcher: typeof fetch = fetch): Promise<Blob> {
  const { state } = source
  const original = state.original
  if (original.kind === 'inline') {
    return new Blob([base64Bytes(state.attachment.data)], { type: state.attachment.mimeType })
  }
  if (original.kind === 'cache' && original.status !== 'upload_failed') {
    return await withSlot(async () => {
      const download = await originalDownload(source)
      let res: Response
      try {
        res = await fetcher(download.url, { cache: 'no-store', mode: 'cors' })
      } catch {
        throw new OriginalError('failed')
      }
      if (res.status === 404 || res.status === 403) throw new OriginalError('expired')
      if (!res.ok) throw new OriginalError('failed')
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > 0 && declared !== original.bytes) throw new OriginalError('changed')
      const bytes = await res.arrayBuffer()
      if (bytes.byteLength !== original.bytes || (await sha256Hex(bytes)) !== original.sha256) {
        throw new OriginalError('changed')
      }
      return new Blob([bytes], { type: original.mimeType })
    })
  }
  // Without a cached copy the workspace file is the original, still pinned to the shared digest.
  const file = source.file
  if (!file?.path || !source.agentId || !source.sessionId) throw new OriginalError('unavailable')
  return await withSlot(async () => {
    try {
      const blob = await downloadSessionFile(source.agentId!, {
        sessionId: source.sessionId,
        path: file.path!,
        sha256: file.sha256
      })
      return new Blob([blob], { type: file.mimeType })
    } catch (err) {
      throw new OriginalError(workspaceRefusal(err))
    }
  })
}

/** The card's status line for an original, or undefined when it is simply available. */
export function originalStatusKey(
  original: SharedImageOriginal
): 'originalUploading' | 'originalUploadFailed' | 'originalExpired' | 'originalUnavailable' | undefined {
  if (original.kind !== 'cache') return undefined
  if (original.status === 'pending') return 'originalUploading'
  if (original.status === 'upload_failed') return 'originalUploadFailed'
  if (original.status === 'expired') return 'originalExpired'
  if (original.status === 'unavailable') return 'originalUnavailable'
  return undefined
}

/** Whether View original / Download can be attempted at all for this state. */
export function originalReachable(source: Pick<OriginalSource, 'state' | 'file' | 'sessionId' | 'agentId'>): boolean {
  const original = source.state.original
  if (original.kind === 'inline') return true
  const workspace = !!(source.file?.path && source.agentId && source.sessionId)
  if (original.kind === 'workspace') return workspace
  if (original.status === 'ready') return true
  // A failed upload still has the workspace original behind the share marker.
  return original.status === 'upload_failed' && workspace
}
