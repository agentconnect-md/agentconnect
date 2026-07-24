import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeClock } from '@agentconnect.md/connection'
import { SHARED_AGENT_SELECT_ACTION_ID } from '@agentconnect.md/protocol'
import { registerSlackHttpIngress, type SlackIngestHandlers, type SlackIngestResolver } from './slack-http-ingress.js'
import { SlackEventDedup } from './slack-event-dedup.js'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

interface Harness {
  app: FastifyInstance
  events: unknown[]
  interactions: unknown[]
  /** resolveVerified attributes a POST to the stub ingest only for this signature. */
  goodSignature: string
  resolveCalls: Array<{ apiAppId?: string; teamId?: string }>
}

/** A stub ingest whose `resolveVerified` stands in for the HMAC demux: it returns the
 *  handlers only when the request carried the "good" signature (verification passed). */
function makeHarness(): Harness {
  const h: Harness = {
    app: Fastify(),
    events: [],
    interactions: [],
    goodSignature: 'good-sig',
    resolveCalls: []
  }
  const ingest: SlackIngestHandlers = {
    handleEvent: async (event) => {
      h.events.push(event)
    },
    handleInteraction: async (body) => {
      h.interactions.push(body)
      if (body.type === 'block_suggestion' && body.action_id === SHARED_AGENT_SELECT_ACTION_ID) {
        return { options: [{ text: { type: 'plain_text', text: 'Deploy' }, value: 'a1' }] }
      }
      return ''
    }
  }
  const resolver: SlackIngestResolver = {
    resolveVerified: (args) => {
      h.resolveCalls.push({ apiAppId: args.apiAppId, teamId: args.teamId })
      return args.signature === h.goodSignature ? ingest : undefined
    }
  }
  registerSlackHttpIngress(h.app, {
    manager: () => resolver,
    dedup: new SlackEventDedup(new FakeClock()),
    log
  })
  return h
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('slack http ingress', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(async () => {
    await h.app.close()
  })

  const postEvent = (body: unknown, opts: { signature?: string } = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': opts.signature ?? h.goodSignature,
        'x-slack-request-timestamp': '1720000000'
      },
      payload: JSON.stringify(body)
    })

  const postInteraction = (payload: unknown, opts: { signature?: string } = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/slack/interactions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': opts.signature ?? h.goodSignature,
        'x-slack-request-timestamp': '1720000000'
      },
      payload: `payload=${encodeURIComponent(JSON.stringify(payload))}`
    })

  it('answers the url_verification challenge before any demux/verify', async () => {
    const res = await postEvent({ type: 'url_verification', token: 't', challenge: 'c-42' }, { signature: 'anything' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ challenge: 'c-42' })
    expect(h.resolveCalls).toHaveLength(0) // never demuxed
  })

  it('401s when no assigned bot verifies the signature', async () => {
    const res = await postEvent(
      { type: 'event_callback', api_app_id: 'A1', event_id: 'Ev1', event: { type: 'message' } },
      { signature: 'forged' }
    )
    expect(res.statusCode).toBe(401)
    expect(h.events).toHaveLength(0)
  })

  it('acks 200, forwards the event async, and passes the demux hints', async () => {
    const res = await postEvent({
      type: 'event_callback',
      api_app_id: 'A1',
      team_id: 'T9',
      event_id: 'Ev1',
      event: { type: 'message', channel: 'C1', ts: '1.1', user: 'U1', text: 'hi' }
    })
    expect(res.statusCode).toBe(200)
    await flush()
    expect(h.events).toHaveLength(1)
    expect(h.resolveCalls[0]).toEqual({ apiAppId: 'A1', teamId: 'T9' })
  })

  it('dedups a redelivered event_id (forwards once)', async () => {
    const envelope = {
      type: 'event_callback',
      api_app_id: 'A1',
      event_id: 'Ev-dup',
      event: { type: 'message', channel: 'C1', ts: '1.1', user: 'U1', text: 'hi' }
    }
    expect((await postEvent(envelope)).statusCode).toBe(200)
    expect((await postEvent(envelope)).statusCode).toBe(200) // Slack retry
    await flush()
    expect(h.events).toHaveLength(1)
  })

  it('extracts the urlencoded payload= and returns the block_suggestion options on the 200 body', async () => {
    const res = await postInteraction({
      type: 'block_suggestion',
      api_app_id: 'A1',
      action_id: SHARED_AGENT_SELECT_ACTION_ID,
      value: 'dep'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ options: [{ text: { type: 'plain_text', text: 'Deploy' }, value: 'a1' }] })
    expect(h.interactions).toHaveLength(1)
  })

  it('401s an interaction whose signature no bot verifies', async () => {
    const res = await postInteraction({ type: 'block_actions', api_app_id: 'A1' }, { signature: 'forged' })
    expect(res.statusCode).toBe(401)
    expect(h.interactions).toHaveLength(0)
  })
})
