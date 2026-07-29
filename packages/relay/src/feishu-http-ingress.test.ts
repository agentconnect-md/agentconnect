import { createCipheriv, createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'
import { FeishuHttpIngest, type FeishuCallbackHeaders } from './feishu-http-ingest.js'
import {
  registerFeishuHttpIngress,
  type FeishuIngestResolver,
  type FeishuVerifiedDelivery
} from './feishu-http-ingress.js'

const NOW = 1_720_000_000_000
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function eventBody(eventId = 'evt-1') {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      token: 'verify-token',
      app_id: 'cli_http_app'
    },
    event: {
      sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Agent' }]
      }
    }
  }
}

function encryptedEnvelope(
  inner: unknown,
  encryptKey: string
): {
  raw: string
  headers: Required<FeishuCallbackHeaders>
} {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = Buffer.alloc(16, 7)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(inner), 'utf8'), cipher.final()]).toString('base64')
  const raw = JSON.stringify({ encrypt: encrypted })
  const timestamp = String(NOW / 1000)
  const nonce = 'nonce-1'
  const signature = createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(raw).digest('hex')
  return { raw, headers: { timestamp, nonce, signature } }
}

function makeApp(secrets: { verificationToken: string; encryptKey?: string } = { verificationToken: 'verify-token' }) {
  const messages: WireNormalizedMessage[] = []
  const ingest = new FeishuHttpIngest('bot-1', 'cli_http_app', secrets, {
    onMessage: async (message) => {
      messages.push(message)
    },
    now: () => NOW
  })
  const resolver: FeishuIngestResolver = {
    resolveFeishuVerified(args): FeishuVerifiedDelivery | undefined {
      const callback = ingest.decode(args.rawBody, args.body, args.headers)
      return callback ? { ingest, callback } : undefined
    }
  }
  const app = Fastify()
  registerFeishuHttpIngress(app, { manager: () => resolver, log })
  return { app, messages }
}

describe('Feishu HTTP ingress', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('verifies the token and answers URL verification challenges', async () => {
    const h = makeApp()
    app = h.app
    const response = await app.inject({
      method: 'POST',
      url: '/feishu/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        type: 'url_verification',
        token: 'verify-token',
        challenge: 'challenge-42',
        app_id: 'cli_http_app'
      })
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ challenge: 'challenge-42' })
  })

  it('normalizes and forwards one message while deduplicating event retries', async () => {
    const h = makeApp()
    app = h.app
    const body = eventBody()
    const first = await app.inject({
      method: 'POST',
      url: '/feishu/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body)
    })
    const retry = await app.inject({
      method: 'POST',
      url: '/feishu/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body)
    })
    expect(first.statusCode).toBe(200)
    expect(retry.statusCode).toBe(200)
    await vi.waitFor(() => expect(h.messages).toHaveLength(1))
    expect(h.messages[0]).toMatchObject({
      msgId: 'feishu:oc_1:om_1',
      platform: 'feishu',
      channel: 'oc_1',
      sender: { id: 'ou_human', isBot: false },
      text: '@Agent hello',
      mentionedBots: ['ou_bot']
    })
  })

  it('decrypts and signature-verifies encrypted callbacks', async () => {
    const encryptKey = 'encrypt-key'
    const h = makeApp({ verificationToken: 'verify-token', encryptKey })
    app = h.app
    const delivery = encryptedEnvelope(eventBody('evt-encrypted'), encryptKey)
    const response = await app.inject({
      method: 'POST',
      url: '/feishu/events',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': delivery.headers.timestamp,
        'x-lark-request-nonce': delivery.headers.nonce,
        'x-lark-signature': delivery.headers.signature
      },
      payload: delivery.raw
    })
    expect(response.statusCode).toBe(200)
    await vi.waitFor(() => expect(h.messages).toHaveLength(1))
  })

  it('rejects forged tokens and signatures', async () => {
    const plain = makeApp()
    app = plain.app
    const badToken = await app.inject({
      method: 'POST',
      url: '/feishu/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...eventBody(),
        header: { ...eventBody().header, token: 'wrong-token' }
      })
    })
    expect(badToken.statusCode).toBe(401)
    await app.close()

    const encryptKey = 'encrypt-key'
    const encrypted = makeApp({ verificationToken: 'verify-token', encryptKey })
    app = encrypted.app
    const delivery = encryptedEnvelope(eventBody(), encryptKey)
    const badSignature = await app.inject({
      method: 'POST',
      url: '/feishu/events',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': delivery.headers.timestamp,
        'x-lark-request-nonce': delivery.headers.nonce,
        'x-lark-signature': '0'.repeat(64)
      },
      payload: delivery.raw
    })
    expect(badSignature.statusCode).toBe(401)
    expect(encrypted.messages).toHaveLength(0)
  })
})
