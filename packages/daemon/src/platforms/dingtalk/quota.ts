// The once-per-turn notice for DingTalk's monthly API call quota (dingtalk-integration.md §4.4).
import { dingTalkLimitOf } from './api.js'

/** Posted once per turn when DingTalk refuses a call for the organization's monthly quota (§4.4). */
export const DINGTALK_QUOTA_NOTICE =
  'DingTalk refused a reply because this organization has used up its monthly API call quota (the Standard edition allows 5,000 calls a month). Replies resume when the quota resets or the organization upgrades its DingTalk edition.'

/** The turn's one quota notice, shared by its message sends. */
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
