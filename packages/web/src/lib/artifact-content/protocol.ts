// The messages between the console, the content-domain shim and its service worker (artifacts.md §5.5).

/** The origin revision `revision` of artifact `artifactId` renders at. */
export function artifactContentOrigin(artifactId: string, revision: number, domain: string): string {
  return `https://a${artifactId.replaceAll('-', '').toLowerCase()}r${revision}.${domain}`
}

/** The shim document every revision origin serves; the console frames it. */
export const SHIM_PATH = '/__ac/shim'
/** The service worker script, registered by the shim with scope `/`. */
export const WORKER_PATH = '/__ac/sw.js'
/** Why the shim cannot route the site through its worker; the console falls back to `srcdoc`. */
export type UnsupportedReason = 'no-service-worker' | 'registration-failed'

/** Shim → console, posted to the console's origin only. */
export type ShimToConsole =
  { t: 'ready' } | { t: 'need-port' } | { t: 'path'; path: string } | { t: 'unsupported'; reason: UnsupportedReason }

/** Console → shim, with a `MessagePort` bound to the revision transferred; `entry` only on the answer to `ready`. */
export interface ConsoleToShim {
  t: 'port'
  entry?: string
}

/** Shim → worker, with the console's port transferred. */
export interface ShimToWorker {
  t: 'port'
}

/** Worker → shim: the port is held, or the worker holds none and asks for one. */
export type WorkerToShim = { t: 'port-ok' } | { t: 'need-port' }

/** Worker → console over the port; `path` is the URL's pathname as the browser encoded it. */
export interface ContentRequest {
  id: number
  path: string
  navigate: boolean
  range: string | null
}

/** Console → worker: the request is being answered, which lifts the reply deadline to the long one. */
export interface ContentAck {
  id: number
  ack: true
}

/** Console → worker: the answer, typed by the manifest; a 206 carries its byte range of `size`. */
export type ContentReply =
  | { id: number; status: number; type: string; body: ArrayBuffer | null }
  | { id: number; status: 206; type: string; body: ArrayBuffer; start: number; end: number; size: number }

/** Bytes an open-ended range is answered with at most, so media streams in pieces. */
export const OPEN_RANGE_CAP = 256 * 1024

export type ByteRange = { start: number; end: number } | 'unsatisfiable'

/** The single byte range a `Range` header asks of `size` bytes, or null to answer whole (absent, multi-range or malformed). */
export function resolveByteRange(header: string | null, size: number, cap = OPEN_RANGE_CAP): ByteRange | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match || (match[1] === '' && match[2] === '')) return null
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  if (start >= size) return 'unsatisfiable'
  if (match[2] === '') return { start, end: Math.min(size - 1, start + cap - 1) }
  const end = Number(match[2])
  if (end < start) return null
  return { start, end: Math.min(end, size - 1) }
}
