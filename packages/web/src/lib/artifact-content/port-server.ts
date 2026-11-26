// The console's end of a revision's ports (artifacts.md §5.5): answers manifest paths only, from bytes it fetched itself.
import { resolveByteRange, type ContentAck, type ContentReply, type ContentRequest } from './protocol'

export interface PortServerFile {
  path: string
  mediaType: string
  bytes: number
}

export interface PortServerOptions {
  files: readonly PortServerFile[]
  /** The manifest path a navigation outside the manifest is answered with. */
  entry: string
  /** One file's bytes, fetched through its signed URL after the access check. */
  load: (file: PortServerFile) => Promise<ArrayBuffer>
  cacheBytes?: number
}

/** Mirror of protocol's ARTIFACT_MAX_BYTES, so a whole revision fits the cache. */
export const PORT_CACHE_BYTES = 50 * 1024 * 1024
/** Ports a server keeps open; an older one is closed, and a worker still holding it times out and asks again. */
export const MAX_OPEN_PORTS = 8

const MAX_PATH = 4096
const MAX_RANGE = 256
const TEXT_TYPE_RE = /^(text\/[^;]+|application\/(javascript|ecmascript|json|xml|[^;]+\+json|[^;]+\+xml))$/i

/** A port message the worker may send, or null for anything else. */
export function readContentRequest(data: unknown): ContentRequest | null {
  if (!data || typeof data !== 'object') return null
  const { id, path, navigate, range } = data as Record<string, unknown>
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH) return null
  if (typeof navigate !== 'boolean') return null
  if (range !== null && (typeof range !== 'string' || range.length > MAX_RANGE)) return null
  return { id, path, navigate, range }
}

/** The manifest path an encoded request path names, `/` and `dir/` meaning their `index.html`; null when none. */
export function manifestPathOf(requestPath: string, has: (path: string) => boolean): string | null {
  if (!requestPath.startsWith('/')) return null
  const segments: string[] = []
  for (const segment of requestPath.slice(1).split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded.includes('/')) return null
    segments.push(decoded)
  }
  let path = segments.join('/')
  if (path === '' || path.endsWith('/')) path += 'index.html'
  return has(path) ? path : null
}

/** The URL path a manifest path is served at, each segment encoded. */
export function servedPath(manifestPath: string): string {
  return `/${manifestPath.split('/').map(encodeURIComponent).join('/')}`
}

/** The manifest type, with UTF-8 named for text that names no charset, since agents write UTF-8. */
export function replyType(mediaType: string): string {
  const type = mediaType.trim()
  return TEXT_TYPE_RE.test(type) ? `${type}; charset=utf-8` : type
}

/** Fetched files by manifest path, least recently used dropped first once `limit` bytes are held. */
export class ByteCache {
  private readonly entries = new Map<string, { bytes: number; value: Promise<ArrayBuffer>; settled: boolean }>()
  private total = 0

  constructor(private readonly limit: number) {}

  has(path: string): boolean {
    return this.entries.has(path)
  }

  /** Whether the file's bytes are held, not merely being fetched. */
  holds(path: string): boolean {
    return this.entries.get(path)?.settled === true
  }

  get size(): number {
    return this.total
  }

  get(path: string, bytes: number, load: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    const hit = this.entries.get(path)
    if (hit) {
      this.entries.delete(path)
      this.entries.set(path, hit)
      return hit.value
    }
    const value = load()
    if (bytes > this.limit) return value
    const entry = { bytes, value, settled: false }
    value.then(
      () => (entry.settled = true),
      () => {
        if (this.entries.get(path) === entry) this.drop(path)
      }
    )
    this.entries.set(path, entry)
    this.total += bytes
    for (const oldest of this.entries.keys()) {
      if (this.total <= this.limit) break
      if (oldest !== path) this.drop(oldest)
    }
    return value
  }

  private drop(path: string): void {
    const entry = this.entries.get(path)
    if (!entry) return
    this.entries.delete(path)
    this.total -= entry.bytes
  }
}

export type PortPost = (message: ContentAck | ContentReply, transfer: ArrayBuffer[]) => void

export interface PortServer {
  /** A fresh port bound to this revision, for the shim to hand its worker. */
  port(): MessagePort
  /** One request answered through `post`; exported for tests. */
  handle(request: ContentRequest, post: PortPost): Promise<void>
  /** A manifest file's bytes through the cache; the `srcdoc` fallback reads the entry this way. */
  file(path: string): Promise<ArrayBuffer>
  /** Closes the open ports; the server stays usable, so a remounted view can issue new ones. */
  close(): void
}

/** A server bound to one revision's manifest; nothing that arrives on a port widens what it answers. */
export function createPortServer(options: PortServerOptions): PortServer {
  const files = new Map(options.files.map((file) => [file.path, file]))
  const cache = new ByteCache(options.cacheBytes ?? PORT_CACHE_BYTES)
  const ports: MessagePort[] = []

  const read = (file: PortServerFile) => cache.get(file.path, file.bytes, () => options.load(file))

  async function handle(request: ContentRequest, post: PortPost): Promise<void> {
    const { id } = request
    const plain = (status: number) => post({ id, status, type: 'text/plain; charset=utf-8', body: null }, [])
    const path = manifestPathOf(request.path, (p) => files.has(p)) ?? (request.navigate ? options.entry : null)
    const file = path === null ? undefined : files.get(path)
    if (!file) return plain(404)
    // A fetch, or waiting on one already in flight, may outlast the worker's short deadline; the ack moves it to the long one.
    if (!cache.holds(file.path)) post({ id, ack: true }, [])
    let bytes: ArrayBuffer
    try {
      bytes = await read(file)
    } catch {
      return plain(502)
    }
    const type = replyType(file.mediaType)
    const range = resolveByteRange(request.range, bytes.byteLength)
    if (range === 'unsatisfiable') return plain(416)
    if (range === null) {
      const body = bytes.slice(0)
      return post({ id, status: 200, type, body }, [body])
    }
    const body = bytes.slice(range.start, range.end + 1)
    post({ id, status: 206, type, body, start: range.start, end: range.end, size: bytes.byteLength }, [body])
  }

  return {
    port() {
      const channel = new MessageChannel()
      const own = channel.port1
      own.onmessage = (event: MessageEvent) => {
        const request = readContentRequest(event.data)
        if (!request) return
        void handle(request, (message, transfer) => own.postMessage(message, transfer))
      }
      ports.push(own)
      while (ports.length > MAX_OPEN_PORTS) ports.shift()!.close()
      return channel.port2
    },
    handle,
    file(path) {
      const file = files.get(path)
      return file ? read(file) : Promise.reject(new Error(`${path} is not in the manifest`))
    },
    close() {
      for (const port of ports.splice(0)) port.close()
    }
  }
}
