// The ingress Worker (email-integration.md §7): each inbound message goes, signed, to the relay, and the relay's answer decides its fate.

/** The relay route the Worker posts to; mirrors protocol's `EMAIL_INBOUND_PATH`, since the Worker imports nothing. */
export const INBOUND_PATH = '/email/inbound'

/** The header names beside the raw message; mirrors protocol's `EMAIL_INGRESS_HEADERS`. */
export const INGRESS_HEADERS = {
  timestamp: 'x-ac-email-timestamp',
  from: 'x-ac-email-from',
  to: 'x-ac-email-to',
  size: 'x-ac-email-size',
  signature: 'x-ac-email-signature'
} as const

export const SIGNATURE_VERSION = 'v1'
/** The most bytes of a message posted; the rest is never read. */
export const BODY_MAX_BYTES = 1024 * 1024
/** How long the Worker waits for the relay's answer. */
export const DEADLINE_MS = 10_000

/** The part of the runtime's inbound message the Worker uses. */
export interface InboundEmail {
  readonly from: string
  readonly to: string
  readonly raw: ReadableStream<Uint8Array>
  readonly rawSize: number
  setReject(reason: string): void
}

export interface Env {
  /** The relay's public origin, such as `https://relay.example.test`. */
  RELAY_URL: string
  /** The ingress secret Setup generated, stored as a Worker secret. */
  INGRESS_SECRET: string
}

/** What a test replaces; the runtime's own otherwise. */
export interface Runtime {
  fetch: typeof fetch
  now: () => number
  deadlineMs: number
}

// The first `max` bytes of a stream; the rest is left unread.
async function readAtMost(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (length < max) {
      const { done, value } = await reader.read()
      if (done) break
      const kept = value.subarray(0, max - length)
      chunks.push(kept)
      length += kept.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/** The text the signature covers ahead of the body: the version and the four header values exactly as sent, one a line. */
export function signingPrefix(sent: { timestamp: string; size: string; from: string; to: string }): string {
  return `${SIGNATURE_VERSION}\n${sent.timestamp}\n${sent.size}\n${sent.from}\n${sent.to}\n`
}

async function sign(secret: string, prefix: string, body: Uint8Array): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const head = encoder.encode(prefix)
  const signed = new Uint8Array(head.byteLength + body.byteLength)
  signed.set(head)
  signed.set(body, head.byteLength)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed))
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Post one message and apply the answer: accepted returns, a reject ends the SMTP exchange, and anything else throws so the sender retries. */
export async function handleEmail(message: InboundEmail, env: Env, runtime: Runtime): Promise<void> {
  if (!env.RELAY_URL || !env.INGRESS_SECRET) throw new Error('RELAY_URL and INGRESS_SECRET must be set')
  const body = await readAtMost(message.raw, BODY_MAX_BYTES)
  const sent = {
    timestamp: String(runtime.now()),
    size: String(Math.max(message.rawSize, body.byteLength)),
    from: encodeURIComponent(message.from),
    to: encodeURIComponent(message.to)
  }
  const signature = await sign(env.INGRESS_SECRET, signingPrefix(sent), body)
  const url = `${env.RELAY_URL.replace(/\/+$/, '')}${INBOUND_PATH}`
  const signal = AbortSignal.timeout(runtime.deadlineMs)
  const response = await runtime.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'message/rfc822',
      [INGRESS_HEADERS.timestamp]: sent.timestamp,
      [INGRESS_HEADERS.size]: sent.size,
      [INGRESS_HEADERS.from]: sent.from,
      [INGRESS_HEADERS.to]: sent.to,
      [INGRESS_HEADERS.signature]: `${SIGNATURE_VERSION}=${signature}`
    },
    body,
    signal
  })
  if (response.status !== 200) throw new Error(`relay answered ${response.status}`)
  const answer: unknown = await response.json()
  const result = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {}
  if (result.result === 'accepted') return
  if (result.result === 'reject' && typeof result.reason === 'string' && result.reason) {
    message.setReject(result.reason)
    return
  }
  throw new Error('relay answered 200 without a verdict')
}

export default {
  async email(message: InboundEmail, env: Env): Promise<void> {
    await handleEmail(message, env, {
      fetch: (input, init) => fetch(input, init),
      now: Date.now,
      deadlineMs: DEADLINE_MS
    })
  }
}
