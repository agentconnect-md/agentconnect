// One turn's WeCom answer: a stream under the callback's req_id, rolled over into proactive Markdown when it outgrows a limit.
import { randomUUID } from 'node:crypto'
import { splitMarkdownByBytes } from '../../messages/split-markdown-bytes.js'
import { splitAtParagraphBoundary } from '../../messages/stream-boundary.js'
import { WECOM_MARKDOWN_MAX_BYTES, type WeComReplyHandle, type WeComReplyPort } from './connection.js'

// Conservative choice: at most one refresh every 3 s, about 20 a minute, under the shared 30 a minute per conversation.
export const WECOM_REFRESH_MS = 3_000
// A stream ends by itself 10 minutes after its first message (official doc), so it is closed at a paragraph break from 9 minutes on.
export const WECOM_STREAM_SOFT_MS = 9 * 60_000
// With no paragraph break by 9.5 minutes the stream closes at the best cut there is, before WeCom ends it mid-word.
export const WECOM_STREAM_HARD_MS = 9 * 60_000 + 30_000
// Conservative choice: once the stream is closed, completed paragraphs go out as Markdown at most every 2 minutes.
export const WECOM_CONTINUATION_MS = 2 * 60_000

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The longest prefix of `text` within `maxBytes`, never inside a code point. */
function prefixWithinBytes(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text
  let size = 0
  let end = 0
  for (const ch of text) {
    size += bytes(ch)
    if (size > maxBytes) break
    end += ch.length
  }
  return text.slice(0, end)
}

/** Where to cut `text` so the head fits `maxBytes`: a paragraph break outside a fence, else a line break, else the byte edge. */
export function weComCutPoint(text: string, maxBytes: number): number {
  const head = prefixWithinBytes(text, maxBytes)
  if (head.length === text.length) return head.length
  const { ready } = splitAtParagraphBoundary(head)
  if (ready.trim()) return ready.length
  const line = head.lastIndexOf('\n')
  return line > 0 ? line + 1 : Math.max(1, head.length)
}

export interface WeComTurnStreamOptions {
  now?(): number
  /** The first send WeCom refused this turn; the turn records it as a notice. */
  onRefused?(error: unknown): void
}

interface OpenStream {
  id: string
  openedAt: number
  pushed: string
}

export class WeComTurnStream {
  // Characters of the answer already delivered in closed messages.
  private sealed = 0
  private pending = ''
  private stream?: OpenStream
  // Whether the callback's stream may still carry the answer; false after a rollover or a refused push.
  private live: boolean
  private lastPushAt = -Infinity
  private lastSealAt: number
  private timer?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>
  private flight: Promise<void> = Promise.resolve()
  private stopped = false
  private finished = false
  private refusal?: unknown

  constructor(
    private readonly port: WeComReplyPort,
    private readonly channel: string,
    private readonly handle: WeComReplyHandle | undefined,
    private readonly opts: WeComTurnStreamOptions = {}
  ) {
    this.live = handle !== undefined
    this.lastSealAt = this.now()
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** Whether the answer still rides the callback's stream rather than proactive messages. */
  get streaming(): boolean {
    return this.live
  }

  /** The whole answer so far; refreshes are throttled, and text already delivered is never rewritten. */
  update(text: string): void {
    if (this.stopped || this.finished) return
    if (!text.startsWith(this.pending.slice(0, this.sealed))) return
    this.pending = text
    this.schedule()
  }

  private schedule(): void {
    if (this.timer || this.stopped) return
    const wait = this.live
      ? this.lastPushAt + WECOM_REFRESH_MS - this.now()
      : this.lastSealAt + WECOM_CONTINUATION_MS - this.now()
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.enqueue(() => this.tick())
      },
      Math.max(0, wait)
    )
    this.timer.unref?.()
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.flight = this.flight.then(work).catch(() => undefined)
    return this.flight
  }

  private rest(): string {
    return this.pending.slice(this.sealed)
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.finished) return
    const rest = this.rest()
    if (!rest.trim()) return
    if (!this.live) {
      await this.continueProactively()
      return
    }
    if (bytes(rest) > WECOM_MARKDOWN_MAX_BYTES) {
      await this.rollover(weComCutPoint(rest, WECOM_MARKDOWN_MAX_BYTES))
      return
    }
    const age = this.stream ? this.now() - this.stream.openedAt : 0
    if (age >= WECOM_STREAM_SOFT_MS) {
      const { ready } = splitAtParagraphBoundary(rest)
      if (ready.trim()) {
        await this.rollover(ready.length)
        return
      }
      if (age >= WECOM_STREAM_HARD_MS) {
        await this.rollover(weComCutPoint(rest, WECOM_MARKDOWN_MAX_BYTES))
        return
      }
    }
    if (!this.port.refreshFits(this.channel)) return
    await this.write(rest, false, true)
  }

  // Close the stream with the answer up to `cut`; the rest continues in proactive messages.
  private async rollover(cut: number): Promise<void> {
    const head = this.rest().slice(0, cut).trimEnd()
    if (await this.write(head, true)) this.sealed += cut
    this.live = false
    this.lastSealAt = this.now()
  }

  // After a rollover: a part past the byte cap goes at once, completed paragraphs at most every 2 minutes.
  private async continueProactively(): Promise<void> {
    let rest = this.rest()
    while (bytes(rest) > WECOM_MARKDOWN_MAX_BYTES && !this.stopped) {
      const cut = weComCutPoint(rest, WECOM_MARKDOWN_MAX_BYTES)
      if (!(await this.sendProactive(rest.slice(0, cut)))) return
      this.sealed += cut
      rest = this.rest()
    }
    if (this.now() - this.lastSealAt < WECOM_CONTINUATION_MS) return
    const { ready } = splitAtParagraphBoundary(rest)
    if (ready.trim() && (await this.sendProactive(ready))) this.sealed += ready.length
  }

  private async sendProactive(text: string): Promise<boolean> {
    if (!text.trim()) return true
    if (this.refusal !== undefined) return false
    const parts = await this.port.sendMarkdown(this.channel, text.replace(/^\s+/, ''))
    this.lastSealAt = this.now()
    const refused = parts.find((part) => part.error !== undefined)
    if (refused) {
      this.refusal = refused.error
      this.opts.onRefused?.(refused.error)
      return false
    }
    return true
  }

  // One push under the callback's req_id; a refused or lost push hands the answer to proactive messages.
  private async write(content: string, finish: boolean, optional = false): Promise<boolean> {
    if (!this.handle || !this.live) return false
    const stream = this.stream ?? { id: `stream_${randomUUID()}`, openedAt: this.now(), pushed: '' }
    try {
      await this.port.respondStream(this.handle, { id: stream.id, content, finish }, optional)
    } catch {
      this.abandon(stream)
      return false
    }
    if (!this.stream && !finish) {
      this.stream = stream
      this.armDeadline(stream.openedAt + WECOM_STREAM_SOFT_MS)
    }
    stream.pushed = content
    this.lastPushAt = this.now()
    if (finish) this.closeStream()
    return true
  }

  // The reader keeps what the stream last showed; the answer continues after it.
  private abandon(stream: OpenStream): void {
    if (stream.pushed && this.rest().startsWith(stream.pushed)) this.sealed += stream.pushed.length
    this.live = false
    this.lastSealAt = -Infinity
    this.closeStream()
  }

  private closeStream(): void {
    this.stream = undefined
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = undefined
  }

  // A silent agent sends no updates, so the stream's own clock closes it before WeCom ends it mid-word.
  private armDeadline(at: number): void {
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = setTimeout(
      () => {
        this.deadline = undefined
        void this.enqueue(async () => {
          await this.tick()
          if (this.stream && this.live && !this.stopped) this.armDeadline(this.stream.openedAt + WECOM_STREAM_HARD_MS)
        })
      },
      Math.max(0, at - this.now())
    )
    this.deadline.unref?.()
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = undefined
  }

  /** Deliver the complete answer: the stream's last push, then proactive parts for whatever outgrew it. */
  async finish(text: string): Promise<{ refused?: unknown }> {
    this.stopTimers()
    await this.flight
    if (this.finished) {
      await this.sendProactive(text)
      return this.refusal !== undefined ? { refused: this.refusal } : {}
    }
    this.finished = true
    if (text.startsWith(this.pending.slice(0, this.sealed))) this.pending = text
    else this.pending = this.pending.slice(0, this.sealed) + text.slice(this.sealed)
    let rest = this.rest()
    if (!rest.trim()) {
      if (this.stream) await this.write(this.stream.pushed, true)
      return this.refusal !== undefined ? { refused: this.refusal } : {}
    }
    if (this.live) {
      const parts = splitMarkdownByBytes(rest, WECOM_MARKDOWN_MAX_BYTES)
      if (await this.write(parts[0] ?? rest, true)) {
        for (const part of parts.slice(1)) if (!(await this.sendProactive(part))) break
        return this.refusal !== undefined ? { refused: this.refusal } : {}
      }
      rest = this.rest()
    }
    await this.sendProactive(rest)
    return this.refusal !== undefined ? { refused: this.refusal } : {}
  }

  /** Deliver and close what the answer holds before a card is posted, so text after the card reads below it. */
  async seal(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.enqueue(async () => {
      if (this.stopped || this.finished) return
      const rest = this.rest()
      if (this.live && this.stream && !rest.trim()) {
        await this.write(this.stream.pushed, true)
        this.live = false
        this.lastSealAt = this.now()
        return
      }
      if (!rest.trim()) return
      if (this.live) await this.rollover(weComCutPoint(rest, WECOM_MARKDOWN_MAX_BYTES))
      const left = this.rest()
      if (left.trim() && (await this.sendProactive(left))) this.sealed += left.length
    })
  }

  /** Stop refreshing at once; an open stream is closed by {@link close}. */
  suppress(): void {
    this.stopped = true
    this.stopTimers()
  }

  /** Close a stream the turn left open, with the content it last showed. */
  async close(): Promise<void> {
    this.stopTimers()
    await this.flight
    this.stopped = true
    const stream = this.stream
    if (stream) await this.write(stream.pushed, true)
  }
}
