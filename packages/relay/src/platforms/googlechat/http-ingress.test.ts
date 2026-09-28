import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_CHAT_EVENTS_PATH } from '@agentconnect.md/protocol'
import { GOOGLE_CHAT_ADMISSION_DEADLINE_MS, registerGoogleChatHttpIngress } from './http-ingress.js'
import type { HandledDelivery, RelayInboundSeam } from '../contract.js'
import { dmMessage } from '../../../test/fixtures/google-chat-events.js'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// The seam is faked here: the plugin's verify/handle contract has its own suite, this one pins the HTTP answers.
function makeApp(handleInbound?: RelayInboundSeam['handleInbound'], deadlineMs?: number): FastifyInstance {
  const app = Fastify()
  const seam = handleInbound ? { handleInbound } : undefined
  registerGoogleChatHttpIngress(app, { manager: () => seam, log }, deadlineMs)
  return app
}

const answering =
  (handled: HandledDelivery | undefined): RelayInboundSeam['handleInbound'] =>
  async () =>
    handled

function post(app: FastifyInstance, payload: string) {
  return app.inject({
    method: 'POST',
    url: GOOGLE_CHAT_EVENTS_PATH,
    headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic' },
    payload
  })
}

describe('Google Chat HTTP ingress route', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('answers 400 for a body that is not an add-on request', async () => {
    const handleInbound = vi.fn(answering({}))
    app = makeApp(handleInbound)
    const payloads = [
      'not json',
      '[]',
      '{}',
      '{"type":"MESSAGE"}',
      'null',
      '{"chat":"x"}',
      '{"chat":[]}',
      '{"commonEventObject":{}}'
    ]
    for (const payload of payloads) {
      expect((await post(app, payload)).statusCode, payload).toBe(400)
    }
    expect(handleInbound).not.toHaveBeenCalled()
  })

  it('answers 401 when no assigned bot owns the delivery, and before the manager exists', async () => {
    app = makeApp(answering(undefined))
    expect((await post(app, JSON.stringify(dmMessage))).statusCode).toBe(401)
    await app.close()
    app = makeApp()
    expect((await post(app, JSON.stringify(dmMessage))).statusCode).toBe(401)
  })

  it('answers 200 with an empty object for an admitted, rejected, or admission-less delivery', async () => {
    for (const handled of [
      { admission: { disposition: 'admitted' as const } },
      { admission: { disposition: 'rejected' as const, reason: 'muted' as const } },
      {}
    ]) {
      app = makeApp(answering(handled))
      const response = await post(app, JSON.stringify(dmMessage))
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({})
      await app.close()
      app = undefined
    }
  })

  it('sends the handled delivery’s synchronous body on the 200: the welcome card or the authorization prompt (§10.4)', async () => {
    const prompt = {
      basic_authorization_prompt: {
        authorization_url: 'https://console.example.test/googlechat/claim?state=e30',
        resource: 'AgentConnect'
      }
    }
    const handleInbound = vi.fn(answering({ syncResponse: prompt }))
    app = makeApp(handleInbound)
    const response = await post(app, JSON.stringify(dmMessage))
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/application\/json/)
    expect(response.json()).toEqual(prompt)
    expect(handleInbound).toHaveBeenCalledTimes(1)
  })

  it('answers 503 for a retry verdict so Google may redeliver', async () => {
    app = makeApp(answering({ admission: { disposition: 'retry', reason: 'draining' } }))
    expect((await post(app, JSON.stringify(dmMessage))).statusCode).toBe(503)
  })

  it('answers 503 when handling throws — an unknown outcome is never a success', async () => {
    app = makeApp(async () => {
      throw new Error('relay hiccup')
    })
    expect((await post(app, JSON.stringify(dmMessage))).statusCode).toBe(503)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed'))
  })

  it('answers 503 when the admission deadline expires inside Google’s window', async () => {
    // The shipped deadline is pinned here; the expiry itself runs on a short one so no clock is faked.
    expect(GOOGLE_CHAT_ADMISSION_DEADLINE_MS).toBe(20_000)
    app = makeApp(() => new Promise(() => {}), 50)
    const response = await post(app, JSON.stringify(dmMessage))
    expect(response.statusCode).toBe(503)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('expired'))
  })
})
