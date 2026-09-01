import { createHmac } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'
import { LinearHttpIngest, LINEAR_BODY_LIMIT } from './http-ingest.js'
import { linearIngressPlugin } from './ingress-plugin.js'
import { registerLinearHttpIngress } from './http-ingress.js'
import type { RelayIngressHost, RelayInboundSeam } from '../contract.js'

const NOW = 1_788_249_909_143
const SIGNING_SECRET = 'lin_wh_00000000000000000000000000000000'
const CLIENT_ID = '00000000000000000000000000000001'
const ORG_ID = '00000000-0000-4000-8000-000000000001'
const SIBLING_ORG_ID = '00000000-0000-4000-8000-000000000002'
const SESSION_ID = '00000000-0000-4000-8000-0000000000s1'
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function eventBody(sessionId = SESSION_ID, organizationId = ORG_ID) {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId,
    oauthClientId: CLIENT_ID,
    appUserId: '00000000-0000-4000-8000-0000000000a1',
    agentSession: {
      id: sessionId,
      creatorId: '00000000-0000-4000-8000-0000000000u1',
      comment: { body: 'please take a look' },
      issue: { id: '00000000-0000-4000-8000-0000000000i1', identifier: 'AGE-5', title: 'Probe' }
    },
    previousComments: null,
    guidance: null,
    promptContext: '<issue identifier="AGE-5"/>',
    webhookTimestamp: NOW
  }
}

// Drive the REAL plugin (verify → handle) behind the route so the shipped 200/401 contract is
// exercised end to end. Two ingests share ONE signing secret — the sibling-install shape.
function makeApp(forward: (msg: WireNormalizedMessage) => Promise<void> = async () => {}) {
  const messages: WireNormalizedMessage[] = []
  const host = {
    forward: async (_botId: string, msg: WireNormalizedMessage) => {
      messages.push(msg)
      await forward(msg)
    },
    dedupSeen: () => false,
    reportRevoked: vi.fn(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { now: () => NOW }
  } as unknown as RelayIngressHost
  const pool = [
    new LinearHttpIngest('bot-1', { clientId: CLIENT_ID, organizationId: ORG_ID }, SIGNING_SECRET, () => NOW),
    new LinearHttpIngest('bot-2', { clientId: CLIENT_ID, organizationId: SIBLING_ORG_ID }, SIGNING_SECRET, () => NOW)
  ]
  const served: string[] = []
  const resolver: RelayInboundSeam = {
    handleInbound: async (_platformId, rawBody, body, headers) => {
      for (const ingest of pool) {
        const verified = linearIngressPlugin.verify(
          ingest,
          rawBody,
          body,
          headers as Record<string, string | string[] | undefined>,
          NOW
        )
        if (verified === undefined) continue
        served.push(ingest.botId)
        return linearIngressPlugin.handle(ingest, verified, host)
      }
      return undefined
    }
  }
  const app = Fastify()
  registerLinearHttpIngress(app, { manager: () => resolver, log })
  return { app, messages, served }
}

function post(app: FastifyInstance, body: unknown, over: { secret?: string; timestamp?: number } = {}) {
  const payload = JSON.stringify(body)
  const signature = createHmac('sha256', over.secret ?? SIGNING_SECRET)
    .update(Buffer.from(payload))
    .digest('hex')
  return app.inject({
    method: 'POST',
    url: '/linear/events',
    headers: {
      'content-type': 'application/json',
      'linear-event': 'AgentSessionEvent',
      'linear-delivery': '00000000-0000-4000-8000-0000000000d1',
      'linear-signature': signature,
      'linear-timestamp': String(over.timestamp ?? NOW)
    },
    payload
  })
}

describe('Linear HTTP ingress route', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('answers 200 and forwards one normalized message', async () => {
    const h = makeApp()
    app = h.app
    const response = await post(app, eventBody())
    expect(response.statusCode).toBe(200)
    await vi.waitFor(() => expect(h.messages).toHaveLength(1))
    expect(h.messages[0]).toMatchObject({ platform: 'linear', thread: SESSION_ID })
  })

  it('serves each workspace from its OWN bot even though both verify the same signature', async () => {
    const h = makeApp()
    app = h.app
    await post(app, eventBody(SESSION_ID, ORG_ID))
    await post(app, eventBody(SESSION_ID, SIBLING_ORG_ID))
    expect(h.served).toEqual(['bot-1', 'bot-2'])
  })

  it('answers 401 for a delivery no assigned bot owns — no oracle', async () => {
    const h = makeApp()
    app = h.app
    const forged = await post(app, eventBody(), { secret: 'another-apps-secret' })
    const unknownWorkspace = await post(app, eventBody(SESSION_ID, '00000000-0000-4000-8000-00000000000f'))
    expect(forged.statusCode).toBe(401)
    expect(unknownWorkspace.statusCode).toBe(401)
    expect(forged.json()).toEqual(unknownWorkspace.json())
    expect(h.messages).toHaveLength(0)
  })

  it('answers 400 for a body that is not JSON at all', async () => {
    const h = makeApp()
    app = h.app
    const response = await app.inject({
      method: 'POST',
      url: '/linear/events',
      headers: { 'content-type': 'application/json' },
      payload: 'not-json'
    })
    expect(response.statusCode).toBe(400)
  })

  it('returns 200 BEFORE daemon delivery resolves (§6.1)', async () => {
    let release = (): void => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = makeApp(() => pending)
    app = h.app
    const response = await post(app, eventBody())
    expect(response.statusCode).toBe(200)
    release()
    await pending
  })

  it('refuses a body over the 1 MiB cap', async () => {
    const h = makeApp()
    app = h.app
    const oversized = eventBody()
    ;(oversized.agentSession as Record<string, unknown>).comment = { body: 'x'.repeat(LINEAR_BODY_LIMIT) }
    const response = await post(app, oversized)
    expect(response.statusCode).toBe(413)
    expect(h.messages).toHaveLength(0)
  })
})
