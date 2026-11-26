// What the console takes from the shim (artifacts.md §5.5): its messages, checked, and the page path kept in the console URL.
import { SHIM_PATH, type ShimToConsole } from './protocol'

/** The console URL parameter holding the page the frame shows. */
export const VIEWER_PATH_PARAM = 'path'
/** How long a frame has to say `ready` before the viewer falls back to `srcdoc`. */
export const SHIM_READY_MS = 8_000
/** Path changes are written to the console URL at most this often, so a page cannot flood its history. */
export const PATH_SYNC_MS = 250

const MAX_VIEWER_PATH = 2048
const RESERVED = SHIM_PATH.slice(0, SHIM_PATH.lastIndexOf('/') + 1)
const BASE = 'https://content.invalid'

/** A shim message of a known shape, or null. */
export function readShimMessage(data: unknown): ShimToConsole | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.t === 'ready' || d.t === 'need-port') return { t: d.t }
  if (d.t === 'path' && typeof d.path === 'string') return { t: 'path', path: d.path }
  if (d.t === 'unsupported' && (d.reason === 'no-service-worker' || d.reason === 'registration-failed'))
    return { t: 'unsupported', reason: d.reason }
  return null
}

/** A page path of the revision's origin outside `/__ac/`, normalized, or null; history routes need not be in the manifest. */
export function readViewerPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_VIEWER_PATH) return null
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null
  let url: URL
  try {
    url = new URL(value, BASE)
  } catch {
    return null
  }
  if (url.origin !== BASE || url.pathname.startsWith(RESERVED)) return null
  const path = url.pathname + url.search + url.hash
  return path.length > MAX_VIEWER_PATH ? null : path
}

/** Trailing-edge coalescing of path reports: at most one write per `ms`, the latest path, nothing when unchanged. */
export function createPathSync(
  write: (path: string | null) => void,
  initial: string | null,
  ms = PATH_SYNC_MS,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis
) {
  let written = initial
  let next = initial
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    if (next === written) return
    written = next
    write(next)
  }
  return {
    push(path: string | null) {
      next = path
      if (timer === undefined) timer = timers.setTimeout(flush, ms)
    },
    cancel() {
      if (timer !== undefined) timers.clearTimeout(timer)
      timer = undefined
    }
  }
}
