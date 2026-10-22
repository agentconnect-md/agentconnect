import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MSTEAMS_MESSAGES_PATH } from '@agentconnect.md/protocol'
import {
  MSTEAMS_ADMISSION_DEADLINE_MS,
  MSTEAMS_INVOKE_DEADLINE_MS,
  MSTEAMS_INVOKE_UNAVAILABLE,
  registerMsTeamsHttpIngress
} from './http-ingress.js'
import { msTeamsInvokeNote } from './http-ingest.js'
import type { HandledDelivery, RelayInboundSeam } from '../contract.js'
import { cardClick, personalText } from '../../../test/fixtures/msteams-activities.js'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// The seam is faked here: the plugin's verify/handle contract has its own suite, this one pins the HTTP answers.
function makeApp(
  handleInbound?: RelayInboundSeam['handleInbound'],
  deadlines?: { admissionMs?: number; invokeMs?: number }
): FastifyInstance {
  const app = Fastify()
  const seam = handleInbound ? { handleInbound } : undefined
  registerMsTeamsHttpIngress(app, { manager: () => seam, log }, deadlines)
  return app
}

const answering =
  (handled: HandledDelivery | undefined): RelayInboundSeam['handleInbound'] =>
  async () =>
    handled

function post(app: FastifyInstance, payload: string) {
  return app.inject({
    method: 'POST',
    url: MSTEAMS_MESSAGES_PATH,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer synthetic' },
    payload
  })
}

describe('Microsoft Teams HTTP ingress route', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('answers 400 for a body that is not an activity', async () => {
    const handleInbound = vi.fn(answering({}))
    app = makeApp(handleInbound)
    for (const payload of ['not json', '[]', '{}', 'null', '{"type":""}', '{"type":1}']) {
      expect((await post(app, payload)).statusCode, payload).toBe(400)
    }
    expect(handleInbound).not.toHaveBeenCalled()
  })

  it('answers 401 when no assigned bot owns the activity, and before the manager exists', async () => {
    app = makeApp(answering(undefined))
    expect((await post(app, JSON.stringify(personalText))).statusCode).toBe(401)
    expect((await post(app, JSON.stringify(cardClick))).statusCode).toBe(401)
    await app.close()
    app = makeApp()
    expect((await post(app, JSON.stringify(personalText))).statusCode).toBe(401)
  })

  it('answers 200 with an empty body for an admitted, gated, or admission-less activity', async () => {
    for (const handled of [
      { admission: { disposition: 'admitted' as const } },
      { admission: { disposition: 'rejected' as const, reason: 'muted' as const } },
      {}
    ]) {
      app = makeApp(answering(handled))
      const response = await post(app, JSON.stringify(personalText))
      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('')
      await app.close()
      app = undefined
    }
  })

  it('sends a click’s note on the 200 body', async () => {
    const handleInbound = vi.fn(answering({ syncResponse: msTeamsInvokeNote('Answer received.') }))
    app = makeApp(handleInbound)
    const response = await post(app, JSON.stringify(cardClick))
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/application\/json/)
    expect(response.json()).toEqual({
      statusCode: 200,
      type: 'application/vnd.microsoft.activity.message',
      value: 'Answer received.'
    })
    expect(handleInbound).toHaveBeenCalledWith('msteams', expect.any(Buffer), cardClick, expect.any(Object))
  })

  it('answers 503 for a retry verdict, so Teams redelivers once', async () => {
    app = makeApp(answering({ admission: { disposition: 'retry', reason: 'draining' } }))
    expect((await post(app, JSON.stringify(personalText))).statusCode).toBe(503)
  })

  it('answers 503 when handling a message throws — an unknown outcome is never a success', async () => {
    app = makeApp(async () => {
      throw new Error('relay hiccup')
    })
    expect((await post(app, JSON.stringify(personalText))).statusCode).toBe(503)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed'))
  })

  it('answers 503 when a message’s admission deadline expires', async () => {
    // The shipped deadlines are pinned here; the expiry itself runs on a short one so no clock is faked.
    expect(MSTEAMS_ADMISSION_DEADLINE_MS).toBe(10_000)
    app = makeApp(() => new Promise(() => {}), { admissionMs: 50 })
    expect((await post(app, JSON.stringify(personalText))).statusCode).toBe(503)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('expired'))
  })

  it('still answers a click 200 with a note inside the client’s window when handling expires or throws', async () => {
    expect(MSTEAMS_INVOKE_DEADLINE_MS).toBeLessThan(5_000)
    const unavailable = msTeamsInvokeNote(MSTEAMS_INVOKE_UNAVAILABLE)
    app = makeApp(() => new Promise(() => {}), { invokeMs: 50 })
    const expired = await post(app, JSON.stringify(cardClick))
    expect(expired.statusCode).toBe(200)
    expect(expired.json()).toEqual(unavailable)
    await app.close()
    app = makeApp(async () => {
      throw new Error('relay hiccup')
    })
    const failed = await post(app, JSON.stringify(cardClick))
    expect(failed.statusCode).toBe(200)
    expect(failed.json()).toEqual(unavailable)
  })
})
