export interface StartupNoticeConnection {
  postMessage(channel: string, text: string, thread?: string): Promise<string | undefined>
  updateMessage(channel: string, id: string, text: string, options?: { threadTs?: string }): Promise<void>
  deleteMessage(channel: string, id: string, thread?: string): Promise<unknown>
}

// One transient message, with serialized edits and removal even when the initial post finishes late.
export class StartupNotice {
  private closed = false
  private attempted = false
  private id?: string
  private text?: string
  private sent?: string
  private writes = Promise.resolve()

  constructor(
    private readonly conn: StartupNoticeConnection,
    private readonly channel: string,
    private readonly thread: string | undefined,
    private readonly failed: (error: unknown) => void
  ) {}

  update(text: string): void {
    if (this.closed || this.text === text) return
    this.text = text
    this.writes = this.writes
      .then(async () => {
        if (this.closed || this.sent === this.text) return
        const text = this.text!
        if (!this.attempted) {
          this.attempted = true
          this.id = await this.conn.postMessage(this.channel, text, this.thread)
        } else if (this.id) {
          await this.conn.updateMessage(this.channel, this.id, text, { threadTs: this.thread })
        }
        this.sent = text
      })
      .catch(this.failed)
  }

  close(): Promise<void> {
    if (this.closed) return this.writes
    this.closed = true
    this.writes = this.writes
      .then(async () => {
        if (this.id) await this.conn.deleteMessage(this.channel, this.id, this.thread)
      })
      .catch(this.failed)
    return this.writes
  }
}
