import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputSurface } from '../turn-output.js'
import { QQReplyId } from './connection.js'
import {
  applyQQAction,
  QQAcknowledgeAdmission,
  QQAnswerDelivery,
  QQConverger,
  QQImageUploader,
  type QQTurnState
} from './turn-output.js'

export function createQQTurnOutput(
  record: (turn: Pending, text: string) => Promise<void>
): TurnOutputSurface<Pending, DaemonRenderAction, QQConverger, NormalizedMessage> {
  return {
    platform: 'qq',
    onAdmission: QQAcknowledgeAdmission,
    answerDelivery: QQAnswerDelivery,
    imageUploader: (turn) => QQImageUploader(turnState<QQTurnState>(turn)),
    createConverger: (ctx) => new QQConverger(ctx.mode, ctx.resolveFileLink, ctx.isDm ? 'stream' : 'group'),
    initialTurnState: (ctx): QQTurnState => ({
      conn: ctx.egress as QQTurnState['conn'],
      outputAbort: new AbortController(),
      channel: ctx.message.channel,
      replyId: QQReplyId(ctx.message)
    }),
    onSuppress: (turn) => {
      const state = turnState<QQTurnState>(turn)
      state.outputAbort?.abort()
      state.stream?.suppress()
    },
    onSettle: async (turn) => {
      const state = turnState<QQTurnState>(turn)
      state.outputAbort?.abort()
      await state.stream?.close()
    },
    apply: (turn, action) => applyQQAction(turnState<QQTurnState>(turn), action, (text) => record(turn, text))
  }
}
