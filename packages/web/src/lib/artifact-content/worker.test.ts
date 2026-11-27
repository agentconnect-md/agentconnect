import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentRequest } from './protocol'
import {
  fetchRoute,
  isShimClient,
  readReply,
  responseParts,
  servesClient,
  WORKER_CONFIG,
  workerMain,
  workerScript,
  type ClientLike,
  type PortLike,
  type WorkerScope
} from './worker'

const ORIGIN = 'https://a0123456789abcdef0123456789abcdefr1.example-usercontent.net'
const CONSOLE = 'https://console.example.test'
const ANCESTORS = `frame-ancestors 'self' ${CONSOLE}`
const LIB = { fetchRoute, servesClient, isShimClient, readReply, responseParts }

const client = (id: string, path: string, frameType: string, type = 'window'): ClientLike => ({
  id,
  url: `${ORIGIN}${path}`,
  type,
  frameType,
  postMessage: vi.fn()
})

describe('fetchRoute', () => {
  const route = (path: string, mode = 'no-cors', destination = 'script', method = 'GET') =>
    fetchRoute({ url: path.startsWith('http') ? path : `${ORIGIN}${path}`, method, mode, destination }, ORIGIN)

  it('answers iframe navigations and same-origin reads', () => {
    expect(route('/about.html', 'navigate', 'iframe')).toBe('navigate')
    expect(route('/about.html', 'navigate', 'frame')).toBe('navigate')
    expect(route('/app.js')).toBe('subresource')
    expect(route('/media.mp4', 'no-cors', 'video', 'HEAD')).toBe('subresource')
  })

  it('never answers a top-level navigation, /__ac/, another origin or a write', () => {
    expect(route('/about.html', 'navigate', 'document')).toBe('network')
    expect(route('/doc.pdf', 'navigate', 'object')).toBe('network')
    expect(route('/doc.pdf', 'navigate', 'embed')).toBe('network')
    expect(route('/__ac/shim', 'navigate', 'iframe')).toBe('network')
    expect(route('/__ac/sw.js')).toBe('network')
    expect(route('https://cdn.example.test/lib.js')).toBe('network')
    expect(route('/api', 'cors', '', 'POST')).toBe('network')
  })
})

describe('client rules', () => {
  it('serves nested frames and workers, never a top-level or popup window', () => {
    expect(servesClient({ type: 'window', frameType: 'nested' })).toBe(true)
    expect(servesClient({ type: 'worker', frameType: 'none' })).toBe(true)
    expect(servesClient({ type: 'sharedworker', frameType: 'none' })).toBe(true)
    expect(servesClient({ type: 'window', frameType: 'top-level' })).toBe(false)
    expect(servesClient({ type: 'window', frameType: 'auxiliary' })).toBe(false)
    expect(servesClient(undefined)).toBe(false)
  })

  it('takes ports only from a framed shim of its own origin', () => {
    expect(isShimClient(client('s', '/__ac/shim', 'nested'), ORIGIN)).toBe(true)
    expect(isShimClient(client('s', '/__ac/shim', 'top-level'), ORIGIN)).toBe(false)
    expect(isShimClient(client('s', '/index.html', 'nested'), ORIGIN)).toBe(false)
    expect(isShimClient({ ...client('s', '/__ac/shim', 'nested'), url: `${CONSOLE}/__ac/shim` }, ORIGIN)).toBe(false)
    expect(isShimClient(null, ORIGIN)).toBe(false)
  })
})

describe('readReply', () => {
  const body = new ArrayBuffer(10)

  it('accepts an acknowledgement and well-formed replies', () => {
    expect(readReply({ id: 1, ack: true })).toEqual({ id: 1, ack: true })
    expect(readReply({ id: 2, status: 200, type: 'text/html', body })).toEqual({
      id: 2,
      status: 200,
      type: 'text/html',
      body
    })
    expect(readReply({ id: 3, status: 404, type: 'text/plain', body: null })).toMatchObject({ status: 404 })
    expect(readReply({ id: 4, status: 206, type: 'video/mp4', body, start: 10, end: 19, size: 100 })).toMatchObject({
      start: 10,
      end: 19,
      size: 100
    })
  })

  it.each([
    null,
    'x',
    { status: 200, type: 'text/html', body },
    { id: 1.5, status: 200, type: 'text/html', body },
    { id: 1, status: 99, type: 'text/html', body },
    { id: 1, status: 200, type: 'text/html\r\nSet-Cookie: a=b', body },
    { id: 1, status: 200, type: 'text/html', body: 'text' },
    { id: 1, status: 206, type: 'video/mp4', body, start: 0, end: 10, size: 100 },
    { id: 1, status: 206, type: 'video/mp4', body, start: 95, end: 104, size: 100 },
    { id: 1, status: 206, type: 'video/mp4', body: null, start: 0, end: 9, size: 100 }
  ])('refuses %j', (data) => expect(readReply(data)).toBeNull())
})

describe('responseParts', () => {
  const body = new ArrayBuffer(4)

  it('types the response by the reply and frames navigations only under the console', () => {
    expect(responseParts({ id: 1, status: 200, type: 'text/html', body }, true, ANCESTORS)).toEqual({
      status: 200,
      body,
      headers: {
        'Content-Type': 'text/html',
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': ANCESTORS
      }
    })
    expect(responseParts({ id: 1, status: 200, type: 'text/css', body }, false, ANCESTORS).headers).not.toHaveProperty(
      'Content-Security-Policy'
    )
  })

  it('adds Content-Range to a 206 and drops the body of a null-body status', () => {
    const part = responseParts({ id: 1, status: 206, type: 'audio/wav', body, start: 4, end: 7, size: 8 }, false, '')
    expect(part.headers['Content-Range']).toBe('bytes 4-7/8')
    expect(responseParts({ id: 1, status: 304, type: 'text/html', body }, false, '').body).toBeNull()
  })
})

type Listener = (event: never) => void

/** A worker scope with a console that answers from a two-file manifest, and shims that hand it fresh ports. */
function harness() {
  const listeners: Record<string, Listener> = {}
  const windows = new Map<string, ClientLike>()
  const requests: ContentRequest[] = []
  const console = { answer: true, ack: false, delayMs: 0, ports: 0 }
  const files: Record<string, { type: string; text: string }> = {
    '/index.html': { type: 'text/html', text: '<h1>index</h1>' },
    '/app.js': { type: 'text/javascript', text: 'void 0' }
  }
  const newPort = (): PortLike => {
    console.ports++
    const port: PortLike = {
      onmessage: null,
      postMessage(message) {
        const request = message as ContentRequest
        requests.push(request)
        if (!console.answer) return
        if (console.ack) port.onmessage?.({ data: { id: request.id, ack: true } })
        const file = files[request.path] ?? (request.navigate ? files['/index.html'] : undefined)
        const body = file ? new TextEncoder().encode(file.text).buffer : null
        const reply = file
          ? { id: request.id, status: 200, type: file.type, body }
          : { id: request.id, status: 404, type: 'text/plain', body: null }
        const send = () => port.onmessage?.({ data: reply })
        if (console.delayMs) setTimeout(send, console.delayMs)
        else queueMicrotask(send)
      }
    }
    return port
  }
  const scope: WorkerScope = {
    location: { origin: ORIGIN },
    clients: {
      get: async (id) => windows.get(id),
      matchAll: async () => [...windows.values()].filter((c) => c.type === 'window')
    },
    skipWaiting: async () => {},
    addEventListener: ((type: string, listener: Listener) =>
      (listeners[type] = listener)) as WorkerScope['addEventListener'],
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    Response
  }
  const deliver = (source: ClientLike, port: PortLike) =>
    (listeners.message as (e: unknown) => void)({ source, data: { t: 'port' }, ports: [port] })
  const addShim = (id: string) => {
    const shim = client(id, '/__ac/shim', 'nested')
    // A shim asked for a port asks its console, which sends a fresh one.
    shim.postMessage = vi.fn((message: { t: string }) => {
      if (message.t === 'need-port') deliver(shim, newPort())
    })
    windows.set(id, shim)
    return shim
  }
  const fetch = (
    path: string,
    init: { mode?: string; destination?: string; clientId?: string; range?: string } = {}
  ) => {
    let responded: Promise<unknown> | undefined
    ;(listeners.fetch as (e: unknown) => void)({
      request: {
        url: `${ORIGIN}${path}`,
        method: 'GET',
        mode: init.mode ?? 'no-cors',
        destination: init.destination ?? 'script',
        headers: { get: (name: string) => (name === 'range' ? (init.range ?? null) : null) }
      },
      clientId: init.clientId ?? '',
      respondWith: (response: Promise<unknown>) => (responded = response)
    })
    return responded as Promise<Response> | undefined
  }
  const state = workerMain(scope, { ancestors: ANCESTORS, ...WORKER_CONFIG }, LIB)
  return { state, windows, requests, console, addShim, deliver, newPort, fetch, listeners }
}

describe('workerMain', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('takes a port only from a framed shim and acknowledges it', () => {
    const h = harness()
    const shim = h.addShim('shim')
    h.deliver(shim, h.newPort())
    expect(shim.postMessage).toHaveBeenCalledWith({ t: 'port-ok' })
    expect(h.state.ports.size).toBe(1)

    const page = client('page', '/index.html', 'nested')
    h.deliver(page, h.newPort())
    expect(page.postMessage).not.toHaveBeenCalled()
    expect(h.state.ports.size).toBe(1)
  })

  it('answers an iframe navigation from the console, framed only under the console', async () => {
    const h = harness()
    h.deliver(h.addShim('shim'), h.newPort())
    const response = await h.fetch('/app/settings', { mode: 'navigate', destination: 'iframe' })!
    expect(h.requests).toEqual([{ id: 1, path: '/app/settings', navigate: true, range: null }])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(ANCESTORS)
    expect(await response.text()).toBe('<h1>index</h1>')
  })

  it('never answers a top-level navigation or /__ac/', () => {
    const h = harness()
    expect(h.fetch('/index.html', { mode: 'navigate', destination: 'document' })).toBeUndefined()
    expect(h.fetch('/__ac/shim', { mode: 'navigate', destination: 'iframe' })).toBeUndefined()
  })

  it('answers subresources for nested clients only, passing Range through', async () => {
    const h = harness()
    h.deliver(h.addShim('shim'), h.newPort())
    h.windows.set('top', client('top', '/index.html', 'top-level'))
    h.windows.set('nested', client('nested', '/index.html', 'nested'))
    expect((await h.fetch('/app.js', { clientId: 'top' })!).status).toBe(404)
    expect((await h.fetch('/app.js', { clientId: '' })!).status).toBe(404)
    expect(h.requests).toEqual([])

    const ok = await h.fetch('/app.js', { clientId: 'nested', range: 'bytes=0-' })!
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('text/javascript')
    expect(ok.headers.get('content-security-policy')).toBeNull()
    expect(h.requests).toEqual([{ id: 1, path: '/app.js', navigate: false, range: 'bytes=0-' }])
    expect((await h.fetch('/missing.json', { clientId: 'nested' })!).status).toBe(404)
  })

  it('asks the console for the pathname alone, as the browser encoded it', async () => {
    const h = harness()
    h.deliver(h.addShim('shim'), h.newPort())
    h.windows.set('nested', client('nested', '/index.html', 'nested'))
    for (const path of ['/a/../../b.html?x=1#h', '/hostile/..%2f..%2fb.html', '/%2e%2e/b.html', '//b.html'])
      expect((await h.fetch(path, { clientId: 'nested' })!).status).toBe(404)
    expect(h.requests.map((r) => r.path)).toEqual(['/b.html', '/hostile/..%2f..%2fb.html', '/b.html', '//b.html'])
  })

  it('drops the port of a vanished shim and asks every live shim for one', async () => {
    const h = harness()
    const gone = h.addShim('gone')
    h.deliver(gone, h.newPort())
    h.windows.delete('gone')
    const a = h.addShim('a')
    const b = h.addShim('b')
    const response = await h.fetch('/index.html', { mode: 'navigate', destination: 'iframe' })!
    expect(response.status).toBe(200)
    expect(h.state.ports.has('gone')).toBe(false)
    expect(a.postMessage).toHaveBeenCalledWith({ t: 'need-port' })
    expect(b.postMessage).toHaveBeenCalledWith({ t: 'need-port' })
  })

  it('asks once for a port however many requests wait on it', async () => {
    const h = harness()
    const shim = h.addShim('shim')
    const nav = { mode: 'navigate', destination: 'iframe' }
    await Promise.all([h.fetch('/index.html', nav)!, h.fetch('/about.html', nav)!])
    expect(vi.mocked(shim.postMessage).mock.calls.filter(([m]) => (m as { t: string }).t === 'need-port')).toHaveLength(
      1
    )
  })

  it('retries once on a fresh port when a port stays silent', async () => {
    const h = harness()
    const shim = h.addShim('shim')
    h.console.answer = false
    h.deliver(shim, h.newPort())
    const pending = h.fetch('/index.html', { mode: 'navigate', destination: 'iframe' })!
    await vi.advanceTimersByTimeAsync(WORKER_CONFIG.replyMs - 1)
    h.console.answer = true
    await vi.advanceTimersByTimeAsync(1)
    const response = await pending
    expect(response.status).toBe(200)
    expect(h.requests.map((r) => r.id)).toEqual([1, 2])
    expect(h.console.ports).toBe(2)
  })

  it('answers 504 when no port answers or no shim is left', async () => {
    const h = harness()
    expect((await h.fetch('/index.html', { mode: 'navigate', destination: 'iframe' })!).status).toBe(504)

    h.addShim('shim')
    h.console.answer = false
    const pending = h.fetch('/index.html', { mode: 'navigate', destination: 'iframe' })!
    await vi.advanceTimersByTimeAsync(2 * WORKER_CONFIG.replyMs)
    const response = await pending
    expect(response.status).toBe(504)
    expect(response.headers.get('content-security-policy')).toBe(ANCESTORS)
    expect(h.requests).toHaveLength(2)
  })

  it('waits the long deadline once the console acknowledges, without retrying', async () => {
    const h = harness()
    h.deliver(h.addShim('shim'), h.newPort())
    Object.assign(h.console, { ack: true, delayMs: 10_000 })
    const pending = h.fetch('/index.html', { mode: 'navigate', destination: 'iframe' })!
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await pending).status).toBe(200)
    expect(h.requests).toHaveLength(1)

    h.console.delayMs = WORKER_CONFIG.answerMs + 1
    const late = h.fetch('/index.html', { mode: 'navigate', destination: 'iframe' })!
    await vi.advanceTimersByTimeAsync(WORKER_CONFIG.answerMs)
    expect((await late).status).toBe(504)
    expect(h.requests).toHaveLength(2)
  })
})

describe('workerScript', () => {
  it('runs on its own, with the console origin embedded', async () => {
    const listeners: Record<string, (event: unknown) => void> = {}
    const self = {
      location: { origin: ORIGIN },
      clients: { get: async () => undefined, matchAll: async () => [] },
      skipWaiting: async () => {},
      addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      setTimeout,
      clearTimeout,
      Response
    }
    runInNewContext(workerScript(CONSOLE), { self, URL, Promise, Map, Number, ArrayBuffer })
    expect(Object.keys(listeners).sort()).toEqual(['fetch', 'install', 'message'])
    let responded: Promise<Response> | undefined
    listeners.fetch!({
      request: {
        url: `${ORIGIN}/index.html`,
        method: 'GET',
        mode: 'navigate',
        destination: 'iframe',
        headers: new Headers()
      },
      clientId: '',
      respondWith: (r: Promise<Response>) => (responded = r)
    })
    const response = await responded!
    expect(response.status).toBe(504)
    expect(response.headers.get('content-security-policy')).toBe(ANCESTORS)
  })
})
