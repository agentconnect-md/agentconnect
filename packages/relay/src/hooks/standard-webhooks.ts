/**
 * Standard Webhooks verification (gitlab-com-integration.md §11.2): the signed
 * content is `"{webhook-id}.{webhook-timestamp}.{raw-body}"`, the key is the
 * base64 payload of the `whsec_` signing token, and the signature header is a
 * space-separated list of `v1,<base64>` entries — any timing-safe match
 * accepts. Timestamps outside the replay window reject before any HMAC work.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** §11.2 replay window: reject webhook-timestamp drift beyond this. */
export const STANDARD_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000

export function verifyStandardWebhook(
  signingToken: string,
  webhookId: string,
  webhookTimestamp: string,
  rawBody: Buffer,
  signatureHeader: string,
  nowMs: number
): boolean {
  if (!signingToken.startsWith('whsec_')) return false
  const seconds = Number(webhookTimestamp)
  if (!Number.isSafeInteger(seconds)) return false
  if (Math.abs(nowMs - seconds * 1000) > STANDARD_WEBHOOK_TOLERANCE_MS) return false
  let key: Buffer
  try {
    key = Buffer.from(signingToken.slice('whsec_'.length), 'base64')
  } catch {
    return false
  }
  if (key.length === 0) return false
  const expected = createHmac('sha256', key).update(`${webhookId}.${webhookTimestamp}.`).update(rawBody).digest()
  for (const entry of signatureHeader.split(' ')) {
    const [version, sig] = entry.split(',', 2)
    if (version !== 'v1' || !sig) continue
    let candidate: Buffer
    try {
      candidate = Buffer.from(sig, 'base64')
    } catch {
      continue
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true
  }
  return false
}
