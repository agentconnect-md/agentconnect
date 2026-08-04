/**
 * The **malformed-turn strategy** (§7.4, stage S2): can a platform's ingress
 * produce a poison shape — a wrapper event normalized as if it were a real
 * message — and what does that shape look like?
 *
 * Only the platform can answer, because the shape is an artifact of ITS wire
 * format meeting the normalizer. Slack's is the `message_changed` / assistant
 * metadata wrapper: normalized, it reads as an anonymous, empty,
 * attachment-less user turn — which no supported platform produces
 * legitimately, so the detector fails closed and the caller latches the
 * conversation's loop guard rather than replaying the wrapper as input.
 *
 * The default is "never malformed": a platform with no registered detector has
 * no known poison shape, which is exactly the pre-existing behavior for every
 * non-Slack platform. Detectors gate DESTRUCTIVE handling (loop-guard latches,
 * durable inbox drops), so a false positive is worse than a false negative —
 * register a shape only when it is exact.
 */

/** The message fields a detector may read. `NormalizedMessage` satisfies it
 *  structurally. */
export interface MalformedTurnMessage {
  platform: string
  source: string
  sender: { id: string; isBot: boolean }
  text: string
  attachments?: unknown[]
}

const DETECTORS = new Map<string, (msg: MalformedTurnMessage) => boolean>([
  [
    'slack',
    // The exact poison shape produced when a Slack message_changed/assistant
    // metadata wrapper was normalized as if it were a real message.
    (msg) =>
      msg.source === 'user' &&
      !msg.sender.isBot &&
      msg.sender.id === 'unknown' &&
      msg.text.trim() === '' &&
      (msg.attachments?.length ?? 0) === 0
  ]
])

/** Is this turn a known poison shape of its platform? Total by construction:
 *  no registered detector means no known poison shape — never malformed. */
export function isMalformedPlatformTurn(msg: MalformedTurnMessage): boolean {
  return DETECTORS.get(msg.platform)?.(msg) ?? false
}
