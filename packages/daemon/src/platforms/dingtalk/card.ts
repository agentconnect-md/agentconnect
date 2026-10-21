// DingTalk AI card calls (dingtalk-integration.md §4.3): create, deliver, stream, and settle one card.
import { randomUUID } from 'node:crypto'
import type { Logger } from '../../log.js'
import { dingTalkLimitOf, dingTalkTargetForChannel, type DingTalkApi } from './api.js'

/** The AI card template published in DingTalk's official SDK; any internal app may use it without importing it (§4.3). */
export const DINGTALK_AI_CARD_TEMPLATE = '382e4302-551d-4880-bf29-a30acfab2e71.schema'

/** The template's `flowStatus` values. */
export const DINGTALK_CARD_STATUS = { processing: '1', inputting: '2', finished: '3', failed: '5' } as const
export type DingTalkCardStatus = (typeof DINGTALK_CARD_STATUS)[keyof typeof DINGTALK_CARD_STATUS]

const CARD_LAYOUT = JSON.stringify({
  order: ['msgTitle', 'msgContent', 'staticMsgContent', 'msgTextList', 'msgImages', 'msgSlider', 'msgButtons']
})
// After a card cannot be opened, the connection stops trying for this long, so a missing permission costs one call per window.
const CARD_RETRY_MS = 10 * 60_000

/** The card calls a turn makes; the connection owns one, shared by its turns. */
export interface DingTalkCardPort {
  /** Create and deliver a card into the conversation; returns its `outTrackId`, or throws. */
  open(channel: string): Promise<string>
  setStatus(outTrackId: string, status: DingTalkCardStatus, content: string): Promise<void>
  stream(outTrackId: string, content: string, opts?: { finalize?: boolean; error?: boolean }): Promise<void>
  /** The connection's log, for a card that fails after opening. */
  warn(message: string): void
}

export class DingTalkCardClient implements DingTalkCardPort {
  private closedUntil = 0

  constructor(
    private readonly api: Pick<DingTalkApi, 'call'>,
    private readonly robotCode: string,
    private readonly log: Pick<Logger, 'warn'>,
    private readonly now: () => number = Date.now
  ) {}

  async open(channel: string): Promise<string> {
    if (this.now() < this.closedUntil) throw new Error('dingtalk: cards paused after an earlier failure')
    const outTrackId = `ac-${randomUUID()}`
    const target = dingTalkTargetForChannel(channel)
    try {
      await this.api.call('POST', '/v1.0/card/instances', {
        cardTemplateId: DINGTALK_AI_CARD_TEMPLATE,
        outTrackId,
        callbackType: 'STREAM',
        cardData: {
          cardParamMap: {
            flowStatus: DINGTALK_CARD_STATUS.processing,
            msgContent: '',
            staticMsgContent: '',
            sys_full_json_obj: CARD_LAYOUT
          }
        },
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true }
      })
      await this.api.call(
        'POST',
        '/v1.0/card/instances/deliver',
        target.kind === 'group'
          ? {
              outTrackId,
              userIdType: 1,
              openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
              imGroupOpenDeliverModel: { robotCode: this.robotCode }
            }
          : {
              outTrackId,
              userIdType: 1,
              openSpaceId: `dtv1.card//IM_ROBOT.${target.staffId}`,
              imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' }
            }
      )
      return outTrackId
    } catch (error) {
      // A QPS refusal is momentary; anything else (permission, quota, network) pauses cards and logs once.
      if (dingTalkLimitOf(error) !== 'rate') {
        this.closedUntil = this.now() + CARD_RETRY_MS
        this.log.warn(
          `dingtalk: progress card unavailable, continuing without it (${error instanceof Error ? error.message : 'unknown error'})`
        )
      }
      throw error
    }
  }

  warn(message: string): void {
    this.log.warn(message)
  }

  async setStatus(outTrackId: string, status: DingTalkCardStatus, content: string): Promise<void> {
    await this.api.call('PUT', '/v1.0/card/instances', {
      outTrackId,
      cardData: { cardParamMap: { flowStatus: status, msgContent: content, sys_full_json_obj: CARD_LAYOUT } }
    })
  }

  async stream(outTrackId: string, content: string, opts: { finalize?: boolean; error?: boolean } = {}): Promise<void> {
    await this.api.call('PUT', '/v1.0/card/streaming', {
      outTrackId,
      guid: randomUUID(),
      key: 'msgContent',
      content,
      isFull: true,
      isFinalize: opts.finalize === true,
      isError: opts.error === true
    })
  }
}
