// WeCom's turn-output surface (§7.3): the converger and applier, bound to the connection the turn leased.
import { WECOM_PLATFORM } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputContext, TurnOutputSurface } from '../turn-output.js'
import type { WeComReplyPort } from './connection.js'
import { weComElicitCards } from './elicit-card.js'
import { weComFileUploader } from './media.js'
import { applyWeComAction, WeComConverger, type WeComTurnHost, type WeComTurnState } from './turn-output.js'

function egressOf(ctx: TurnOutputContext<NormalizedMessage>): WeComReplyPort | undefined {
  return ctx.egress && !ctx.message.headless ? (ctx.egress as WeComReplyPort) : undefined
}

// No acknowledgement: the long connection offers no reaction or typing call.
export function createWeComTurnOutput(
  host: WeComTurnHost
): TurnOutputSurface<Pending, DaemonRenderAction, WeComConverger, NormalizedMessage> {
  return {
    platform: WECOM_PLATFORM,
    // Questions are template cards answered by a tap; approvals have no card and stay in the Console, as on DingTalk.
    elicitCards: weComElicitCards,
    // The answer streams as it is written, so it is never held back for a final regeneration.
    answerDelivery: (ctx) => (ctx.mode !== 'none' && !ctx.message.headless ? 'live' : 'staged'),
    // A shared file goes as its own image or file message beside the streamed answer.
    fileUploader: (turn) => weComFileUploader(turnState<WeComTurnState>(turn)),
    createConverger: (ctx) => new WeComConverger(ctx.mode, ctx.resolveFileLink),
    initialTurnState: (ctx): WeComTurnState => {
      const conn = egressOf(ctx)
      return { channel: ctx.message.channel, msgId: ctx.message.msgId, ...(conn ? { conn } : {}) }
    },
    onSuppress: (turn) => turnState<WeComTurnState>(turn).stream?.suppress(),
    onSettle: async (turn) => {
      await turnState<WeComTurnState>(turn).stream?.close()
    },
    apply: (turn, action) => applyWeComAction(host, turn, turnState<WeComTurnState>(turn), action)
  }
}
