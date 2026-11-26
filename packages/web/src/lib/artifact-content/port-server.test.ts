import { describe, expect, it, vi } from 'vitest'
import {
  ByteCache,
  createPortServer,
  manifestPathOf,
  MAX_OPEN_PORTS,
  readContentRequest,
  replyType,
  servedPath,
  type PortServerFile
} from './port-server'
import { OPEN_RANGE_CAP, type ContentAck, type ContentReply } from './protocol'

const enc = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const dec = (body: ArrayBuffer | null) => (body ? new TextDecoder().decode(body) : null)

const SITE: Record<string, [string, ArrayBuffer]> = {
  'index.html': ['text/html', enc('<h1>index</h1>')],
  'docs/index.html': ['text/html', enc('<h1>docs</h1>')],
  'docs/a b.html': ['text/html', enc('<h1>spaced</h1>')],
  'assets/app.js': ['text/javascript', enc('window.ok = 1')],
  'media/tone.wav': ['audio/wav', new Uint8Array(OPEN_RANGE_CAP * 2).buffer]
}
const FILES: PortServerFile[] = Object.entries(SITE).map(([path, [mediaType, body]]) => ({
  path,
  mediaType,
  bytes: body.byteLength
}))

function serve(options: { entry?: string; cacheBytes?: number; fail?: string } = {}) {
  const load = vi.fn(async (file: PortServerFile) => {
    if (file.path === options.fail) throw new Error('403')
    return SITE[file.path]![1].slice(0)
  })
  const server = createPortServer({
    files: FILES,
    entry: options.entry ?? 'index.html',
    load,
    ...(options.cacheBytes === undefined ? {} : { cacheBytes: options.cacheBytes })
  })
  const ask = async (path: string, { navigate = false, range = null as string | null } = {}) => {
    const posts: (ContentAck | ContentReply)[] = []
    await server.handle({ id: 7, path, navigate, range }, (message) => posts.push(message))
    const reply = posts.find((m): m is ContentReply => !('ack' in m))!
    return { posts, reply, acked: posts.some((m) => 'ack' in m) }
  }
  return { server, load, ask }
}

describe('readContentRequest', () => {
  it('takes only the worker request shape', () => {
    expect(readContentRequest({ id: 1, path: '/a', navigate: false, range: null })).toEqual({
      id: 1,
      path: '/a',
      navigate: false,
      range: null
    })
    expect(readContentRequest({ id: 1, path: '/a', navigate: true, range: 'bytes=0-' })?.range).toBe('bytes=0-')
  })

  it.each([
    null,
    'x',
    { id: '1', path: '/a', navigate: false, range: null },
    { id: 1.5, path: '/a', navigate: false, range: null },
    { id: -1, path: '/a', navigate: false, range: null },
    { id: 1, path: 'a', navigate: false, range: null },
    { id: 1, path: `/${'a'.repeat(5000)}`, navigate: false, range: null },
    { id: 1, path: '/a', navigate: 'yes', range: null },
    { id: 1, path: '/a', navigate: false, range: 5 },
    { id: 1, path: '/a', navigate: false }
  ])('refuses %j', (data) => expect(readContentRequest(data)).toBeNull())
})

describe('manifestPathOf', () => {
  const has = (path: string) => path in SITE

  it.each([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/docs/', 'docs/index.html'],
    ['/docs/a%20b.html', 'docs/a b.html'],
    ['/assets/app.js', 'assets/app.js']
  ])('maps %j to %j', (request, path) => expect(manifestPathOf(request, has)).toBe(path))

  it.each(['/docs', '/missing.js', '/assets%2Fapp.js', '/%E0%A4%A', '/assets//app.js', 'index.html'])(
    'finds nothing for %j',
    (request) => expect(manifestPathOf(request, has)).toBeNull()
  )

  it('serves a manifest path under its encoded segments', () => {
    expect(servedPath('docs/a b.html')).toBe('/docs/a%20b.html')
    expect(servedPath('q?#.html')).toBe('/q%3F%23.html')
  })

  it('names UTF-8 for text without a charset', () => {
    expect(replyType('text/html')).toBe('text/html; charset=utf-8')
    expect(replyType('application/json')).toBe('application/json; charset=utf-8')
    expect(replyType('text/html; charset=iso-8859-1')).toBe('text/html; charset=iso-8859-1')
    expect(replyType('image/png')).toBe('image/png')
  })
})

describe('createPortServer', () => {
  it('answers a manifest file typed by the manifest', async () => {
    const { reply } = await serve().ask('/assets/app.js')
    expect(reply).toMatchObject({ id: 7, status: 200, type: 'text/javascript; charset=utf-8' })
    expect(dec(reply.body)).toBe('window.ok = 1')
  })

  it('answers `/` and a directory with its index.html', async () => {
    const { ask } = serve()
    expect(dec((await ask('/', { navigate: true })).reply.body)).toBe('<h1>index</h1>')
    expect(dec((await ask('/docs/', { navigate: true })).reply.body)).toBe('<h1>docs</h1>')
  })

  it('answers a navigation outside the manifest with the entry, so history routing works', async () => {
    const { ask } = serve({ entry: 'docs/index.html' })
    const { reply } = await ask('/app/settings', { navigate: true })
    expect(reply.status).toBe(200)
    expect(dec(reply.body)).toBe('<h1>docs</h1>')
  })

  it('answers any other path outside the manifest 404 without fetching', async () => {
    const { ask, load } = serve()
    for (const path of ['/missing.json', '/__ac/sw.js', '/../index.html.bak', '/assets%2Fapp.js']) {
      const { reply, acked } = await ask(path)
      expect(reply).toEqual({ id: 7, status: 404, type: 'text/plain; charset=utf-8', body: null })
      expect(acked).toBe(false)
    }
    expect(load).not.toHaveBeenCalled()
  })

  it('acknowledges a request it must fetch, and not one the cache answers', async () => {
    const { ask } = serve()
    const first = await ask('/media/tone.wav')
    expect(first.posts[0]).toEqual({ id: 7, ack: true })
    expect((await ask('/media/tone.wav')).acked).toBe(false)
  })

  it('answers ranges with 206 from one fetch, and an unranged request whole', async () => {
    const { ask, load } = serve()
    const size = OPEN_RANGE_CAP * 2
    const open = (await ask('/media/tone.wav', { range: 'bytes=0-' })).reply
    expect(open).toMatchObject({ status: 206, type: 'audio/wav', start: 0, end: OPEN_RANGE_CAP - 1, size })
    expect(open.body!.byteLength).toBe(OPEN_RANGE_CAP)
    const tail = (await ask('/media/tone.wav', { range: 'bytes=-10' })).reply
    expect(tail).toMatchObject({ status: 206, start: size - 10, end: size - 1, size })
    const whole = (await ask('/media/tone.wav')).reply
    expect(whole.status).toBe(200)
    expect(whole.body!.byteLength).toBe(size)
    expect((await ask('/media/tone.wav', { range: `bytes=${size}-` })).reply.status).toBe(416)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares one fetch between concurrent requests and acknowledges each while it is in flight', async () => {
    const { server, load } = serve()
    const post = vi.fn()
    await Promise.all([
      server.handle({ id: 1, path: '/index.html', navigate: true, range: null }, post),
      server.handle({ id: 2, path: '/index.html', navigate: false, range: null }, post)
    ])
    expect(load).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith({ id: 1, ack: true }, [])
    expect(post).toHaveBeenCalledWith({ id: 2, ack: true }, [])
  })

  it('answers 502 when the bytes cannot be fetched, and fetches again next time', async () => {
    const { ask, load } = serve({ fail: 'assets/app.js' })
    expect((await ask('/assets/app.js')).reply.status).toBe(502)
    expect((await ask('/assets/app.js')).reply.status).toBe(502)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reads the entry for the srcdoc fallback through the same cache', async () => {
    const { server, load, ask } = serve()
    expect(dec(await server.file('index.html'))).toBe('<h1>index</h1>')
    await ask('/index.html')
    expect(load).toHaveBeenCalledTimes(1)
    await expect(server.file('elsewhere.html')).rejects.toThrow()
  })

  it('answers over a real port and ignores malformed messages', async () => {
    const { server } = serve()
    const port = server.port()
    const replies: unknown[] = []
    const got = new Promise<void>((resolve) => {
      port.onmessage = (event) => {
        replies.push(event.data)
        if (!('ack' in event.data)) resolve()
      }
    })
    port.postMessage({ id: 1, path: '/index.html', navigate: 'x', range: null })
    port.postMessage({ id: 2, path: '/index.html', navigate: true, range: null })
    await got
    expect(replies.map((r) => (r as { id: number }).id)).toEqual([2, 2])
    expect(dec((replies[1] as ContentReply).body)).toBe('<h1>index</h1>')
    server.close()
    port.close()
  })

  it('keeps a bounded number of ports open', () => {
    const { server } = serve()
    const close = vi.spyOn(MessagePort.prototype, 'close')
    for (let i = 0; i < MAX_OPEN_PORTS + 3; i++) server.port().close()
    expect(close).toHaveBeenCalledTimes(MAX_OPEN_PORTS + 3 + 3)
    close.mockRestore()
    server.close()
  })
})

describe('ByteCache', () => {
  const buffer = (n: number) => Promise.resolve(new ArrayBuffer(n))

  it('drops the least recently used file past its byte bound', async () => {
    const cache = new ByteCache(10)
    await cache.get('a', 4, () => buffer(4))
    await cache.get('b', 4, () => buffer(4))
    await cache.get('a', 4, () => buffer(4))
    await cache.get('c', 4, () => buffer(4))
    expect([cache.has('a'), cache.has('b'), cache.has('c')]).toEqual([true, false, true])
    expect(cache.size).toBe(8)
  })

  it('never holds a file larger than the bound', async () => {
    const cache = new ByteCache(10)
    await cache.get('big', 11, () => buffer(11))
    expect(cache.has('big')).toBe(false)
    expect(cache.size).toBe(0)
  })

  it('forgets a failed fetch', async () => {
    const cache = new ByteCache(10)
    await expect(cache.get('a', 4, () => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(cache.has('a')).toBe(false)
    expect(cache.size).toBe(0)
  })

  it('bounds a revision server by its byte budget', async () => {
    const { ask, load } = serve({ cacheBytes: OPEN_RANGE_CAP })
    await ask('/media/tone.wav')
    await ask('/media/tone.wav')
    expect(load).toHaveBeenCalledTimes(2)
    await ask('/index.html')
    await ask('/index.html')
    expect(load).toHaveBeenCalledTimes(3)
  })
})
