import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entryPath, framePath, readConsoleMessage, SHIM_REPORT_MS, shimDocument, shimMain } from './shim'

const ORIGIN = 'https://a0123456789abcdef0123456789abcdefr1.example-usercontent.net'
const CONSOLE = 'https://console.example.test'
const LIB = { readConsoleMessage, entryPath, framePath }
const port = {} as MessagePort

describe('shim helpers', () => {
  it('reads only a port message that carries a port', () => {
    expect(readConsoleMessage({ t: 'port', entry: '/index.html' }, [port])).toEqual({ port, entry: '/index.html' })
    expect(readConsoleMessage({ t: 'port', entry: 7 }, [port])).toEqual({ port })
    expect(readConsoleMessage({ t: 'port' }, [])).toBeNull()
    expect(readConsoleMessage({ t: 'ready' }, [port])).toBeNull()
    expect(readConsoleMessage(null, [port])).toBeNull()
  })

  it.each([
    ['/index.html', '/index.html'],
    ['docs/a.html?x=1#top', '/docs/a.html?x=1#top'],
    ['//evil.example.test/x', '/'],
    ['https://evil.example.test/', '/'],
    ['/__ac/shim', '/'],
    ['javascript:alert(1)', '/']
  ])('opens %j as %j', (entry, path) => expect(entryPath(entry, ORIGIN)).toBe(path))

  it('reports a page of its own origin only', () => {
    const at = (origin: string, pathname: string) => ({ origin, pathname, search: '?q', hash: '#h' })
    expect(framePath(at(ORIGIN, '/app/settings'), ORIGIN)).toBe('/app/settings?q#h')
    expect(framePath(at(ORIGIN, 'blank'), ORIGIN)).toBeNull()
    expect(framePath(at(CONSOLE, '/'), ORIGIN)).toBeNull()
    expect(framePath(undefined, ORIGIN)).toBeNull()
  })
})

type Listener = (event: never) => void

function harness(options: { serviceWorker?: boolean; registerFails?: boolean; framed?: boolean } = {}) {
  const posts: unknown[] = []
  const parent = { postMessage: vi.fn((message: unknown, target: string) => posts.push({ message, target })) }
  const worker = { postMessage: vi.fn() }
  const sw: Record<string, Listener> = {}
  const win: Record<string, Listener> = {}
  const nestedListeners: Record<string, Listener> = {}
  const location = { origin: ORIGIN, pathname: '/', search: '', hash: '' }
  const navigate = (url: string) => Object.assign(location, { pathname: url, search: '', hash: '' })
  const nested = {
    location,
    history: {
      pushState: (_s: unknown, _u: string, url: string) => navigate(url),
      replaceState: (_s: unknown, _u: string, url: string) => navigate(url)
    },
    addEventListener: (type: string, listener: Listener) => (nestedListeners[type] = listener)
  }
  const frameListeners: Record<string, () => void> = {}
  const frame = {
    src: '',
    contentWindow: nested,
    addEventListener: (type: string, listener: () => void) => (frameListeners[type] = listener)
  }
  const appended: unknown[] = []
  const register = vi.fn(async () => {
    if (options.registerFails) throw new Error('blocked')
    return {}
  })
  const window = {
    location: { origin: ORIGIN },
    navigator: {
      serviceWorker:
        options.serviceWorker === false
          ? undefined
          : {
              addEventListener: (type: string, listener: Listener) => (sw[type] = listener),
              startMessages: vi.fn(),
              register,
              ready: Promise.resolve({ active: worker })
            }
    },
    addEventListener: (type: string, listener: Listener) => (win[type] = listener),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    document: { createElement: () => frame, body: { append: (node: unknown) => appended.push(node) } },
    parent: parent as unknown
  }
  if (options.framed === false) window.parent = window
  const fromConsole = (data: unknown, extra: Partial<{ origin: string; source: unknown; ports: unknown[] }> = {}) =>
    (win.message as (e: unknown) => void)({ data, origin: CONSOLE, source: parent, ports: [port], ...extra })
  const fromWorker = (data: unknown) => (sw.message as (e: unknown) => void)({ data })
  const load = (path: string) => {
    navigate(path)
    frameListeners.load!()
  }
  const run = () => shimMain(window as unknown as Window, { consoleOrigin: CONSOLE, reportMs: SHIM_REPORT_MS }, LIB)
  return {
    posts,
    parent,
    worker,
    register,
    frame,
    appended,
    nested,
    nestedListeners,
    fromConsole,
    fromWorker,
    load,
    run
  }
}

const sent = (h: ReturnType<typeof harness>) => h.posts.map((p) => (p as { message: unknown }).message)

describe('shimMain', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does nothing outside a frame', async () => {
    const h = harness({ framed: false })
    h.run()
    await vi.runAllTimersAsync()
    expect(h.register).not.toHaveBeenCalled()
  })

  it('tells the console when it has no service worker or registration fails', async () => {
    const none = harness({ serviceWorker: false })
    none.run()
    expect(none.posts).toEqual([{ message: { t: 'unsupported', reason: 'no-service-worker' }, target: CONSOLE }])

    const blocked = harness({ registerFails: true })
    blocked.run()
    await vi.runAllTimersAsync()
    expect(sent(blocked)).toEqual([{ t: 'unsupported', reason: 'registration-failed' }])
  })

  it('registers the worker for scope / and tells the console it is ready', async () => {
    const h = harness()
    h.run()
    await vi.runAllTimersAsync()
    expect(h.register).toHaveBeenCalledWith('/__ac/sw.js', { scope: '/', updateViaCache: 'none' })
    expect(h.posts).toEqual([{ message: { t: 'ready' }, target: CONSOLE }])
  })

  it('accepts the port only from the console and opens the entry once the worker holds it', async () => {
    const h = harness()
    h.run()
    await vi.runAllTimersAsync()
    h.fromConsole({ t: 'port', entry: '/index.html' }, { origin: 'https://evil.example.test' })
    h.fromConsole({ t: 'port', entry: '/index.html' }, { source: {} })
    expect(h.worker.postMessage).not.toHaveBeenCalled()

    h.fromConsole({ t: 'port', entry: '/docs/index.html' })
    expect(h.worker.postMessage).toHaveBeenCalledWith({ t: 'port' }, [port])
    expect(h.appended).toEqual([])
    h.fromWorker({ t: 'port-ok' })
    expect(h.appended).toEqual([h.frame])
    expect(h.frame.src).toBe('/docs/index.html')

    // A later port, answering need-port, opens nothing new.
    h.fromConsole({ t: 'port', entry: '/other.html' })
    h.fromWorker({ t: 'port-ok' })
    expect(h.appended).toHaveLength(1)
  })

  it('forwards the worker asking for a port', async () => {
    const h = harness()
    h.run()
    await vi.runAllTimersAsync()
    h.fromWorker({ t: 'need-port' })
    expect(sent(h)).toEqual([{ t: 'ready' }, { t: 'need-port' }])
  })

  it('reports the nested path on load and on history changes, coalesced', async () => {
    const h = harness()
    h.run()
    await vi.runAllTimersAsync()
    h.fromConsole({ t: 'port', entry: '/index.html' })
    h.fromWorker({ t: 'port-ok' })
    h.load('/index.html')
    await vi.advanceTimersByTimeAsync(SHIM_REPORT_MS)
    expect(sent(h).at(-1)).toEqual({ t: 'path', path: '/index.html' })

    for (const path of ['/a', '/b', '/c']) h.nested.history.pushState(null, '', path)
    h.nested.history.replaceState(null, '', '/d')
    await vi.advanceTimersByTimeAsync(SHIM_REPORT_MS)
    expect(sent(h).filter((m) => (m as { t: string }).t === 'path')).toEqual([
      { t: 'path', path: '/index.html' },
      { t: 'path', path: '/d' }
    ])

    h.nested.location.pathname = '/c'
    ;(h.nestedListeners.popstate as () => void)()
    await vi.advanceTimersByTimeAsync(SHIM_REPORT_MS)
    expect(sent(h).at(-1)).toEqual({ t: 'path', path: '/c' })
    expect(h.posts.every((p) => (p as { target: string }).target === CONSOLE)).toBe(true)
  })
})

describe('shimDocument', () => {
  it('admits only its own script and style, and only the console may frame it', () => {
    const { html, csp } = shimDocument(CONSOLE)
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!
    const style = /<style>([\s\S]*)<\/style>/.exec(html)![1]!
    const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      `script-src ${hash(script)}`,
      `style-src ${hash(style)}`,
      "worker-src 'self'",
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${CONSOLE}`
    ])
  })

  it('runs on its own, with the console origin embedded', () => {
    const { html } = shimDocument(CONSOLE)
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!
    const parent = { postMessage: vi.fn() }
    const window = { parent, location: { origin: ORIGIN }, navigator: {} }
    runInNewContext(script, { window, URL })
    expect(parent.postMessage).toHaveBeenCalledWith({ t: 'unsupported', reason: 'no-service-worker' }, CONSOLE)
  })
})
