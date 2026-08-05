import { createCipheriv, createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WireFeishuCardActionEvent, WireNormalizedMessage } from '@agentconnect.md/protocol'
import { FeishuHttpIngest, type FeishuCallbackHeaders } from './http-ingest.js'
import { feishuIngressPlugin } from './ingress-plugin.js'
import { registerFeishuHttpIngress } from './http-ingress.js'
import type { RelayInboundSeam } from '../contract.js'

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
      sender: { sender_id: { open_id: 'ou_human', union_id: 'on_human' }, sender_type: 'user' },
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
  const actions: WireFeishuCardActionEvent[] = []
  const ingest = new FeishuHttpIngest('bot-1', 'cli_http_app', secrets, {
    onMessage: async (message) => {
      messages.push(message)
    },
    onCardAction: async (action) => {
      actions.push(action)
      return { toast: { type: 'info', content: 'Cancellation requested.' } }
    },
    now: () => NOW
  })
  // Drive the REAL plugin (verify → handle) through the seam: token check /
  // AES decrypt, the encrypted challenge, per-bot dedup, and the card-action
  // response window all run exactly as production does.
  const host = {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    dedupSeen: () => false,
    clock: { now: () => NOW }
  } as unknown as import('../contract.js').RelayIngressHost
  const resolver: RelayInboundSeam = {
    handleInbound: async (_platformId, rawBody, body, headers) => {
      const verified = feishuIngressPlugin.verify(
        ingest,
        rawBody,
        body,
        headers as Record<string, string | string[] | undefined>,
        NOW
      )
      if (verified === undefined) return undefined
      return feishuIngressPlugin.handle(ingest, verified, host)
    }
  }
  const app = Fastify()
  registerFeishuHttpIngress(app, { manager: () => resolver, log })
  return { app, messages, actions }
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
      sender: { id: 'on_human', isBot: false },
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

  it('forwards card actions and returns the daemon callback response', async () => {
    const h = makeApp()
    app = h.app
    const action = {
      context: { open_message_id: 'om_card', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_human' },
      action: {
        tag: 'overflow',
        option: 'cancel',
        value: {
          action: 'agentconnect_reply',
          target: {
            v: 1,
            agentId: '33333333-3333-4333-8333-333333333333',
            integrationId: '44444444-4444-4444-8444-444444444444'
          }
        }
      }
    }
    const body = {
      schema: '2.0',
      header: {
        event_id: 'evt-action',
        event_type: 'card.action.trigger',
        token: 'verify-token',
        app_id: 'cli_http_app'
      },
      event: action
    }
    const response = await app.inject({
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

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ toast: { type: 'info', content: 'Cancellation requested.' } })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual({})
    expect(h.actions).toEqual([action])
  })

  it('decrypts URL verification without requiring event-signature headers', async () => {
    const encryptKey = 'encrypt-key'
    const h = makeApp({ verificationToken: 'verify-token', encryptKey })
    app = h.app
    const delivery = encryptedEnvelope(
      {
        type: 'url_verification',
        token: 'verify-token',
        app_id: 'cli_http_app',
        challenge: 'challenge-encrypted'
      },
      encryptKey
    )
    const response = await app.inject({
      method: 'POST',
      url: '/feishu/events',
      headers: { 'content-type': 'application/json' },
      payload: delivery.raw
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ challenge: 'challenge-encrypted' })
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
