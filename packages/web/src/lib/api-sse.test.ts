import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const onInvalidate = vi.fn()

    const unsubscribe = subscribeSessionEvents('org / 407', onInvalidate)

    await vi.waitFor(() => expect(onInvalidate).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/api/v1/orgs/org%20%2F%20407/stream',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).accept).toBe('text/event-stream')

    const encoder = new TextEncoder()
    streamController.enqueue(encoder.encode('event: sess'))
    streamController.enqueue(encoder.encode('ion\ndata: {"sessionId":"s407"}\n\n'))
    await vi.waitFor(() => expect(onInvalidate).toHaveBeenCalledTimes(2))

    unsubscribe()
    expect(requestSignal.aborted).toBe(true)
  })
})
