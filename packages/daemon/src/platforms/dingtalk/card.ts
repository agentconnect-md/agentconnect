// DingTalk interactive card calls for question cards (dingtalk-integration.md §4.6): deliver one from the project's template, then update it.
import type { Logger } from '../../log.js'
import { dingTalkTargetForChannel, type DingTalkApi } from './api.js'

/** The project's own advanced card template for questions, usable from any organization's internal app (§4.6). */
export const DINGTALK_QUESTION_TEMPLATE = '58d31762-3b0e-40bd-9425-5f9d4e702813.schema'

/** Overrides the question template; set empty to send every question as the numbered text card. */
export const DINGTALK_QUESTION_TEMPLATE_ENV = 'AGENTCONNECT_DINGTALK_QUESTION_TEMPLATE'

/** The question template this daemon uses, or undefined when tap cards are turned off. */
export function dingTalkQuestionTemplate(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[DINGTALK_QUESTION_TEMPLATE_ENV]
  if (override === undefined) return DINGTALK_QUESTION_TEMPLATE
  return override.trim() || undefined
}

/** The card calls a question makes; the connection owns one when a template is configured. */
export interface DingTalkCardPort {
  /** Deliver one card into the conversation, @-mentioning `atUserIds` (staff ID → name) in a group; false when DingTalk refused or the call failed. */
  deliver(
    channel: string,
    outTrackId: string,
    params: Record<string, string>,
    atUserIds?: Record<string, string>
  ): Promise<boolean>
  /** Replace the named variables of a delivered card for every viewer. */
  update(outTrackId: string, params: Record<string, string>): Promise<void>
}

interface DeliverResult {
  result?: { deliverResults?: { success?: unknown }[] }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

export class DingTalkCardClient implements DingTalkCardPort {
  constructor(
    private readonly api: Pick<DingTalkApi, 'call'>,
    private readonly robotCode: string,
    private readonly templateId: string,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  async deliver(
    channel: string,
    outTrackId: string,
    params: Record<string, string>,
    atUserIds?: Record<string, string>
  ): Promise<boolean> {
    const target = dingTalkTargetForChannel(channel)
    const space =
      target.kind === 'group'
        ? {
            openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
            imGroupOpenDeliverModel: { robotCode: this.robotCode, ...(atUserIds ? { atUserIds } : {}) }
          }
        : {
            userIdType: 1,
            openSpaceId: `dtv1.card//IM_ROBOT.${target.staffId}`,
            imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode: this.robotCode }
          }
    try {
      const result = await this.api.call<DeliverResult>('POST', '/v1.0/card/instances/createAndDeliver', {
        cardTemplateId: this.templateId,
        outTrackId,
        callbackType: 'STREAM',
        cardData: { cardParamMap: params },
        imGroupOpenSpaceModel: { supportForward: false },
        imRobotOpenSpaceModel: { supportForward: false },
        ...space
      })
      if (result.result?.deliverResults?.[0]?.success === true) return true
      this.log.warn('dingtalk: card not delivered')
    } catch (error) {
      this.log.warn(`dingtalk: card refused (${describe(error)})`)
    }
    return false
  }

  async update(outTrackId: string, params: Record<string, string>): Promise<void> {
    try {
      await this.api.call('PUT', '/v1.0/card/instances', {
        outTrackId,
        cardData: { cardParamMap: params },
        cardUpdateOptions: { updateCardDataByKey: true }
      })
    } catch (error) {
      this.log.warn(`dingtalk: question card not updated (${describe(error)})`)
    }
  }
}
