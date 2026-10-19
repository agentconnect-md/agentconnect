import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client'

// SDK 1.0.0 silently evicts at 4096 queued subscription actions; recover before reaching it.
export class AhpDeliveryGuard implements AhpTransport {
  private readonly unread = new Map<string, number>()
  overflowed = false
  constructor(private readonly transport: AhpTransport) {}
  watch(channel: string): void {
    this.unread.set(channel, 0)
  }
  consumed(channel: string): void {
    if (this.unread.has(channel)) this.unread.set(channel, Math.max(0, this.unread.get(channel)! - 1))
  }
  send: AhpTransport['send'] = (message) => this.transport.send(message)
  close: AhpTransport['close'] = () => this.transport.close()
  async recv(): Promise<TransportFrame | null> {
    const frame = await this.transport.recv()
    if (!frame || this.overflowed) return null
    const message =
      frame.kind === 'parsed'
        ? frame.message
        : JSON.parse(frame.kind === 'text' ? frame.text : new TextDecoder().decode(frame.data))
    const channel = message.method === 'action' ? message.params?.channel : undefined
    if (typeof channel === 'string' && this.unread.has(channel)) {
      const count = this.unread.get(channel)! + 1
      if (count > 1024) {
        this.overflowed = true
        await this.close()
        return null
      }
      this.unread.set(channel, count)
    }
    return frame
  }
}
