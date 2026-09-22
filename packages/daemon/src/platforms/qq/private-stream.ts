import { QQStreamUnavailable, splitQQText, type QQStreamCursor, type QQReplyPort } from './sender.js'
import { QQTextMaxBytes } from './text.js'

// A turn owns its C2C stream; the sender owns ordering across all turns in the conversation.
export class QQPrivateStream {
  private readonly generation = new AbortController()
  private readonly cursor: QQStreamCursor = { index: 0 }
  private timer?: ReturnType<typeof setTimeout>
  private flight: Promise<void> = Promise.resolve()
  private pending = ''
  private confirmed = ''
  private failure?: unknown
  private failed = false
  private fallback = false
  private stopped = false
  private completed = false

  constructor(
    private readonly conn: QQReplyPort,
    private readonly channel: string,
    private readonly replyId: string
  ) {}

  update(text: string): void {
    if (this.stopped || this.failed || this.fallback || !this.conn.sendStream) return
    if (Buffer.byteLength(text) > QQTextMaxBytes || !text.startsWith(this.pending)) return
    this.pending = text
    if (!this.pending || this.pending === this.confirmed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flight = this.flight.then(async () => {
        if (this.stopped || this.failed || this.fallback || this.pending === this.confirmed) return
        await this.write(this.pending, false)
      })
    }, 1000)
    this.timer.unref?.()
  }

  private async write(text: string, done: boolean): Promise<void> {
    try {
      await this.conn.sendStream!(
        this.channel,
        this.replyId,
        this.cursor,
        text,
        done,
        done ? undefined : this.generation.signal
      )
      this.confirmed = text
      if (done) this.completed = true
    } catch (error) {
      if (this.generation.signal.aborted && error === this.generation.signal.reason) return
      if (!this.cursor.id && QQStreamUnavailable(error)) this.fallback = true
      else {
        this.failed = true
        this.failure = error
      }
    }
  }

  private stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  async finish(text: string): Promise<void> {
    this.stop()
    await this.flight
    if (this.failed) throw this.failure
    if (!this.cursor.id) return this.conn.sendText(this.channel, this.replyId, text)
    if (!text.startsWith(this.confirmed)) throw new Error('QQ final text changed an already delivered prefix')
    const parts = splitQQText(text)
    let first = parts.shift() ?? this.confirmed
    if (text.startsWith(this.confirmed) && first.length < this.confirmed.length) {
      first = this.confirmed
      parts.splice(0, parts.length, text.slice(first.length))
    }
    await this.write(first, true)
    if (this.failed) throw this.failure
    if (parts.length) await this.conn.sendText(this.channel, this.replyId, parts.join(''))
  }

  suppress(): void {
    this.generation.abort()
    this.stop()
  }

  async close(): Promise<void> {
    this.stop()
    await this.flight
    if (this.cursor.id && !this.completed && !this.failed && this.confirmed) await this.write(this.confirmed, true)
  }
}
