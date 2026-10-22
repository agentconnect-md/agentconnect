// Teams' Layer-2 registration (integration-plugin-architecture.md §7.3): the surface core looks up by platform id.
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputSurface } from '../turn-output.js'
import {
  acknowledgeMsTeamsTurn,
  applyMsTeamsAction,
  initialMsTeamsTurnState,
  MsTeamsConverger,
  type MsTeamsAction,
  type MsTeamsOutputMode,
  type MsTeamsTurnHost,
  type MsTeamsTurnState
} from './turn-output.js'

const MODES: readonly MsTeamsOutputMode[] = ['none', 'minimal', 'low', 'medium', 'high']

function normalizeMode(mode: string): MsTeamsOutputMode {
  return (MODES as readonly string[]).includes(mode) ? (mode as MsTeamsOutputMode) : 'low'
}

export function createMsTeamsTurnOutput(
  host: MsTeamsTurnHost<Pending>
): TurnOutputSurface<Pending, DaemonRenderAction, MsTeamsConverger, NormalizedMessage> {
  return {
    platform: MSTEAMS_PLATFORM,
    // The bot posts one message as its acknowledgement and the answer edits it (§4.3).
    acknowledge: (ctx, turn) => acknowledgeMsTeamsTurn(ctx, turn, { warn: (message) => host.warn(message) }),
    createConverger: (ctx) => new MsTeamsConverger(normalizeMode(ctx.mode), ctx.resolveFileLink),
    initialTurnState: (ctx): MsTeamsTurnState => initialMsTeamsTurnState(ctx),
    apply: (turn, action) => applyMsTeamsAction(host, turn, turnState<MsTeamsTurnState>(turn), action as MsTeamsAction),
    onSuppress: (turn) => turnState<MsTeamsTurnState>(turn).stream?.suppress(),
    onSettle: async (turn) => {
      const state = turnState<MsTeamsTurnState>(turn)
      await state.stream?.close()
      state.stream = undefined
    }
  }
}
