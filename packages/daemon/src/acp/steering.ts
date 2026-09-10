import type { ContentBlock } from '@agentclientprotocol/sdk'

// Mid-turn steering over the `_session/steering` ACP extension shipped by codex-acp (#309) and
// claude-agent-acp. Upstream is standardising the same behaviour as `session/inject`; when that
// lands, this module and AcpHost.steer() are the only places that change.
export const STEERING_METHOD = '_session/steering'

/** The runtime's verdict: `injected` into the running turn, `startedNewTurn` because the session
 *  was idle, or `failed` — anything else the wire carries is read as `failed`. */
export type SteeringOutcome = 'injected' | 'startedNewTurn' | 'failed'

/** `promptRequired` makes an idle session reject the steer instead of opening a turn the daemon
 *  never admitted; `startNewTurn` is the runtimes' own default. */
export type SteeringIdleBehavior = 'promptRequired' | 'startNewTurn'

/** Whether an `initialize` response advertised steering (`_meta.steering.supported === true`). */
export function steeringSupported(initMeta: unknown): boolean {
  if (typeof initMeta !== 'object' || initMeta === null) return false
  const steering = (initMeta as { steering?: unknown }).steering
  if (typeof steering !== 'object' || steering === null) return false
  return (steering as { supported?: unknown }).supported === true
}

/** The `_session/steering` request body for one steer. */
export function steeringRequestParams(
  sessionId: string,
  prompt: ContentBlock[],
  idleBehavior?: SteeringIdleBehavior
): Record<string, unknown> {
  return {
    sessionId,
    prompt,
    ...(idleBehavior ? { _meta: { steering: { idleBehavior } } } : {})
  }
}

/** Read the runtime's `outcome`; an absent or unknown value is a failed steer. */
export function parseSteeringOutcome(response: unknown): SteeringOutcome {
  if (typeof response !== 'object' || response === null) return 'failed'
  const outcome = (response as { outcome?: unknown }).outcome
  return outcome === 'injected' || outcome === 'startedNewTurn' ? outcome : 'failed'
}
