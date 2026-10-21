// DingTalk's turn-output surface (§7.3): the converger and applier above, bound to the connection the turn leased.
import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputSurface } from '../turn-output.js'
import type { DingTalkReplyPort } from './connection.js'
import { applyDingTalkAction, DingTalkConverger, type DingTalkTurnHost, type DingTalkTurnState } from './turn-output.js'

export function createDingTalkTurnOutput(
  host: DingTalkTurnHost
): TurnOutputSurface<Pending, DaemonRenderAction, DingTalkConverger, NormalizedMessage> {
  return {
    platform: DINGTALK_PLATFORM,
    // The hint earns its space only in a group, where quoting a bot message is the only way back into the session.
    createConverger: (ctx) =>
      new DingTalkConverger(ctx.mode, { continueHint: ctx.showFooter && !ctx.isDm }, ctx.resolveFileLink),
    initialTurnState: (ctx): DingTalkTurnState => ({
      ...(ctx.egress && !ctx.message.headless ? { conn: ctx.egress as DingTalkReplyPort } : {}),
      channel: ctx.message.channel
    }),
    apply: (turn, action) => applyDingTalkAction(host, turn, turnState<DingTalkTurnState>(turn), action)
  }
}
