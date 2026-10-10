import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { PreviewFailureReason, PreviewJobInput, PreviewJobResult } from './job.js'
import { sharedImageName, sniffSharedImage, type SharedImageMime } from './sniff.js'

// Bounded shared-image preview preparation (webchat-generated-images.md §5): a small worker pool with hard limits.

export type { PreviewFailureReason } from './job.js'
export type { SharedImageMime } from './sniff.js'

export type PreparedPreview = {
  ok: true
  /** The original's sniffed type and a safe file name `<stem>.<ext>` derived from `name` + sniffed type. */
  original: { mimeType: SharedImageMime; name: string }
  preview: { mimeType: SharedImageMime; name: string; data: Buffer; width?: number; height?: number }
  /** true ⇒ preview.data IS the unchanged original (fits the cap and validated). */
  inline: boolean
}

export type PreviewFailure = { ok: false; reason: PreviewFailureReason; detail?: string }

export type PreviewPoolLimits = {
  maxWorkers: number
  maxQueued: number
  timeoutMs: number
  idleMs: number
  maxOldGenerationSizeMb: number
}

export const DEFAULT_PREVIEW_POOL_LIMITS: PreviewPoolLimits = {
  maxWorkers: 2,
  maxQueued: 8,
  timeoutMs: 30_000,
  idleMs: 60_000,
  maxOldGenerationSizeMb: 768
}

let limits = { ...DEFAULT_PREVIEW_POOL_LIMITS }
// Test hook: delay each job inside the worker.
let jobDelayMs = 0

type Slot = { worker: Worker; idleTimer?: NodeJS.Timeout }
const idle: Slot[] = []
let busy = 0
const waiters: Array<(slot: Slot | undefined) => void> = []
let nextId = 1

/** Override pool limits (tests and operators); running jobs keep the limits they started with. */
export function configurePreviewPool(next: Partial<PreviewPoolLimits> & { jobDelayMs?: number }): void {
  const { jobDelayMs: delay, ...rest } = next
  limits = { ...limits, ...rest }
  if (delay !== undefined) jobDelayMs = delay
}

/** Stop every idle worker and restore the default limits. */
export async function resetPreviewPool(): Promise<void> {
  limits = { ...DEFAULT_PREVIEW_POOL_LIMITS }
  jobDelayMs = 0
  await Promise.all(idle.splice(0).map((slot) => retire(slot)))
}

function workerTarget(): { url: URL; execArgv: string[] } {
  const here = fileURLToPath(import.meta.url)
  // Running from source (vitest, tsx): the TypeScript worker needs the tsx loader the daemon already develops with.
  if (here.endsWith('.ts')) {
    const tsx = createRequire(import.meta.url).resolve('tsx/package.json')
    return {
      url: pathToFileURL(join(dirname(here), 'preview-worker.ts')),
      execArgv: ['--import', pathToFileURL(join(dirname(tsx), 'dist', 'loader.mjs')).href]
    }
  }
  // Published bundle: the worker is its own entry beside this module in dist/.
  return { url: pathToFileURL(join(dirname(here), 'image-preview-worker.js')), execArgv: [] }
}

function spawn(): Slot {
  const target = workerTarget()
  const worker = new Worker(target.url, {
    execArgv: target.execArgv,
    resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 64 },
    stdout: false,
    stderr: false
  })
  worker.unref()
  return { worker }
}

async function retire(slot: Slot): Promise<void> {
  if (slot.idleTimer) clearTimeout(slot.idleTimer)
  await slot.worker.terminate().catch(() => undefined)
}

async function acquire(): Promise<Slot | undefined> {
  const slot = idle.pop()
  if (slot) {
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    busy++
    return slot
  }
  if (busy < limits.maxWorkers) {
    busy++
    return spawn()
  }
  if (waiters.length >= limits.maxQueued) return undefined
  return new Promise((resolve) => waiters.push(resolve))
}

// Hand a healthy worker to the next waiter, or park it with an idle timeout; a dead one frees its slot.
function release(slot: Slot, healthy: boolean): void {
  const waiter = waiters.shift()
  if (!healthy) {
    void retire(slot)
    if (waiter) waiter(spawn())
    else busy--
    return
  }
  if (waiter) return waiter(slot)
  busy--
  slot.idleTimer = setTimeout(() => {
    const at = idle.indexOf(slot)
    if (at >= 0) idle.splice(at, 1)
    void retire(slot)
  }, limits.idleMs)
  slot.idleTimer.unref()
  idle.push(slot)
}

function run(
  slot: Slot,
  input: PreviewJobInput,
  signal?: AbortSignal
): Promise<{ result: PreviewJobResult; healthy: boolean }> {
  const id = nextId++
  const { worker } = slot
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: PreviewJobResult, healthy: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      resolve({ result, healthy })
    }
    const onMessage = (msg: { id: number; result: PreviewJobResult }) => {
      if (msg.id === id) finish(msg.result, true)
    }
    const onError = (err: Error) => {
      const oom = (err as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY'
      finish(
        {
          ok: false,
          reason: 'corrupt',
          detail: oom ? 'image processing exceeded its memory limit' : err.message.slice(0, 200)
        },
        false
      )
    }
    const onExit = () =>
      finish({ ok: false, reason: 'corrupt', detail: 'image processing stopped unexpectedly' }, false)
    const onAbort = () => finish({ ok: false, reason: 'timeout', detail: 'preview preparation was cancelled' }, false)
    const timer = setTimeout(
      () =>
        finish({ ok: false, reason: 'timeout', detail: `preview preparation exceeded ${limits.timeoutMs} ms` }, false),
      limits.timeoutMs
    )
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
    signal?.addEventListener('abort', onAbort, { once: true })
    // The job owns a private copy, so transferring it never detaches the caller's Buffer.
    const bytes = new Uint8Array(input.bytes)
    worker.postMessage({ id, input: { ...input, bytes }, ...(jobDelayMs ? { delayMs: jobDelayMs } : {}) }, [
      bytes.buffer
    ])
  })
}

/** Validate an image and produce its bounded preview: the unchanged original when it fits, else a reduced raster. */
export async function prepareSharedImagePreview(input: {
  bytes: Buffer
  name: string
  maxPreviewBytes: number
  signal?: AbortSignal
}): Promise<PreparedPreview | PreviewFailure> {
  const mime = sniffSharedImage(input.bytes)
  if (mime === 'image/gif') return { ok: false, reason: 'gif', detail: 'GIF is not supported' }
  if (!mime) return { ok: false, reason: 'not-image', detail: 'not a PNG, JPEG, WebP or SVG image' }
  if (input.signal?.aborted) return { ok: false, reason: 'timeout', detail: 'preview preparation was cancelled' }
  const slot = await acquire()
  if (!slot) return { ok: false, reason: 'busy', detail: 'image processing is at capacity' }
  if (input.signal?.aborted) {
    release(slot, true)
    return { ok: false, reason: 'timeout', detail: 'preview preparation was cancelled' }
  }
  const { result, healthy } = await run(
    slot,
    { bytes: input.bytes, mime, maxPreviewBytes: input.maxPreviewBytes },
    input.signal
  )
  release(slot, healthy)
  if (!result.ok) return result
  const data = Buffer.from(result.preview.data.buffer, result.preview.data.byteOffset, result.preview.data.byteLength)
  return {
    ok: true,
    inline: result.inline,
    original: { mimeType: mime, name: sharedImageName(input.name, mime) },
    preview: {
      mimeType: result.preview.mimeType,
      name: sharedImageName(input.name, result.preview.mimeType),
      data,
      ...(result.preview.width ? { width: result.preview.width } : {}),
      ...(result.preview.height ? { height: result.preview.height } : {})
    }
  }
}
