import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({
  getAccountToken: vi.fn(async () => 'account-token'),
  getToken: vi.fn(async () => undefined),
  getIdTokenRaw: vi.fn(async () => undefined),
  getUser: vi.fn(async () => undefined),
  signOutDeletedAccount: vi.fn()
}))

import { subscribeSessionEvents } from './api'

describe('subscribeSessionEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('invalidates on connect and session events, then aborts on cleanup', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let requestSignal!: AbortSignal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      }
    })
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal
      requestSignal.addEventListener('abort', () => streamController.error(new DOMException('aborted', 'AbortError')), {
        once: true
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onConnect = vi.fn()
    const onSession = vi.fn()
    const onActivity = vi.fn()

    const unsubscribe = subscribeSessionEvents('org / 407', { onConnect, onSession, onActivity })

    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/api/v1/orgs/org%20%2F%20407/stream',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).accept).toBe('text/event-stream')
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['x-ac-logto-account-token']).toBe(
      'account-token'
    )

    const encoder = new TextEncoder()
    streamController.enqueue(encoder.encode('event: sess'))
    streamController.enqueue(encoder.encode('ion\ndata: {"sessionId":"s407"}\n\n'))
    await vi.waitFor(() => expect(onSession).toHaveBeenCalledTimes(1))

    streamController.enqueue(
      encoder.encode(
        'event: session-activity\ndata: {"activity":{"sessionId":"s407","agentId":"a407","revision":"12","ts":"2026-07-27T00:00:00.000Z"}}\n\n'
      )
    )
    await vi.waitFor(() =>
      expect(onActivity).toHaveBeenCalledWith({
        sessionId: 's407',
        agentId: 'a407',
        revision: '12',
        ts: '2026-07-27T00:00:00.000Z'
      })
    )

    unsubscribe()
    expect(requestSignal.aborted).toBe(true)
  })
})
