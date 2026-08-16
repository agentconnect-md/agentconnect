import { describe, it, expect } from 'vitest'
import type { WebSocket } from 'ws'
import { WsServerTransport } from './ws-server-transport.js'

class FakeWs {
  protocol = 'agentconnect.rd.v1'
  sent: string[] = []
  closed?: { code: number; reason: string }
  terminated = 0
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()
  terminate(): void {
    this.terminated += 1
  }
  send(text: string): void {
    this.sent.push(text)
  }
  on(event: string, cb: (...a: unknown[]) => void): this {
    const arr = this.handlers.get(event) ?? []
    arr.push(cb)
    this.handlers.set(event, arr)
    return this
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args)
  }
}

function make() {
  const ws = new FakeWs()
  const t = new WsServerTransport(ws as unknown as WebSocket, '10.0.0.1')
  return { ws, t }
}

describe('WsServerTransport', () => {
  it('exposes the negotiated subprotocol + remote address', () => {
    const { t } = make()
    expect(t.subprotocol).toBe('agentconnect.rd.v1')
    expect(t.remoteAddr).toBe('10.0.0.1')
  })

  it('send() writes text to the socket', () => {
    const { ws, t } = make()
    t.send('{"a":1}')
    expect(ws.sent).toEqual(['{"a":1}'])
  })

  it('onMessage delivers text frames and SKIPS binary frames (JSON-text-only wire)', () => {
    const { ws, t } = make()
    const got: string[] = []
    t.onMessage((m) => got.push(m))
    ws.emit('message', 'hello', false)
    ws.emit('message', Buffer.from('ignored'), true) // binary → skipped
    ws.emit('message', Buffer.from('world'), false) // buffer text → stringified
    expect(got).toEqual(['hello', 'world'])
  })

  it('onClose surfaces the code + reason (Buffer → string)', () => {
    const { ws, t } = make()
    let seen: { code: number; reason: string } | undefined
    t.onClose((code, reason) => (seen = { code, reason }))
    ws.emit('close', 1006, Buffer.from('gone'))
    expect(seen).toEqual({ code: 1006, reason: 'gone' })
  })

  it('close() closes the underlying socket', () => {
    const { ws, t } = make()
    t.close(4409, 'revoked')
    expect(ws.closed).toEqual({ code: 4409, reason: 'revoked' })
  })

  it('listens for socket errors from construction, so an oversized frame cannot go unhandled', () => {
    // A real ws socket THROWS on an unlistened 'error', and the peer raising it need not be authenticated.
    const { ws } = make()
    ws.emit('error', new RangeError('Max payload size exceeded'))
    expect(ws.terminated).toBe(1)
  })
})
