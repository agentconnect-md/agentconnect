import { randomUUID } from 'node:crypto'
import {
  AhpMessageText,
  buildRelayDaemonFrame,
  type RelayDaemonFrame,
  type RdAhpOpen,
  type RdAhpAuthorize,
  type RdAhpMessage,
  type RdAhpClose
} from '@agentconnect.md/protocol'
import type { Transport } from '@agentconnect.md/connection'

export interface AhpCarrierDeps {
  ahpEnabled?(): boolean
  onAhpOpen?(
    input: RdAhpOpen,
    wire: { send(message: string): void; close(reason: RdAhpClose['reason']): void },
    connectionId: string
  ): Promise<boolean>
  onAhpAuthorize?(input: RdAhpAuthorize, connectionId: string): Promise<boolean>
  onAhpMessage?(input: RdAhpMessage, connectionId: string): Promise<void> | void
  onAhpClose?(input: RdAhpClose, connectionId: string): void
  onAhpRelayLost?(connectionId: string): void
}
export function ahpAvailable(deps: AhpCarrierDeps): boolean {
  return Boolean(
    deps.ahpEnabled?.() &&
    deps.onAhpOpen &&
    deps.onAhpAuthorize &&
    deps.onAhpMessage &&
    deps.onAhpClose &&
    deps.onAhpRelayLost
  )
}
type Inbound = Extract<
  RelayDaemonFrame,
  { type: 'rd/ahp/open' | 'rd/ahp/authorize' | 'rd/ahp/message' | 'rd/ahp/close' }
>
interface Attachment {
  id: string
  closed: boolean
  running: boolean
  bytes: number
  queue: Array<{ frame: Inbound; bytes: number }>
}
const MAX_BYTES = 1024 * 1024
const CONTROL_RESERVE = 64 * 1024

// Each instance belongs to one transport generation; attachments never own execution lifetime.
export class AhpCarrier {
  readonly connectionId = randomUUID()
  private readonly attachments = new Map<string, Attachment>()
  private bytes = 0
  private disposed = false
  constructor(
    private readonly transport: Transport,
    private readonly deps: AhpCarrierDeps
  ) {}

  receive(input: RelayDaemonFrame): boolean {
    if (!['rd/ahp/open', 'rd/ahp/authorize', 'rd/ahp/message', 'rd/ahp/close'].includes(input.type)) return false
    if (this.disposed) return true
    const frame = input as Inbound
    const id = frame.payload.attachmentId
    let attachment = this.attachments.get(id)
    if (frame.type === 'rd/ahp/close') {
      if (attachment) this.close(attachment, frame.payload.reason, false)
      return true
    }
    if (frame.type === 'rd/ahp/open') {
      if (attachment || !ahpAvailable(this.deps) || this.attachments.size >= 256) {
        this.send(
          buildRelayDaemonFrame('rd/ahp/opened', { attachmentId: id, accepted: false }, { corr: frame.id }),
          true
        )
        return true
      }
      attachment = { id, closed: false, running: false, bytes: 0, queue: [] }
      this.attachments.set(id, attachment)
    }
    if (!attachment || attachment.closed) {
      this.send(buildRelayDaemonFrame('rd/ahp/close', { attachmentId: id, reason: 'unauthorized' }), true)
      return true
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    if (
      attachment.queue.length + Number(attachment.running) >= 32 ||
      attachment.bytes + bytes > 256 * 1024 ||
      this.bytes + bytes > MAX_BYTES
    ) {
      this.close(attachment, 'overloaded')
      return true
    }
    attachment.bytes += bytes
    this.bytes += bytes
    attachment.queue.push({ frame, bytes })
    if (!attachment.running) void this.drain(attachment)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const attachment of this.attachments.values()) this.close(attachment, 'unavailable', false)
    try {
      this.deps.onAhpRelayLost?.(this.connectionId)
    } catch {
      /* Cleanup must not escape the carrier. */
    }
  }

  private async drain(attachment: Attachment): Promise<void> {
    attachment.running = true
    try {
      while (!attachment.closed && attachment.queue.length) {
        const { frame, bytes } = attachment.queue.shift()!
        try {
          if (!ahpAvailable(this.deps)) {
            this.close(attachment, 'unavailable')
            break
          }
          if (frame.type === 'rd/ahp/open' || frame.type === 'rd/ahp/authorize') {
            const accepted =
              frame.type === 'rd/ahp/open'
                ? await this.deps.onAhpOpen!(
                    frame.payload,
                    {
                      send: (message) => {
                        if (attachment.closed || this.disposed) return
                        if (!ahpAvailable(this.deps)) return this.close(attachment, 'unavailable')
                        if (!AhpMessageText.safeParse(message).success) return this.close(attachment, 'invalid_message')
                        if (
                          !this.send(buildRelayDaemonFrame('rd/ahp/message', { attachmentId: attachment.id, message }))
                        )
                          this.close(attachment, 'overloaded')
                      },
                      close: (reason) => this.close(attachment, reason)
                    },
                    this.connectionId
                  )
                : await this.deps.onAhpAuthorize!(frame.payload, this.connectionId)
            if (attachment.closed || this.disposed) {
              this.cleanup(attachment, 'unavailable')
              break
            }
            const allowed = accepted && ahpAvailable(this.deps)
            this.send(
              buildRelayDaemonFrame(
                frame.type === 'rd/ahp/open' ? 'rd/ahp/opened' : 'rd/ahp/authorized',
                {
                  attachmentId: attachment.id,
                  accepted: allowed
                },
                { corr: frame.id }
              ),
              true
            )
            if (!allowed) this.close(attachment, 'unauthorized')
          } else if (frame.type === 'rd/ahp/message') {
            await this.deps.onAhpMessage!(frame.payload, this.connectionId)
          }
        } catch {
          this.close(attachment, 'unavailable')
        } finally {
          attachment.bytes -= bytes
          this.bytes -= bytes
        }
      }
    } finally {
      attachment.running = false
      if (attachment.closed) this.attachments.delete(attachment.id)
    }
  }

  private close(attachment: Attachment, reason: RdAhpClose['reason'], notify = true): void {
    if (attachment.closed) return
    attachment.closed = true
    for (const queued of attachment.queue) {
      attachment.bytes -= queued.bytes
      this.bytes -= queued.bytes
    }
    attachment.queue.length = 0
    this.cleanup(attachment, reason)
    if (notify) this.send(buildRelayDaemonFrame('rd/ahp/close', { attachmentId: attachment.id, reason }), true)
    // Keep the tombstone until any asynchronous open/authorize finishes, preventing attachment-id reuse races.
    if (!attachment.running) this.attachments.delete(attachment.id)
  }

  private cleanup(attachment: Attachment, reason: RdAhpClose['reason']): void {
    try {
      this.deps.onAhpClose?.({ attachmentId: attachment.id, reason }, this.connectionId)
    } catch {
      /* Keep cleanup isolated. */
    }
  }

  private send(frame: RelayDaemonFrame, control = false): boolean {
    if (this.disposed) return false
    const text = JSON.stringify(frame)
    if ((this.transport.bufferedAmount ?? 0) + Buffer.byteLength(text) > MAX_BYTES + (control ? CONTROL_RESERVE : 0)) {
      if (control) {
        this.dispose()
        this.transport.close(1013, 'AHP carrier overloaded')
      }
      return false
    }
    try {
      this.transport.send(text)
      return true
    } catch {
      this.dispose()
      this.transport.close(1013, 'AHP carrier unavailable')
      return false
    }
  }
}
