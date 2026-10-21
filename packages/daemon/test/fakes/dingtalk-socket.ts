// A scripted stand-in for the DingTalk Stream WebSocket: the test opens, feeds and closes it.
import type { DingTalkSocket } from '../../src/platforms/dingtalk/stream.js'

type Listener = (event: { data: unknown }) => void

export class FakeDingTalkSocket implements DingTalkSocket {
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  closedByClient = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    this.closedByClient = true
    this.serverClose()
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  frame(frame: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(frame))
  }

  callback(messageId: string, payload: object, topic = '/v1.0/im/bot/messages/get'): void {
    this.frame({ specVersion: '1.0', type: 'CALLBACK', headers: { topic, messageId }, data: JSON.stringify(payload) })
  }

  serverClose(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }

  private emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

/** A socket factory that records every socket and opens each one on the next microtask unless told not to. */
export function fakeSocketFactory(opts: { autoOpen?: boolean } = {}) {
  const sockets: FakeDingTalkSocket[] = []
  return {
    sockets,
    createSocket(url: string): FakeDingTalkSocket {
      const socket = new FakeDingTalkSocket(url)
      sockets.push(socket)
      if (opts.autoOpen !== false) queueMicrotask(() => socket.open())
      return socket
    }
  }
}
