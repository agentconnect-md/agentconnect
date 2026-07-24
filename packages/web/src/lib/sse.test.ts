import { describe, expect, it, vi } from 'vitest'
import { createSseParser } from './sse'

describe('createSseParser', () => {
  it('parses an event split across arbitrary chunks', () => {
    const onEvent = vi.fn()
    const parser = createSseParser(onEvent)

    parser.push(': connected\n\neve')
    parser.push('nt: session\r\nda')
    parser.push('ta: {"sessionId":"s1"}\r\n\r\n')

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith({ event: 'session', data: '{"sessionId":"s1"}' })
  })

  it('joins multi-line data and resets the event name after dispatch', () => {
    const events: { event: string; data: string }[] = []
    const parser = createSseParser((event) => events.push(event))

    parser.push('event: session\ndata: first\ndata: second\n\ndata: plain\n\n')

    expect(events).toEqual([
      { event: 'session', data: 'first\nsecond' },
      { event: 'message', data: 'plain' }
    ])
  })

  it('ignores comments and incomplete events', () => {
    const onEvent = vi.fn()
    const parser = createSseParser(onEvent)

    parser.push(': keepalive\n\nevent: session\ndata: incomplete')

    expect(onEvent).not.toHaveBeenCalled()
  })
})
