import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { SHARED_AGENT_SELECT_ACTION_ID } from '@agentconnect.md/protocol'
import { registerSlackHttpIngress, type SlackIngestResolver } from './http-ingress.js'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

interface Harness {
  app: FastifyInstance
  events: unknown[]
  interactions: unknown[]
  /** the seam attributes a POST to the stub only for this signature. */
  goodSignature: string
  inboundCalls: Array<{ platformId: string; hints: { apiAppId?: string; teamId?: string } }>
}

/** A stub of the §8 seam: verification-by-signature stands in for the HMAC
 *  demux; handling mirrors the slack plugin's split (events fire async and
 *  return no sync body; interactions return their result as the syncResponse;
 *  event_id dedup runs inside, on a set-backed stand-in for the core table). */
function makeHarness(): Harness {
  const h: Harness = {
    app: Fastify(),
    events: [],
    interactions: [],
    goodSignature: 'good-sig',
    inboundCalls: []
  }
  const seenEventIds = new Set<string>()
  const resolver: SlackIngestResolver = {
    handleInbound: async (platformId, _rawBody, body, headers) => {
      const b = body as {
        type?: string
        api_app_id?: string
        team_id?: string
        team?: { id?: string }
        event_id?: string
        event?: unknown
        action_id?: string
      }
      h.inboundCalls.push({
        platformId,
        hints: {
          ...(b.api_app_id ? { apiAppId: b.api_app_id } : {}),
          ...((b.team_id ?? b.team?.id) ? { teamId: b.team_id ?? b.team?.id } : {})
        }
      })
      if (headers['x-slack-signature'] !== h.goodSignature) return undefined
      if (b.type === 'event_callback') {
        // Plugin-minted composite dedup identity, core-owned table.
        const key = b.event_id ? `${b.api_app_id ?? ''}\0${b.team_id ?? ''}\0${b.event_id}` : undefined
        if (key && seenEventIds.has(key)) return {}
        if (key) seenEventIds.add(key)
        h.events.push(b.event)
        return {}
      }
      h.interactions.push(b)
      if (b.type === 'block_suggestion' && b.action_id === SHARED_AGENT_SELECT_ACTION_ID) {
        return { syncResponse: { options: [{ text: { type: 'plain_text', text: 'Deploy' }, value: 'a1' }] } }
      }
      return { syncResponse: '' }
    }
  }
  registerSlackHttpIngress(h.app, { manager: () => resolver, log })
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
    expect(h.inboundCalls).toHaveLength(0) // never demuxed
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
    expect(h.inboundCalls[0]).toEqual({ platformId: 'slack', hints: { apiAppId: 'A1', teamId: 'T9' } })
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

  it('does not dedup the same event_id across separately mentioned Slack apps', async () => {
    const event = { type: 'message', channel: 'C1', ts: '1.1', user: 'U1', text: 'hi both apps' }
    expect(
      (
        await postEvent({
          type: 'event_callback',
          api_app_id: 'A1',
          team_id: 'T9',
          event_id: 'Ev-shared',
          event
        })
      ).statusCode
    ).toBe(200)
    expect(
      (
        await postEvent({
          type: 'event_callback',
          api_app_id: 'A2',
          team_id: 'T9',
          event_id: 'Ev-shared',
          event
        })
      ).statusCode
    ).toBe(200)
    await flush()
    expect(h.events).toHaveLength(2)
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
