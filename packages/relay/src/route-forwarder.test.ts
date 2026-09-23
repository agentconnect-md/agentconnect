import { describe, expect, it, vi } from 'vitest'
import { RD_ACK_NOT_HOLDER, type RdAck, type RdRoute } from '@agentconnect.md/protocol'
import { createRouteForwarder, routeAckFrom } from './route-forwarder.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

// The rd/route leg's own contract; the ingress-manager suite drives it through real arbitration state.

const HOST = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const route = {
  deliveryId: 'bot:m1#a',
  botId: HOST,
  sessionKey: 'C1/C1',
  toAgentId: AGENT,
  frozenDaemonId: TARGET,
  payload: { msgId: 'm1', channel: 'C1', sender: { id: 'U1', isBot: false } },
  selection: { decisionId: 'd-1' }
} as unknown as RdRoute

function forwarder(send: () => Promise<RdAck>, timeoutMs = 5_000) {
  const sendWithRendezvous = vi.fn(send)
  const forward = createRouteForwarder({
    ingress: {
      hostFor: () => HOST,
      routed: () => ({ decisionId: 'd-1', evaluationDaemonId: HOST }),
      targetFor: () => ({ agentId: AGENT, daemonId: TARGET, integrationId: 'i' })
    },
    daemons: () => ({ supports: () => true }) as unknown as RelayDaemonConnection,
    sendWithRendezvous,
    log: silentLog,
    timeoutMs
  })
  return { forward, sendWithRendezvous }
}

describe('createRouteForwarder', () => {
  it('maps a slow target to a retry and never caches it', async () => {
    vi.useFakeTimers()
    try {
      const { forward, sendWithRendezvous } = forwarder(() => new Promise<RdAck>(() => undefined), 50)
      const pending = forward(HOST, route)
      await vi.advanceTimersByTimeAsync(60)
      expect(await pending).toMatchObject({ disposition: 'retry', reason: 'offline' })
      const again = forward(HOST, route)
      await vi.advanceTimersByTimeAsync(60)
      await again
      expect(sendWithRendezvous).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps target acks: routed verdicts, duty and durability refusals, and an ack without a verdict', () => {
    const ack = (over: Partial<RdAck>): RdAck => ({ msgId: 'm', accepted: false, ...over })
    expect(routeAckFrom('d', TARGET, ack({ accepted: true, routeAdmission: 'admitted' })).disposition).toBe('admitted')
    expect(routeAckFrom('d', TARGET, ack({ reason: RD_ACK_NOT_HOLDER }))).toMatchObject({
      disposition: 'retry',
      reason: 'not_ready'
    })
    expect(routeAckFrom('d', TARGET, ack({ reason: 'durability' })).disposition).toBe('retry')
    expect(routeAckFrom('d', TARGET, ack({ reason: 'no_agent' }))).toMatchObject({
      disposition: 'rejected',
      reason: 'no_agent'
    })
    expect(routeAckFrom('d', TARGET, ack({ accepted: true }))).toMatchObject({ disposition: 'rejected' })
    expect(routeAckFrom('d', TARGET, ack({ routeAdmission: 'rejected', reason: 'weird' }))).toMatchObject({
      disposition: 'rejected',
      reason: 'rejected'
    })
  })
})
