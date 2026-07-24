// Strictly-monotonic clock for transcript row `ts` values that must be unique AND
// ordered within a (channel, thread) but have no natural platform timestamp — notably
// webchat, whose inbound msgId is stable per-conversation (so it can't supply a per-turn
// ts) and whose reply is recorded moments after the user message. Never returns the same
// value twice in a process, even for two calls in the same millisecond (a fast turn
// records the user message and the reply back-to-back — a plain Date.now() collides and
// the second row is dropped by the transcript's unique index). Fixed-width digits keep
// string comparison == numeric comparison, which the transcript's `ts > ?` cursor relies on.
let last = 0
export function monotonicTs(): string {
  const now = Date.now()
  last = now > last ? now : last + 1
  return String(last)
}
