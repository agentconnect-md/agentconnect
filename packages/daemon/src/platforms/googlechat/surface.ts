// Google Chat's Layer-2 registration (integration-plugin-architecture.md §7.3): the surface core looks up by platform id.
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputSurface } from '../turn-output.js'
import { googleChatElicitCards } from './elicit-card.js'
import {
  applyGoogleChatAction,
  GoogleChatConverger,
  initialGoogleChatTurnState,
  type GoogleChatAction,
  type GoogleChatOutputMode,
  type GoogleChatTurnHost,
  type GoogleChatTurnState
} from './turn-output.js'

const MODES: readonly GoogleChatOutputMode[] = ['none', 'minimal', 'low', 'medium', 'high']

function normalizeMode(mode: string): GoogleChatOutputMode {
  return (MODES as readonly string[]).includes(mode) ? (mode as GoogleChatOutputMode) : 'low'
}

export function createGoogleChatTurnOutput(
  host: GoogleChatTurnHost<Pending>
): TurnOutputSurface<Pending, DaemonRenderAction, GoogleChatConverger, NormalizedMessage> {
  return {
    platform: 'googlechat',
    elicitCards: googleChatElicitCards,
    createConverger: (ctx) => new GoogleChatConverger(normalizeMode(ctx.mode), ctx.resolveFileLink),
    initialTurnState: (ctx): GoogleChatTurnState => initialGoogleChatTurnState(ctx),
    apply: (turn, action) =>
      applyGoogleChatAction(host, turn, turnState<GoogleChatTurnState>(turn), action as GoogleChatAction),
    onSuppress: (turn) => turnState<GoogleChatTurnState>(turn).stream?.suppress(),
    onSettle: async (turn) => {
      const state = turnState<GoogleChatTurnState>(turn)
      await state.stream?.close()
      state.stream = undefined
    }
  }
}
