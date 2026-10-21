// DingTalk's turn-output surface (§7.3): the converger and applier above, bound to the connection the turn leased.
import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputContext, TurnOutputSurface } from '../turn-output.js'
import type { DingTalkReplyPort } from './connection.js'
import { DingTalkProgressCard, DingTalkQuotaNotice } from './progress-card.js'
import { applyDingTalkAction, DingTalkConverger, type DingTalkTurnHost, type DingTalkTurnState } from './turn-output.js'

function egressOf(ctx: TurnOutputContext<NormalizedMessage>): DingTalkReplyPort | undefined {
  return ctx.egress && !ctx.message.headless ? (ctx.egress as DingTalkReplyPort) : undefined
}

function quotaNotice(conn: DingTalkReplyPort, channel: string): DingTalkQuotaNotice {
  return new DingTalkQuotaNotice((text) => conn.sendText(channel, text))
}

export function createDingTalkTurnOutput(
  host: DingTalkTurnHost
): TurnOutputSurface<Pending, DaemonRenderAction, DingTalkConverger, NormalizedMessage> {
  return {
    platform: DINGTALK_PLATFORM,
    // DingTalk has no typing indicator or bot reaction, so the progress card is the turn's acknowledgement (§4.3).
    acknowledge: (ctx) => {
      const conn = egressOf(ctx)
      if (!conn?.cards || ctx.mode === 'none') return undefined
      return new DingTalkProgressCard(conn.cards, ctx.message.channel, quotaNotice(conn, ctx.message.channel))
    },
    // The hint earns its space only in a group, where quoting a bot message is the only way back into the session.
    createConverger: (ctx) =>
      new DingTalkConverger(ctx.mode, { continueHint: ctx.showFooter && !ctx.isDm }, ctx.resolveFileLink),
    initialTurnState: (ctx): DingTalkTurnState => {
      const conn = egressOf(ctx)
      const card = ctx.acknowledgement instanceof DingTalkProgressCard ? ctx.acknowledgement : undefined
      return {
        channel: ctx.message.channel,
        ...(conn ? { conn, quota: card?.quota ?? quotaNotice(conn, ctx.message.channel) } : {}),
        ...(card ? { card } : {})
      }
    },
    apply: (turn, action) => applyDingTalkAction(host, turn, turnState<DingTalkTurnState>(turn), action),
    onSuppress: (turn) => turnState<DingTalkTurnState>(turn).card?.suppress()
  }
}
