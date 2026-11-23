import type { LookupAddress } from 'node:dns'
import { fetch as undiciFetch, FormData as UndiciFormData, MockAgent, Response as UndiciResponse } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MATTERMOST_DEFAULT_MAX_POST_SIZE,
  MattermostApiError,
  MattermostClient,
  MattermostTransportError,
  mattermostWebSocketUrl,
  type MattermostWsEvent
} from '../src/platforms/mattermost/client.js'
import { makeMattermostLookup, validateMattermostServerUrl } from '../src/platforms/mattermost/media.js'
import { parseRetryAfterMs } from '../src/platforms/mattermost/rate-limit.js'
import { FakeMattermostServer, quietLog } from './fakes/mattermost-server.js'

const TOKEN = 'mm-secret-token-value'
const clients: MattermostClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop()
  vi.useRealTimers()
})

function setup(
  opts: {
    serverUrl?: string
    log?: typeof quietLog
    timing?: ConstructorParameters<typeof MattermostClient>[0]['timing']
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  } = {}
) {
  const server = new FakeMattermostServer({
    ...(opts.serverUrl ? { serverUrl: opts.serverUrl } : {}),
    botToken: TOKEN
  })
  const events: MattermostWsEvent[] = []
  const onReconnect = vi.fn()
  const client = new MattermostClient({
    serverUrl: server.serverUrl,
    botToken: TOKEN,
    onEvent: (ev) => events.push(ev),
    onReconnect,
    log: opts.log ?? quietLog,
    createSocket: server.createSocket,
    fetchImpl: server.fetchImpl,
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {})
  })
  clients.push(client)
  return { server, client, events, onReconnect }
}

describe('Mattermost serverUrl self-hosted policy', () => {
  it('allows http/https, private/loopback/intranet hosts, and preserves subpaths', () => {
    expect(validateMattermostServerUrl('https://chat.example.com/')).toEqual({
      ok: true,
      serverUrl: 'https://chat.example.com'
    })
    expect(validateMattermostServerUrl('http://localhost:8065/mm/')).toEqual({
      ok: true,
      serverUrl: 'http://localhost:8065/mm'
    })
    expect(validateMattermostServerUrl('http://127.0.0.1:8065')).toEqual({
      ok: true,
      serverUrl: 'http://127.0.0.1:8065'
    })
    expect(validateMattermostServerUrl('http://10.20.30.40:8065/team/')).toEqual({
      ok: true,
      serverUrl: 'http://10.20.30.40:8065/team'
    })
    expect(validateMattermostServerUrl('https://192.168.1.50/subpath')).toEqual({
      ok: true,
      serverUrl: 'https://192.168.1.50/subpath'
    })
    expect(validateMattermostServerUrl('http://[::1]:8065/')).toEqual({
      ok: true,
      serverUrl: 'http://[::1]:8065'
    })
    expect(validateMattermostServerUrl('http://[fe8::1]:8065')).toEqual({
      ok: true,
      serverUrl: 'http://[fe8::1]:8065'
    })
  })

  it('rejects link-local metadata, unspecified, non-http(s), userinfo, query, and fragment URLs', () => {
    for (const bad of [
      'http://169.254.169.254/latest/meta-data',
      'http://[::ffff:169.254.169.254]/',
      'http://[fe80::1]:8065',
      'http://0.0.0.0:8065',
      'http://[::]:8065',
      'http://[::ffff:0.0.0.0]:8065',
      'ftp://mattermost.example.com',
      'ws://mattermost.example.com',
      'https://user:pass@mattermost.example.com',
      'https://mattermost.example.com?foo=bar',
      'https://mattermost.example.com#frag',
      'not a url'
    ]) {
      expect(validateMattermostServerUrl(bad).ok).toBe(false)
    }
  })

  it('allows private/loopback DNS answers while blocking link-local and unspecified addresses', async () => {
    const resolveTo = (addresses: LookupAddress[]) =>
      ((_host: string, _options: unknown, callback: (e: null, a: LookupAddress[]) => void) =>
        callback(null, addresses)) as unknown as typeof import('node:dns').lookup
    const ask = (addresses: LookupAddress[]) =>
      new Promise<unknown>((resolve) =>
        makeMattermostLookup(resolveTo(addresses))('mm.internal', { all: false }, (err, addr) =>
          resolve(err ? 'blocked' : addr)
        )
      )

    expect(await ask([{ address: '127.0.0.1', family: 4 }])).toBe('127.0.0.1')
    expect(await ask([{ address: '10.0.0.5', family: 4 }])).toBe('10.0.0.5')
    expect(await ask([{ address: '192.168.1.10', family: 4 }])).toBe('192.168.1.10')
    expect(await ask([{ address: '169.254.169.254', family: 4 }])).toBe('blocked')
    expect(await ask([{ address: 'fe80::1', family: 6 }])).toBe('blocked')
    expect(await ask([{ address: '0.0.0.0', family: 4 }])).toBe('blocked')
    expect(await ask([{ address: '::', family: 6 }])).toBe('blocked')
    expect(
      await ask([
        { address: '10.0.0.5', family: 4 },
        { address: '169.254.169.254', family: 4 }
      ])
    ).toBe('blocked')
  })

  it('builds ws/wss websocket URLs preserving subpaths', () => {
    expect(mattermostWebSocketUrl('https://chat.example.com')).toBe('wss://chat.example.com/api/v4/websocket')
    expect(mattermostWebSocketUrl('http://10.0.0.5:8065/mm')).toBe('ws://10.0.0.5:8065/mm/api/v4/websocket')
  })
})

describe('MattermostClient WebSocket & REST v4', () => {
  it('dials /api/v4/websocket without Bearer upgrade headers, authenticates via authentication_challenge, and delivers events', async () => {
    const { server, client, events } = setup({ serverUrl: 'https://chat.example.com/mm' })
    await client.start()

    expect(client.connected).toBe(true)
    expect(server.lastSocket.url).toBe('wss://chat.example.com/mm/api/v4/websocket')
    expect(server.lastSocket.headers).toBeUndefined()
    expect(server.lastSocket.sent[0]).toEqual({
      seq: 1,
      action: 'authentication_challenge',
      data: { token: TOKEN }
    })

    server.lastSocket.emitPosted({ id: server.nextId('p'), channel_id: 'ch1', user_id: 'u1', message: 'hi' })
    expect(events.map((e) => e.event)).toEqual(['posted'])
  })

  it('rejects start on failed authentication_challenge and never logs the token', async () => {
    const lines: string[] = []
    const capture = { ...quietLog, warn: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }
    const { server, client } = setup({ log: capture })
    server.rejectWsAuth = true
    const err = await client.start().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MattermostApiError)
    expect((err as MattermostApiError).status).toBe(401)
    expect(client.connected).toBe(false)
    expect(server.lastSocket.closedByClient).toBe(true)
    expect(lines.join('\n')).not.toContain(TOKEN)
  })

  it('pings on heartbeat and reconnects with exponential backoff capped at 30s', async () => {
    vi.useFakeTimers()
    const { server, client, onReconnect } = setup({
      timing: { heartbeatMs: 10_000, maxMissedPongs: 2, retryBaseMs: 2_000, retryMaxMs: 30_000, stableMs: 60_000 }
    })
    await client.start()
    const first = server.lastSocket

    await vi.advanceTimersByTimeAsync(10_000)
    expect(first.frames('ping')).toHaveLength(1)

    server.silentPing = true
    await vi.advanceTimersByTimeAsync(20_000)
    expect(first.frames('ping')).toHaveLength(3)

    // Next heartbeat sees missedPongs === 2 and closes/reconnects
    await vi.advanceTimersByTimeAsync(10_000)
    expect(first.readyState).toBe(3)
    expect(client.connected).toBe(false)

    server.silentPing = false
    server.refuseOpens = 4
    // Advance past retries (capped at 30s each); 4 refused opens + 1 success easily finish within 120s
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.sockets.length).toBeGreaterThanOrEqual(6)
    expect(client.connected).toBe(true)
    expect(onReconnect).toHaveBeenCalled()
  })

  it('sends user_typing over the open websocket', async () => {
    const { server, client } = setup()
    await client.start()
    await client.sendTyping('chan-1', 'root-1')
    await client.sendTyping('chan-2')
    expect(server.lastSocket.frames('user_typing')).toEqual([
      { seq: 2, action: 'user_typing', data: { channel_id: 'chan-1', parent_id: 'root-1' } },
      { seq: 3, action: 'user_typing', data: { channel_id: 'chan-2', parent_id: '' } }
    ])
  })

  it('probes MaxPostSize from /api/v4/config/client?format=old and falls back to 4000', async () => {
    const { server, client } = setup()
    server.maxPostSize = '16383'
    expect(await client.getMaxPostSize()).toBe(16_383)

    server.maxPostSize = 'not-a-number'
    expect(await client.getMaxPostSize()).toBe(MATTERMOST_DEFAULT_MAX_POST_SIZE)

    server.enqueueFailure({ method: 'GET', pathPrefix: '/api/v4/config/client', status: 500 })
    expect(await client.getMaxPostSize()).toBe(MATTERMOST_DEFAULT_MAX_POST_SIZE)
  })

  it('uses PUT /api/v4/posts/{id}/patch (never PATCH) when patching posts', async () => {
    const { server, client } = setup()
    const ch = server.addChannel({ id: server.nextId('ch'), type: 'O', name: 'general' })
    const created = await client.createPost({ channel_id: ch.id, message: 'draft' })
    const patched = await client.patchPost(created.id, { message: 'final', props: { done: true } })
    expect(patched.message).toBe('final')
    expect(patched.props?.done).toBe(true)
    const patchReq = server.requests.find((r) => r.path === `/api/v4/posts/${created.id}/patch`)
    expect(patchReq?.method).toBe('PUT')
  })

  it('honors HTTP 429 Retry-After backoff across retries and parses headers', async () => {
    expect(parseRetryAfterMs({ 'Retry-After': '3' }, 1000)).toBe(3000)
    expect(parseRetryAfterMs({ 'x-ratelimit-reset': '5' }, 1000)).toBe(5000)
    expect(parseRetryAfterMs({ 'Retry-After': new Date(10_000).toUTCString() }, 4_000)).toBe(6_000)

    const slept: number[] = []
    let now = 1_000
    const { server, client } = setup({
      sleep: async (ms) => {
        slept.push(ms)
        now += ms
      },
      now: () => now
    })
    const ch = server.addChannel({ id: server.nextId('ch'), type: 'O', name: 'town-square' })
    server.enqueueFailure({
      method: 'POST',
      pathPrefix: '/api/v4/posts',
      status: 429,
      headers: { 'Retry-After': '2' },
      body: { id: 'api.rate_limit', message: 'Rate limited' }
    })
    const post = await client.createPost({ channel_id: ch.id, message: 'hello after 429' })
    expect(post.message).toBe('hello after 429')
    expect(slept).toEqual([2_000])
    expect(server.requests.filter((r) => r.path === '/api/v4/posts')).toHaveLength(2)
  })

  it('throws MattermostTransportError with maybeDelivered=true on POST network error and false on GET', async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error('socket hang up')
    }
    const client = new MattermostClient({
      serverUrl: 'https://mm.example.test',
      botToken: TOKEN,
      onEvent: () => {},
      log: quietLog,
      fetchImpl: failingFetch
    })
    clients.push(client)
    const getErr = await client.getMe().catch((e: unknown) => e)
    expect(getErr).toBeInstanceOf(MattermostTransportError)
    expect((getErr as MattermostTransportError).maybeDelivered).toBe(false)

    const postErr = await client.createPost({ channel_id: 'ch1', message: 'hi' }).catch((e: unknown) => e)
    expect(postErr).toBeInstanceOf(MattermostTransportError)
    expect((postErr as MattermostTransportError).maybeDelivered).toBe(true)
  })

  it('serializes uploadFiles as real multipart/form-data with filename under undiciFetch (not "[object FormData]")', async () => {
    const mockAgent = new MockAgent()
    mockAgent.disableNetConnect()
    let seenContentType = ''
    let seenBody: unknown
    mockAgent
      .get('https://mm.example.test')
      .intercept({ path: '/api/v4/files?channel_id=ch123', method: 'POST' })
      .reply(201, (opts) => {
        const headers = opts.headers as Record<string, string | string[] | undefined>
        seenContentType = String(headers['content-type'] ?? headers['Content-Type'] ?? '')
        seenBody = opts.body
        return { file_infos: [{ id: 'mmfile00000000000000000001', name: 'parity-badge-mm.md' }] }
      })

    const client = new MattermostClient({
      serverUrl: 'https://mm.example.test',
      botToken: TOKEN,
      onEvent: () => {},
      log: quietLog,
      fetchImpl: (input, init) =>
        undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher: mockAgent
        }) as unknown as Promise<Response>
    })
    clients.push(client)

    const uploaded = await client.uploadFiles('ch123', [
      { bytes: Buffer.from('# Mattermost Badge\n'), name: 'parity-badge-mm.md', mimeType: 'text/markdown' }
    ])
    await mockAgent.close()

    expect(uploaded).toEqual([{ id: 'mmfile00000000000000000001', name: 'parity-badge-mm.md' }])
    expect(seenContentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(seenBody).toBeInstanceOf(UndiciFormData)
    const formFiles = (seenBody as UndiciFormData).getAll('files')
    expect(formFiles).toHaveLength(1)
    const uploadedEntry = formFiles[0] as File
    expect(uploadedEntry.name).toBe('parity-badge-mm.md')
    expect(await uploadedEntry.text()).toBe('# Mattermost Badge\n')
    const wireText = await new UndiciResponse(seenBody as UndiciFormData).text()
    expect(wireText).toContain('Content-Disposition: form-data; name="files"; filename="parity-badge-mm.md"')
    expect(wireText).toContain('# Mattermost Badge')
    expect(wireText).not.toContain('[object FormData]')
  })

  it('estimates the server clock from REST Date headers and stays on the daemon clock without one', async () => {
    const server = new FakeMattermostServer({ botToken: TOKEN })
    const serverClock: { ms?: number } = {}
    const client = new MattermostClient({
      serverUrl: server.serverUrl,
      botToken: TOKEN,
      onEvent: () => undefined,
      log: quietLog,
      createSocket: server.createSocket,
      now: () => 1_000_000_000_000,
      fetchImpl: (async (input, init) => {
        const res = await server.fetchImpl(input, init)
        const headers = new Headers(res.headers)
        if (serverClock.ms !== undefined) headers.set('date', new Date(serverClock.ms).toUTCString())
        return new Response(res.body, { status: res.status, headers })
      }) as typeof fetch
    })
    clients.push(client)

    await client.getMe()
    expect(client.serverNow()).toBe(1_000_000_000_000)

    serverClock.ms = 1_000_000_000_000 - 90_000
    await client.getMe()
    expect(client.serverNow()).toBe(1_000_000_000_000 - 90_000)
  })
})
