// One bot's getupdates long poll: cursor, deduplication, backoff and the stale-token stop (wechat-integration.md §3).
import type { WeChatInboundMessage } from '@agentconnect.md/message'
import type { Logger } from '../../log.js'
import { WeChatApiError, type WeChatApi } from './api.js'
import type { WeChatStatePort } from './state.js'

const SEEN_LIMIT = 2_000
const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** How long a rejected token waits before one more try, as the official plugin pauses (§2.3). */
export const WECHAT_STALE_RETRY_MS = 60 * 60_000

export interface WeChatPollerDeps {
  api: Pick<WeChatApi, 'getUpdates' | 'notify'>
  state: WeChatStatePort
  botId: string
  /** Settles once the message is handed to core or dropped; the batch's cursor waits for it. */
  onMessage(msg: WeChatInboundMessage): void | Promise<void>
  /** The token was refused; called once per refusal episode, before the hourly retry. */
  onStaleToken(): void
  log: Logger
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  random?(): number
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function messageIdOf(msg: WeChatInboundMessage): string | undefined {
  const id = msg.message_id
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : undefined
}

export class WeChatPoller {
  private readonly abort = new AbortController()
  private readonly seen = new Set<string>()
  private cursor = ''
  private loop?: Promise<void>
  private stale = false

  constructor(private readonly deps: WeChatPollerDeps) {}

  get stopped(): boolean {
    return this.abort.signal.aborted
  }

  /** Load the stored cursor and start polling in the background; never waits on iLink. */
  async start(): Promise<void> {
    this.abort.signal.throwIfAborted()
    this.cursor = (await this.deps.state.load(this.deps.botId)).cursor ?? ''
    this.loop = this.run()
  }

  /** Stop polling: on duty loss, unbind or shutdown, the loop ends before this resolves (§3.2). */
  async stop(): Promise<void> {
    if (this.abort.signal.aborted) return
    this.abort.abort()
    await this.loop
    await this.deps.api.notify('stop').catch(() => undefined)
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? abortableSleep)(ms, this.abort.signal)
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal
    await this.deps.api.notify('start').catch(() => this.deps.log.warn('wechat: notifystart failed; polling anyway'))
    let delay = BACKOFF_INITIAL_MS
    let holdMs: number | undefined
    while (!signal.aborted) {
      try {
        const updates = await this.deps.api.getUpdates(this.cursor, holdMs, signal)
        if (signal.aborted) return
        if (this.stale) this.deps.log.info('wechat: the bot token is accepted again')
        this.stale = false
        delay = BACKOFF_INITIAL_MS
        holdMs = updates.holdMs
        // The cursor moves only after the whole batch is handed on, so a crash before then replays it.
        for (const msg of updates.msgs) await this.deliver(msg)
        if (updates.cursor && updates.cursor !== this.cursor) {
          this.cursor = updates.cursor
          await this.deps.state.saveCursor(this.deps.botId, updates.cursor).catch(() => {
            this.deps.log.warn('wechat: could not store the poll cursor')
          })
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof WeChatApiError && error.staleToken) {
          if (!this.stale) {
            this.stale = true
            this.deps.log.warn('wechat: iLink refused the bot token (-14); a re-scan is needed, retrying hourly')
            this.deps.onStaleToken()
          }
          await this.sleep(WECHAT_STALE_RETRY_MS)
          continue
        }
        this.deps.log.warn(`wechat: getupdates failed (${error instanceof Error ? error.message : 'unknown error'})`)
        const jitter = 0.5 + (this.deps.random ?? Math.random)() / 2
        await this.sleep(Math.round(delay * jitter))
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
      }
    }
  }

  // A message id already delivered is dropped, from a bounded memory of the last 2,000 (§3.3).
  private async deliver(msg: WeChatInboundMessage): Promise<void> {
    const id = messageIdOf(msg)
    if (id) {
      if (this.seen.has(id)) return
      this.seen.add(id)
      while (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!)
    }
    try {
      await this.deps.onMessage(msg)
    } catch (error) {
      this.deps.log.warn(`wechat: dropped a message (${error instanceof Error ? error.message : 'unknown error'})`)
    }
  }
}
