import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  EMAIL_INBOUND_PATH,
  EMAIL_INGRESS_BODY_MAX_BYTES,
  EMAIL_INGRESS_DEADLINE_MS,
  EMAIL_INGRESS_HEADERS,
  EMAIL_INGRESS_SIGNATURE_VERSION,
  emailIngressSigningPrefix
} from '@agentconnect.md/protocol'
import {
  BODY_MAX_BYTES,
  DEADLINE_MS,
  INBOUND_PATH,
  INGRESS_HEADERS,
  SIGNATURE_VERSION,
  handleEmail,
  signingPrefix,
  type Env,
  type InboundEmail
} from '../src/index.js'

const ENV: Env = { RELAY_URL: 'https://relay.example.test/', INGRESS_SECRET: 'synthetic-ingress-secret-0123456789' }
const NOW = 1_800_000_000_000

// A fake of the runtime's message: the raw bytes arrive in chunks, and a reject is recorded.
function message(raw: Uint8Array, over: Partial<InboundEmail> = {}) {
  const rejects: string[] = []
  let pulled = 0
  const chunk = 64 * 1024
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= raw.byteLength) return controller.close()
      controller.enqueue(raw.subarray(pulled, pulled + chunk))
      pulled += chunk
    }
  })
  const email: InboundEmail = {
    from: 'alice@corp.example.test',
    to: 'helper+tag@mail.example.test',
    raw: stream,
    rawSize: raw.byteLength,
    setReject: (reason) => void rejects.push(reason),
    ...over
  }
  return { email, rejects, pulled: () => pulled }
}

interface Posted {
  url: string
  headers: Record<string, string>
  body: Buffer
}

function relay(answer: (posted: Posted, signal: AbortSignal) => Promise<Response>) {
  const posted: Posted[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const entry = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: Buffer.from(init?.body as Uint8Array)
    }
    posted.push(entry)
    return await answer(entry, init!.signal!)
  }) as unknown as typeof fetch
  return { posted, runtime: { fetch: fetchImpl, now: () => NOW, deadlineMs: 200 } }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const raw = Buffer.from('From: alice@corp.example.test\r\nSubject: Hi\r\n\r\nHello\r\n')

describe('email ingress Worker', () => {
  it("mirrors protocol's contract with the relay", () => {
    expect(INBOUND_PATH).toBe(EMAIL_INBOUND_PATH)
    expect(INGRESS_HEADERS).toEqual(EMAIL_INGRESS_HEADERS)
    expect(SIGNATURE_VERSION).toBe(EMAIL_INGRESS_SIGNATURE_VERSION)
    expect(BODY_MAX_BYTES).toBe(EMAIL_INGRESS_BODY_MAX_BYTES)
    expect(DEADLINE_MS).toBe(EMAIL_INGRESS_DEADLINE_MS)
    const sent = { timestamp: '1', size: '2', from: 'a%40b', to: 'c%40d' }
    expect(signingPrefix(sent)).toBe(emailIngressSigningPrefix(sent))
  })

  it('posts the message with the envelope and a signature over exactly what it sent, and accepts on accepted', async () => {
    const { email, rejects } = message(raw)
    const { posted, runtime } = relay(async () => json(200, { result: 'accepted' }))
    await handleEmail(email, ENV, runtime)
    expect(rejects).toEqual([])
    const [post] = posted
    expect(post!.url).toBe('https://relay.example.test/email/inbound')
    expect(post!.body.equals(raw)).toBe(true)
    const h = post!.headers
    expect(h).toMatchObject({
      'content-type': 'message/rfc822',
      [EMAIL_INGRESS_HEADERS.timestamp]: String(NOW),
      [EMAIL_INGRESS_HEADERS.size]: String(raw.length),
      [EMAIL_INGRESS_HEADERS.from]: 'alice%40corp.example.test',
      [EMAIL_INGRESS_HEADERS.to]: 'helper%2Btag%40mail.example.test'
    })
    const prefix = emailIngressSigningPrefix({
      timestamp: h[EMAIL_INGRESS_HEADERS.timestamp]!,
      size: h[EMAIL_INGRESS_HEADERS.size]!,
      from: h[EMAIL_INGRESS_HEADERS.from]!,
      to: h[EMAIL_INGRESS_HEADERS.to]!
    })
    const mac = createHmac('sha256', ENV.INGRESS_SECRET).update(prefix).update(post!.body).digest('hex')
    expect(h[EMAIL_INGRESS_HEADERS.signature]).toBe(`v1=${mac}`)
  })

  it('sends at most the first MiB of a larger message, and its full size beside it', async () => {
    const big = Buffer.alloc(BODY_MAX_BYTES * 3, 0x61)
    const { email, pulled } = message(big)
    const { posted, runtime } = relay(async () => json(200, { result: 'accepted' }))
    await handleEmail(email, ENV, runtime)
    expect(posted[0]!.body.length).toBe(BODY_MAX_BYTES)
    expect(posted[0]!.headers[EMAIL_INGRESS_HEADERS.size]).toBe(String(big.length))
    expect(pulled()).toBeLessThan(big.length)
  })

  it('signs an empty envelope sender as an empty value', async () => {
    const { email } = message(raw, { from: '' })
    const { posted, runtime } = relay(async () => json(200, { result: 'accepted' }))
    await handleEmail(email, ENV, runtime)
    expect(posted[0]!.headers[EMAIL_INGRESS_HEADERS.from]).toBe('')
  })

  it('rejects the message with the relay reason', async () => {
    const { email, rejects } = message(raw)
    const { runtime } = relay(async () => json(200, { result: 'reject', reason: 'This address does not exist.' }))
    await handleEmail(email, ENV, runtime)
    expect(rejects).toEqual(['This address does not exist.'])
  })

  it('fails the event for a 503, any other status, a 200 without a verdict, a network error and a timeout', async () => {
    const answers: ((posted: Posted, signal: AbortSignal) => Promise<Response>)[] = [
      async () => json(503, { error: 'Service Unavailable' }),
      async () => new Response(null, { status: 401 }),
      async () => json(500, {}),
      async () => json(202, { result: 'accepted' }),
      async () => json(200, { result: 'reject' }),
      async () => new Response('not json', { status: 200 }),
      async () => {
        throw new TypeError('network')
      },
      (_posted, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    ]
    for (const answer of answers) {
      const { email, rejects } = message(raw)
      const { runtime } = relay(answer)
      await expect(handleEmail(email, ENV, runtime)).rejects.toBeDefined()
      expect(rejects).toEqual([])
    }
  })

  it('fails the event when it is not configured, before posting anything', async () => {
    const { email } = message(raw)
    const { posted, runtime } = relay(async () => json(200, { result: 'accepted' }))
    await expect(handleEmail(email, { ...ENV, INGRESS_SECRET: '' }, runtime)).rejects.toThrow(/INGRESS_SECRET/)
    expect(posted).toEqual([])
  })
})
