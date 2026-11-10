// WeChat's turn-output surface (§7.3): the converger and applier above, bound to the connection the turn leased.
import { WECHAT_PLATFORM } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputContext, TurnOutputSurface } from '../turn-output.js'
import type { WeChatReplyPort } from './connection.js'
import { applyWeChatAction, WeChatConverger, type WeChatTurnHost, type WeChatTurnState } from './turn-output.js'

function egressOf(ctx: TurnOutputContext<NormalizedMessage>): WeChatReplyPort | undefined {
  return ctx.egress && !ctx.message.headless ? (ctx.egress as WeChatReplyPort) : undefined
}

// No acknowledgement: iLink has no reaction, and typing is not one (§4.4); no question card either, so asks decline (§4.7).
export function createWeChatTurnOutput(
  host: WeChatTurnHost
): TurnOutputSurface<Pending, DaemonRenderAction, WeChatConverger, NormalizedMessage> {
  return {
    platform: WECHAT_PLATFORM,
    createConverger: (ctx) => new WeChatConverger(ctx.mode, ctx.resolveFileLink),
    initialTurnState: (ctx): WeChatTurnState => {
      const conn = egressOf(ctx)
      return { channel: ctx.message.channel, ...(conn ? { conn } : {}) }
    },
    apply: (turn, action) => applyWeChatAction(host, turn, turnState<WeChatTurnState>(turn), action)
  }
}
