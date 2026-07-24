/**
 * `fencing.ts` — the pure fencing predicates (design §2 / §4.8, protocol §4.2).
 *
 * The CP validates every inbound control frame that carries a `ControlExt` block
 * in the order **epoch → launchId**, mirroring the daemon's own apply order. Each
 * predicate is a pure function returning a discriminated verdict; the connection
 * FSM (`ws/connection.ts`) calls them against the per-connection fencing baseline
 * and turns the first failure into a typed `error` REP.
 *
 * Keeping these transport-free and side-effect-free is what lets the fencing core
 * be unit-tested deterministically and survive the eventual Go-orchestrator split.
 */
import type { ErrorCodeValue } from '../domain/errors.js'

/** A fencing verdict: either the frame is in-bounds, or it is fenced out. */
export type FenceVerdict = { ok: true } | { ok: false; code: ErrorCodeValue; details?: Record<string, unknown> }

const OK: FenceVerdict = { ok: true }

/**
 * Epoch fence (protocol §3.1). A frame issued under an epoch older than the
 * connection's current `sessionEpoch` is a late frame from a pre-reconnect view
 * → `STALE_EPOCH`. Equal or newer epochs pass.
 */
export function checkEpoch(current: number, frameEpoch: number): FenceVerdict {
  return frameEpoch < current ? { ok: false, code: 'STALE_EPOCH' } : OK
}

/**
 * Launch fence (protocol §4.4). When the frame is agent-scoped and carries a
 * `launchId`, it must match the agent's current launch; a frame stamped with a
 * superseded launch → `STALE_LAUNCH`. A frame with no `launchId`, or for an agent
 * with no recorded launch yet, is not launch-fenced.
 */
export function checkLaunch(currentLaunch: string | undefined, frameLaunch: string | undefined): FenceVerdict {
  if (frameLaunch === undefined || currentLaunch === undefined) return OK
  return frameLaunch !== currentLaunch ? { ok: false, code: 'STALE_LAUNCH' } : OK
}

/** The fencing fields lifted off an inbound frame's `ControlExt` block. */
export interface FrameFencing {
  epoch: number
  agentId?: string
  launchId?: string
}

/**
 * Run the full gate in protocol order against a baseline. Returns the first
 * failing verdict, or `{ok:true}` if the frame is fully in-bounds.
 */
export function checkFencing(
  baseline: {
    sessionEpoch: number
    currentLaunch: string | undefined
  },
  frame: FrameFencing
): FenceVerdict {
  const e = checkEpoch(baseline.sessionEpoch, frame.epoch)
  if (!e.ok) return e
  return checkLaunch(baseline.currentLaunch, frame.launchId)
}

/**
 * `FencingState` — the per-connection, per-agent fencing baseline the CP holds.
 *
 * Tracks each agent's current `launchId` (the launch fence). The connection
 * seeds it on `agent/launched`; a frame stamped with a superseded launch is
 * fenced out.
 */
export class FencingState {
  private launchByAgent = new Map<string, string>()

  /** Record/replace the current launch for an agent (on `agent/launched`). */
  setLaunch(agentId: string, launchId: string): void {
    this.launchByAgent.set(agentId, launchId)
  }

  /** The agent's current launch, if any. */
  currentLaunch(agentId: string): string | undefined {
    return this.launchByAgent.get(agentId)
  }
}
