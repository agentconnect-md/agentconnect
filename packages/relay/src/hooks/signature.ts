/**
 * Shared `sha256=<hex>` HMAC header verification — the security-sensitive core
 * (prefix parse, hex decode, length check BEFORE timingSafeEqual) used by both
 * public ingress endpoints: `X-AC-Signature` on the generic webhook and
 * `X-Hub-Signature-256` on the GitHub endpoint. One implementation so the two
 * cannot drift.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** True iff `header` is `sha256=<hex>` of HMAC-SHA256(secret, rawBody), timing-safe. */
export function verifySha256Header(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  let presented: Buffer
  try {
    presented = Buffer.from(header.slice('sha256='.length), 'hex')
  } catch {
    return false
  }
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/** Replay window for Slack's `X-Slack-Request-Timestamp` (Slack's own recommendation). */
const SLACK_REPLAY_WINDOW_SEC = 300

/**
 * Slack Events API request verification (differs from the `sha256=` GitHub scheme):
 *   basestring = `v0:${timestamp}:${rawBody}`
 *   header     = `v0=` + hex(HMAC-SHA256(signingSecret, basestring))
 * The `timestamp` is the raw `X-Slack-Request-Timestamp` header; `rawBody` is the
 * exact request bytes (JSON for /events, the `payload=…` urlencoded bytes for
 * /interactions). Rejects a timestamp more than 5 minutes from `nowMs` (replay),
 * then compares timing-safe. `signingSecret` is secret — never logged.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  rawBody: Buffer,
  header: string | undefined,
  nowMs: number
): boolean {
  if (!header || !header.startsWith('v0=')) return false
  if (!timestamp) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(nowMs / 1000 - ts) > SLACK_REPLAY_WINDOW_SEC) return false
  const basestring = `v0:${timestamp}:${rawBody.toString('utf8')}`
  const expected = createHmac('sha256', signingSecret).update(basestring).digest()
  let presented: Buffer
  try {
    presented = Buffer.from(header.slice('v0='.length), 'hex')
  } catch {
    return false
  }
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}
