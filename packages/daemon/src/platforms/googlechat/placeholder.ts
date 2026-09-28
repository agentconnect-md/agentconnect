// Google Chat's turn acknowledgement (google-chat-integration.md §5): one placeholder that becomes the answer.
import type { TurnAcknowledgement, TurnAcknowledgementEnd } from '../turn-output.js'
import { GoogleChatApiError } from './connection.js'
import type { GoogleChatEgressPort } from './turn-output.js'

/** How long a turn may show nothing before its placeholder is posted. */
export const GOOGLE_CHAT_PLACEHOLDER_DELAY_MS = 2_000
/** The placeholder itself: an acknowledgement, never a phase. */
export const GOOGLE_CHAT_PLACEHOLDER_TEXT = '⏳ Working on it…'
/** What the placeholder becomes when its turn ends with no text and without the no-response marker. */
export const GOOGLE_CHAT_NO_REPLY_TEXT = 'Finished without a reply.'

/** The stream's egress plus withdrawing the app's own message. */
export interface GoogleChatPlaceholderPort extends GoogleChatEgressPort {
  deleteOwnMessage(name: string): Promise<void>
}

export interface GoogleChatPlaceholderOptions {
  /** The turn posts nothing on purpose (output mode `none`), so a placeholder it adopted is withdrawn. */
  silent?: boolean
  /** Whether the turn was interrupted since it started; a placeholder not yet posted then never is. */
  interrupted?: () => boolean
  warn?: (message: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.()
  return t
}

function describe(err: unknown): string {
  return err instanceof GoogleChatApiError ? `${err.kind}: ${err.message}` : (err as Error).message
}

/** A turn's one placeholder, posted under the answer's first client id so the first text adopts and patches it. */
export class GoogleChatPlaceholder implements TurnAcknowledgement {
  private timer: unknown
  private posting: Promise<void> | undefined
  /** The message on the wire, once a create answered. */
  private name: string | undefined
  /** The answer or a failure notice took the placeholder's place. */
  private taken = false
  private silent: boolean
  private closed = false
  private readonly interrupted: () => boolean
  private readonly warn: (message: string) => void
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly port: GoogleChatPlaceholderPort,
    private readonly target: { space: string; thread?: string },
    readonly clientId: string,
    opts: GoogleChatPlaceholderOptions = {}
  ) {
    this.silent = opts.silent === true
    this.interrupted = opts.interrupted ?? (() => false)
    this.warn = opts.warn ?? (() => {})
    this.setTimer = opts.setTimer ?? defaultSetTimer
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Post after `delayMs` unless text, an interrupt, or the end comes first. */
  arm(delayMs: number): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined
      if (this.closed || this.taken || this.interrupted()) return
      this.posting = this.post()
    }, delayMs)
  }

  /** The turn's first visible text: its create reuses this client id, so it adopts the placeholder and patches it. */
  take(): void {
    this.taken = true
    this.cancel()
  }

  /** The turn ended silently on purpose (the no-response marker). */
  silence(): void {
    this.silent = true
  }

  async replace(notice: string): Promise<boolean> {
    if (this.closed) return false
    this.cancel()
    await this.posting
    if (this.closed || this.taken || !this.name) return false
    this.taken = true
    try {
      await this.port.patchMessage(this.name, notice)
      return true
    } catch (err) {
      // Not shown, so the caller posts the notice and the end withdraws the placeholder.
      this.taken = false
      this.warn(`googlechat: placeholder in ${this.target.space} kept its text (${describe(err)})`)
      return false
    }
  }

  async end(end: TurnAcknowledgementEnd): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancel()
    await this.posting
    // Never shown, or the answer now; a rerun adopts it by its client id instead.
    if (!this.name || this.taken || end === 'rerun') return
    try {
      if (end === 'completed' && !this.silent) await this.port.patchMessage(this.name, GOOGLE_CHAT_NO_REPLY_TEXT)
      else await this.port.deleteOwnMessage(this.name)
    } catch (err) {
      this.warn(`googlechat: placeholder in ${this.target.space} not settled (${describe(err)})`)
    }
  }

  private cancel(): void {
    if (this.timer === undefined) return
    this.clearTimer(this.timer)
    this.timer = undefined
  }

  private async post(): Promise<void> {
    try {
      // A rerun's create answers with whatever an earlier run left under this id, which is adopted as is.
      const created = await this.port.createMessage({
        space: this.target.space,
        ...(this.target.thread ? { thread: this.target.thread } : {}),
        clientId: this.clientId,
        text: GOOGLE_CHAT_PLACEHOLDER_TEXT
      })
      this.name = created.name
    } catch (err) {
      this.warn(`googlechat: placeholder into ${this.target.space} not posted (${describe(err)})`)
    }
  }
}
