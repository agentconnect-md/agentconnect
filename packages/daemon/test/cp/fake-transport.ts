import type { Transport } from '@agentconnect.md/connection'

/** In-memory `Transport` for driving the CpClient FSM with no real socket. */
export class FakeTransport implements Transport {
  readonly subprotocol = 'agentconnect.v1'
  readonly sent: string[] = []
  private msgCb?: (text: string) => void
  private closeCb?: (code: number, reason: string) => void
  closed?: { code: number; reason: string }

  send(text: string): void {
    this.sent.push(text)
  }
  onMessage(cb: (text: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
    this.closeCb?.(code, reason)
  }
  /** Simulate an inbound frame from the CP. */
  pushInbound(text: string): void {
    this.msgCb?.(text)
  }
  /** Simulate the CP closing the socket. */
  simulateClose(code: number, reason = ''): void {
    this.closeCb?.(code, reason)
  }
  /** The most recently sent frame, decoded. */
  lastSent(): any {
    return JSON.parse(this.sent[this.sent.length - 1]!)
  }
}
