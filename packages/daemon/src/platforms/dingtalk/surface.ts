// DingTalk's turn-output surface (§7.3): the converger and applier above, bound to the connection the turn leased.
import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputContext, TurnOutputSurface } from '../turn-output.js'
import type { DingTalkReplyPort } from './connection.js'
import { dingTalkElicitCards } from './elicit-card.js'
import { dingTalkFileUploader } from './media.js'
import { DingTalkQuotaNotice } from './quota.js'
import { acknowledgeDingTalkTurn } from './reaction.js'
import { applyDingTalkAction, DingTalkConverger, type DingTalkTurnHost, type DingTalkTurnState } from './turn-output.js'

function egressOf(ctx: TurnOutputContext<NormalizedMessage>): DingTalkReplyPort | undefined {
  return ctx.egress && !ctx.message.headless ? (ctx.egress as DingTalkReplyPort) : undefined
}

export function createDingTalkTurnOutput(
  host: DingTalkTurnHost
): TurnOutputSurface<Pending, DaemonRenderAction, DingTalkConverger, NormalizedMessage> {
  return {
    platform: DINGTALK_PLATFORM,
    // DingTalk has no typing indicator, so a thinking reaction on the user's message stands in for one (§4.3).
    acknowledge: acknowledgeDingTalkTurn,
    // Approvals have no card here: core posts a notice and the Console answers it (§4.6).
    elicitCards: dingTalkElicitCards,
    fileUploader: (turn) => dingTalkFileUploader(turnState<DingTalkTurnState>(turn)),
    // The hint earns its space only in a group, where quoting a bot message is the only way back into the session.
    createConverger: (ctx) =>
      new DingTalkConverger(ctx.mode, { continueHint: ctx.showFooter && !ctx.isDm }, ctx.resolveFileLink),
    initialTurnState: (ctx): DingTalkTurnState => {
      const conn = egressOf(ctx)
      return {
        channel: ctx.message.channel,
        ...(conn ? { conn, quota: new DingTalkQuotaNotice((text) => conn.sendText(ctx.message.channel, text)) } : {})
      }
    },
    apply: (turn, action) => applyDingTalkAction(host, turn, turnState<DingTalkTurnState>(turn), action)
  }
}
