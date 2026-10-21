// One turn's DingTalk progress card (dingtalk-integration.md §4.3, §4.4): coalesced updates, then a one-line summary.
import type { TurnAcknowledgement, TurnAcknowledgementEnd } from '../turn-output.js'
import { dingTalkLimitOf } from './api.js'
import { DINGTALK_CARD_STATUS, type DingTalkCardPort, type DingTalkCardStatus } from './card.js'

/** The shortest gap between two card updates; a 1-minute turn then costs about 25 calls of a 5,000-call month (§4.4). */
export const DINGTALK_CARD_INTERVAL_MS = 3_000
/** The longest gap QPS backoff stretches the interval to. */
export const DINGTALK_CARD_MAX_INTERVAL_MS = 15_000
/** Content updates one card may spend; after that it holds its last state until the turn ends. */
export const DINGTALK_CARD_MAX_UPDATES = 30

/** Posted once per turn when DingTalk refuses a call for the organization's monthly quota (§4.4). */
export const DINGTALK_QUOTA_NOTICE =
  'DingTalk refused a reply because this organization has used up its monthly API call quota (the Standard edition allows 5,000 calls a month). Replies resume when the quota resets or the organization upgrades its DingTalk edition.'

/** The turn's one quota notice, shared by its card and its message sends. */
export class DingTalkQuotaNotice {
  private sent = false

  constructor(private readonly send: (text: string) => Promise<unknown>) {}

  /** Post the notice if `error` is a quota refusal and this turn has not posted it yet. */
  async note(error: unknown): Promise<void> {
    if (this.sent || dingTalkLimitOf(error) !== 'quota') return
    this.sent = true
    await this.send(DINGTALK_QUOTA_NOTICE).catch(() => undefined)
  }
}

export interface DingTalkProgressCardOptions {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/** Created and delivered at turn start; a card that cannot open leaves the turn running without one. */
export class DingTalkProgressCard implements TurnAcknowledgement {
  private outTrackId: string | undefined
  private readonly opening: Promise<void>
  private latest: { text: string; tools: number } | undefined
  private pushed = ''
  private updates = 0
  private interval = DINGTALK_CARD_INTERVAL_MS
  private lastPushAt = -Infinity
  private timer: unknown
  private chain: Promise<void> = Promise.resolve()
  private live = true
  private inputting = false
  private settled = false
  private readonly startedAt: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly warn: (message: string) => void

  constructor(
    private readonly cards: DingTalkCardPort,
    channel: string,
    readonly quota: DingTalkQuotaNotice,
    opts: DingTalkProgressCardOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.setTimer = opts.setTimer ?? defaultSetTimer
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.warn = (message) => cards.warn(message)
    this.startedAt = this.now()
    // The card client logs an open failure once per pause window, so the turn only notes quota here.
    this.opening = cards.open(channel).then(
      (id) => {
        this.outTrackId = id
      },
      async (error: unknown) => {
        this.live = false
        await this.quota.note(error)
      }
    )
  }

  /** The newest progress; pushed at most once per interval, the latest snapshot winning. */
  update(text: string, tools: number): void {
    if (!this.live || !text.trim()) return
    this.latest = { text, tools }
    this.schedule()
  }

  /** Output is suppressed: no further updates, though the end still settles the card. */
  suppress(): void {
    this.live = false
    this.cancel()
  }

  async replace(notice: string): Promise<boolean> {
    if (this.settled) return false
    this.settled = true
    this.stop()
    await this.chain
    await this.opening
    if (!this.outTrackId) return false
    try {
      await this.finish(DINGTALK_CARD_STATUS.failed, notice)
      return true
    } catch (error) {
      // Not shown, so the caller posts the notice and the end settles the card.
      this.settled = false
      this.warn(`dingtalk: progress card kept its content (${describe(error)})`)
      return false
    }
  }

  async end(end: TurnAcknowledgementEnd): Promise<void> {
    if (this.settled) return
    this.settled = true
    this.stop()
    await this.chain
    await this.opening
    if (!this.outTrackId) return
    try {
      await this.finish(
        end === 'failed' ? DINGTALK_CARD_STATUS.failed : DINGTALK_CARD_STATUS.finished,
        this.summary(end)
      )
    } catch (error) {
      this.warn(`dingtalk: progress card not settled (${describe(error)})`)
      await this.quota.note(error)
    }
  }

  private summary(end: TurnAcknowledgementEnd): string {
    const took = duration(this.now() - this.startedAt)
    const tools = this.latest?.tools ?? 0
    if (end === 'completed')
      return `✅ Finished in ${took}${tools ? ` · ${tools} tool call${tools === 1 ? '' : 's'}` : ''}`
    if (end === 'interrupted') return `⏹ Stopped after ${took}`
    if (end === 'rerun') return '⏸ Interrupted; this request will run again'
    return `⚠️ Failed after ${took}`
  }

  private async finish(status: DingTalkCardStatus, content: string): Promise<void> {
    const id = this.outTrackId!
    if (this.inputting)
      await this.cards.stream(id, content, { finalize: true, error: status === DINGTALK_CARD_STATUS.failed })
    await this.cards.setStatus(id, status, content)
  }

  private stop(): void {
    this.live = false
    this.cancel()
  }

  private cancel(): void {
    if (this.timer === undefined) return
    this.clearTimer(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (!this.live || this.timer !== undefined) return
    const wait = Math.max(0, this.lastPushAt + this.interval - this.now())
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.chain = this.chain.then(() => this.push())
    }, wait)
  }

  private async push(): Promise<void> {
    await this.opening
    const snapshot = this.latest
    const id = this.outTrackId
    if (!this.live || !id || !snapshot || snapshot.text === this.pushed || this.updates >= DINGTALK_CARD_MAX_UPDATES)
      return
    this.lastPushAt = this.now()
    try {
      if (!this.inputting) {
        await this.cards.setStatus(id, DINGTALK_CARD_STATUS.inputting, '')
        this.inputting = true
      }
      await this.cards.stream(id, snapshot.text)
      this.updates++
      this.pushed = snapshot.text
      this.interval = DINGTALK_CARD_INTERVAL_MS
    } catch (error) {
      // A QPS refusal skips this update and backs off; anything else retires the card for the turn.
      if (dingTalkLimitOf(error) === 'rate') this.interval = Math.min(this.interval * 2, DINGTALK_CARD_MAX_INTERVAL_MS)
      else {
        this.live = false
        this.warn(`dingtalk: progress card stopped updating (${describe(error)})`)
        await this.quota.note(error)
      }
    }
    if (this.latest && this.latest.text !== this.pushed) this.schedule()
  }
}
