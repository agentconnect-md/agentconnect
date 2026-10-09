import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputSurface } from '../turn-output.js'
import { applyWeixinAction, WeixinConverger, type WeixinTurnState } from './turn-output.js'

export function createWeixinTurnOutput(
  record: (turn: Pending, text: string) => Promise<void>
): TurnOutputSurface<Pending, DaemonRenderAction, WeixinConverger, NormalizedMessage> {
  return {
    platform: 'weixin',
    createConverger: (ctx) => new WeixinConverger(ctx.mode, ctx.resolveFileLink),
    initialTurnState: (ctx): WeixinTurnState => ({
      conn: ctx.egress as WeixinTurnState['conn'],
      channel: ctx.message.channel
    }),
    apply: (turn, action) => applyWeixinAction(turnState<WeixinTurnState>(turn), action, (text) => record(turn, text))
  }
}
