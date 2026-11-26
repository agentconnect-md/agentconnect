// The content-domain shim (artifacts.md §5.5); each function is shipped via `toString()`, so it uses only its parameters and browser globals.
import { createHash } from 'node:crypto'
import type { ShimToConsole } from './protocol'

export interface ShimConfig {
  consoleOrigin: string
  /** Path reports are coalesced over this window, so a page cannot flood the console. */
  reportMs: number
}

export const SHIM_REPORT_MS = 100

/** The console's `port` message: its transferred port and, on the answer to `ready`, the path to open. */
export function readConsoleMessage(
  data: unknown,
  ports: readonly MessagePort[]
): { port: MessagePort; entry?: string } | null {
  if (!data || typeof data !== 'object' || (data as { t?: unknown }).t !== 'port' || !ports[0]) return null
  const entry = (data as { entry?: unknown }).entry
  return typeof entry === 'string' ? { port: ports[0], entry } : { port: ports[0] }
}

/** The nested frame's first address: a path of this origin outside `/__ac/`, else the root. */
export function entryPath(entry: string, origin: string): string {
  let url: URL
  try {
    url = new URL(entry, origin)
  } catch {
    return '/'
  }
  if (url.origin !== origin || url.pathname.startsWith('/__ac/')) return '/'
  return url.pathname + url.search + url.hash
}

/** The nested frame's current path, or null while it shows no page of this origin. */
export function framePath(
  location: { origin: string; pathname: string; search: string; hash: string } | undefined,
  origin: string
): string | null {
  if (!location || location.origin !== origin || !location.pathname.startsWith('/')) return null
  return location.pathname + location.search + location.hash
}

export interface ShimLib {
  readConsoleMessage: typeof readConsoleMessage
  entryPath: typeof entryPath
  framePath: typeof framePath
}

/** Run the shim in `win`; a shim opened outside a frame does nothing. */
export function shimMain(win: Window, config: ShimConfig, lib: ShimLib): void {
  const parent = win.parent
  if (parent === win) return
  const post = (message: ShimToConsole) => parent.postMessage(message, config.consoleOrigin)
  const sw = win.navigator.serviceWorker
  if (!sw) return post({ t: 'unsupported', reason: 'no-service-worker' })
  const origin = win.location.origin
  let registration: ServiceWorkerRegistration | null = null
  let frame: HTMLIFrameElement | null = null
  let entry: string | null = null
  let last: string | null = null
  let timer: number | undefined

  const report = () => {
    timer = undefined
    let path: string | null = null
    try {
      path = lib.framePath(frame?.contentWindow?.location, origin)
    } catch {}
    if (path === null || path === last) return
    last = path
    post({ t: 'path', path })
  }
  const queueReport = () => {
    if (timer === undefined) timer = win.setTimeout(report, config.reportMs)
  }

  // Each document in the nested frame gets its history calls and traversals reported.
  const watch = (nested: Window | null) => {
    try {
      const history = nested!.history
      for (const name of ['pushState', 'replaceState'] as const) {
        const original = history[name]
        history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
          const result = original.apply(this, args)
          queueReport()
          return result
        }
      }
      nested!.addEventListener('popstate', queueReport)
      nested!.addEventListener('hashchange', queueReport)
    } catch {}
    queueReport()
  }

  const open = (path: string) => {
    const nested = win.document.createElement('iframe')
    nested.addEventListener('load', () => watch(nested.contentWindow))
    nested.src = lib.entryPath(path, origin)
    frame = nested
    win.document.body.append(nested)
  }

  // The worker asks for a port when it holds none, and acknowledges each one it takes.
  sw.addEventListener('message', (event) => {
    const t = (event.data as { t?: unknown } | null)?.t
    if (t === 'need-port') post({ t: 'need-port' })
    else if (t === 'port-ok' && entry !== null && !frame) open(entry)
  })
  sw.startMessages()

  win.addEventListener('message', (event) => {
    if (event.origin !== config.consoleOrigin || event.source !== parent) return
    const message = lib.readConsoleMessage(event.data, event.ports)
    const worker = registration?.active
    if (!message || !worker) return
    if (message.entry !== undefined && entry === null) entry = message.entry
    worker.postMessage({ t: 'port' }, [message.port])
  })

  sw.register('/__ac/sw.js', { scope: '/', updateViaCache: 'none' })
    .then(() => sw.ready)
    .then(
      (ready) => {
        registration = ready
        post({ t: 'ready' })
      },
      () => post({ t: 'unsupported', reason: 'registration-failed' })
    )
}

const LIB: ShimLib = { readConsoleMessage, entryPath, framePath }

const STYLE = 'html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}'

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`

/** The shim document with the console origin embedded, and the policy that admits only its own script and style. */
export function shimDocument(consoleOrigin: string): { html: string; csp: string } {
  const config: ShimConfig = { consoleOrigin, reportMs: SHIM_REPORT_MS }
  const lib = Object.entries(LIB)
    .map(([name, fn]) => `${JSON.stringify(name)}: ${fn.toString()}`)
    .join(',\n')
  const script = `'use strict';\n(${shimMain.toString()})(window, ${JSON.stringify(config)}, {\n${lib}\n});\n`
  if (/<\/script|<!--/i.test(script)) throw new Error('the shim script would end its own <script> element')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><script>${script}</script></body></html>`
  const csp = [
    "default-src 'none'",
    `script-src ${sha256(script)}`,
    `style-src ${sha256(STYLE)}`,
    "worker-src 'self'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${consoleOrigin}`
  ].join('; ')
  return { html, csp }
}
