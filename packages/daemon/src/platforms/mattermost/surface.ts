// Mattermost turn output surface (§7.3): live streamed/patched replies, typing ack, file uploads, and numbered text elicit cards (no approval cards).
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputContext, TurnOutputSurface } from '../turn-output.js'
import { mattermostApprovalCards } from './approval-card.js'
import { mattermostCapabilityCards } from './capability-card.js'
import { mattermostElicitCards } from './elicit-card.js'
import { mattermostFillCards } from './fill-card.js'
import {
  applyMattermostAction,
  initialMattermostTurnState,
  MattermostConverger,
  mattermostFileUploader,
  mattermostRootIdForMessage,
  type MattermostAction,
  type MattermostOutputMode,
  type MattermostTurnHost,
  type MattermostTurnPort,
  type MattermostTurnState
} from './turn-output.js'

const MODES: readonly MattermostOutputMode[] = ['none', 'minimal', 'low', 'medium', 'high']

function normalizeMode(mode: string): MattermostOutputMode {
  return (MODES as readonly string[]).includes(mode) ? (mode as MattermostOutputMode) : 'low'
}

export interface MattermostSurfaceHost<TTurn> extends MattermostTurnHost<TTurn> {
  prepareResponseClosure?(turn: TTurn): void
  closeResponse?(turn: TTurn): Promise<void>
}

export function createMattermostTurnOutput(
  host: MattermostSurfaceHost<Pending>
): TurnOutputSurface<Pending, DaemonRenderAction, MattermostConverger, NormalizedMessage> {
  return {
    platform: MATTERMOST_PLATFORM,
    approvalCards: mattermostApprovalCards,
    elicitCards: mattermostElicitCards,
    capabilityCards: mattermostCapabilityCards,
    fillCards: mattermostFillCards,

    async onAdmission(ctx: TurnOutputContext<NormalizedMessage>, status, signal): Promise<void> {
      if (status !== 'processing' || signal.aborted || ctx.message.headless || ctx.message.source !== 'user') return
      const port = ctx.egress as MattermostTurnPort | undefined
      if (!port?.sendTyping) return
      const rootId = mattermostRootIdForMessage(ctx.message)
      await port.sendTyping(ctx.message.channel, rootId).catch(() => undefined)
    },

    answerDelivery: (ctx) => (ctx.mode !== 'none' && !ctx.message.headless ? 'live' : 'staged'),
    fileUploader: (turn) => mattermostFileUploader(turnState<MattermostTurnState>(turn)),
    createConverger: (ctx) => new MattermostConverger(normalizeMode(ctx.mode), ctx.resolveFileLink),
    initialTurnState: (ctx) => initialMattermostTurnState(ctx),
    prepareResponseClosure: (turn) => host.prepareResponseClosure?.(turn),
    closeResponse: (turn) => host.closeResponse?.(turn) ?? Promise.resolve(),
    apply: (turn, action) =>
      applyMattermostAction(host, turn, turnState<MattermostTurnState>(turn), action as MattermostAction),
    onSuppress: (turn) => turnState<MattermostTurnState>(turn).stream?.suppress(),
    onSettle: async (turn) => {
      const state = turnState<MattermostTurnState>(turn)
      await state.stream?.close()
      state.stream = undefined
    }
  }
}
