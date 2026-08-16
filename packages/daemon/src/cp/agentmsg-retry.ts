// The SOURCE side of the retryable `rd/agentmsg` verdict (#987): a pool target is briefly addressable by
// nobody (grant → confirming digest; lapsed lease → claim), the relay/target answer `not_ready` and cache
// nothing, so ONE deliveryId is re-sent with backoff for a few lease horizons, then the last `not_ready`
// is terminal. Exactly-once holds because the id never changes: a landed attempt replays from the target's dedup.
import { isRetryableAgentMsgAck, type RdAgentMsg, type RdAgentMsgAck } from '@agentconnect.md/protocol'
import { Backoff, type Clock } from '@agentconnect.md/connection'

/** Bounded retry policy: total window plus the backoff bounds of the delays inside it. */
export interface AgentMsgRetryPolicy {
  windowMs: number
  baseMs: number
  capMs: number
}

/** Three lease horizons (`DUTY_LEASE_DEFAULTS.leaseMs` = 120s) — covers lapse + claim + install + digest. */
export const AGENTMSG_NOT_READY_RETRY: AgentMsgRetryPolicy = { windowMs: 360_000, baseMs: 1_000, capMs: 15_000 }

export interface SendAgentMsgUntilReadyDeps {
  send: (payload: RdAgentMsg) => Promise<RdAgentMsgAck>
  clock: Clock
  policy?: AgentMsgRetryPolicy
  /** Backoff jitter in [0,1); tests inject `() => 0`. */
  jitter?: () => number
  onRetry?: (attempt: number, delayMs: number) => void
}

/** Send `payload` and re-send the SAME deliveryId while the verdict is `not_ready`, bounded by the policy window. */
export async function sendAgentMsgUntilReady(
  payload: RdAgentMsg,
  deps: SendAgentMsgUntilReadyDeps
): Promise<RdAgentMsgAck> {
  const policy = deps.policy ?? AGENTMSG_NOT_READY_RETRY
  const backoff = new Backoff({
    baseMs: policy.baseMs,
    capMs: policy.capMs,
    ...(deps.jitter ? { jitter: deps.jitter } : {})
  })
  const deadline = deps.clock.now() + policy.windowMs
  for (let attempt = 1; ; attempt += 1) {
    const ack = await deps.send(payload)
    if (!isRetryableAgentMsgAck(ack)) return ack
    const delay = backoff.next()
    // The next attempt would land past the window: the verdict is terminal now.
    if (deps.clock.now() + delay > deadline) return ack
    deps.onRetry?.(attempt, delay)
    await new Promise<void>((resolve) => deps.clock.setTimeout(resolve, delay))
  }
}
