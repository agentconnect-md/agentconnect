/** Shared ingress credential checks (HMAC-SHA256 headers, Basic credentials), timing-safe, one implementation so the endpoints cannot drift. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** True iff `hex` is the lowercase/uppercase hex HMAC-SHA256(secret, rawBody), timing-safe. */
export function verifyHexHmacSha256(secret: string, rawBody: Buffer, hex: string | undefined): boolean {
  if (!hex) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  let presented: Buffer
  try {
    presented = Buffer.from(hex, 'hex')
  } catch {
    return false
  }
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/** True iff `header` is `sha256=<hex>` of HMAC-SHA256(secret, rawBody), timing-safe. */
export function verifySha256Header(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  return verifyHexHmacSha256(secret, rawBody, header.slice('sha256='.length))
}

/** True iff `header` is `Basic base64(user:password)` for exactly this pair, compared timing-safe over fixed-length digests. */
export function verifyBasicAuthorization(user: string, password: string, header: string | undefined): boolean {
  if (!header) return false
  const match = /^Basic +([A-Za-z0-9+/]+={0,2}) *$/i.exec(header)
  if (!match) return false
  const presented = createHash('sha256').update(Buffer.from(match[1]!, 'base64')).digest()
  const expected = createHash('sha256').update(`${user}:${password}`, 'utf8').digest()
  return timingSafeEqual(presented, expected)
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
