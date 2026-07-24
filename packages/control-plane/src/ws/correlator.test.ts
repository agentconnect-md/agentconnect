import { describe, expect, it } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { systemClock } from '../domain/clock.js'
import { ProtocolError } from '../domain/errors.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { ReqRep } from './correlator.js'

describe('control-plane ReqRep', () => {
  it('rejects one pending request directly by correlation id', async () => {
    const correlator = new ReqRep(systemClock, 5_000)
    const request = buildEnvelope('auth', { apiKey: 'not-sent', agentVersion: 'test' })
    const pending = correlator.request(request, () => {})
    const err = new ProtocolError('BAD_PAYLOAD', 'invalid correlated reply', { retryable: false })
    const rejection = expect(pending).rejects.toBe(err)

    expect(correlator.reject('missing', err)).toBe(false)
    expect(correlator.reject(request.id, err)).toBe(true)
    await rejection
    expect(correlator.inflight()).toBe(0)
  })

  it('uses the protocol compatibility encoder for remote memory requests', async () => {
    const correlator = new ReqRep(systemClock, 5_000)
    const request = buildEnvelope(
      'memoryconnection/upsert',
      {
        connectionId: '77777777-7777-4777-8777-777777777777',
        revision: 1,
        transport: 'streamable-http',
        relayUrl: 'https://relay.example/memory/77777777-7777-4777-8777-777777777777',
        grantKey: 'daemon-private-grant',
        config: {},
        secretKeys: [],
        pin: { pluginId: 'ai.example.memory', profileMajor: 1, secretHeaders: [] }
      },
      { ext: { epoch: 1 } }
    )
    const sent: string[] = []
    const pending = correlator.request(request, (encoded) => sent.push(encoded))
    const err = new ProtocolError('INTERNAL', 'test cleanup')
    const rejection = expect(pending).rejects.toBe(err)

    const wire = JSON.parse(sent[0] ?? '{}') as { payload?: { transport?: unknown } }
    expect(wire.payload?.transport).toBeUndefined()
    expect(correlator.reject(request.id, err)).toBe(true)
    await rejection
  })

  it('honors a per-request timeout and retry budget for slow controls', async () => {
    const clock = new FakeClock()
    const correlator = new ReqRep(clock, 5_000)
    const request = buildEnvelope('auth', { apiKey: 'not-sent', agentVersion: 'test' })
    const sent: string[] = []
    const pending = correlator.request(request, (encoded) => sent.push(encoded), {
      ackTimeoutMs: 60_000,
      maxTries: 2
    })
    const rejection = expect(pending).rejects.toThrow('no ack after 2 tries')

    expect(sent).toHaveLength(1)
    clock.advance(59_999)
    expect(sent).toHaveLength(1)
    clock.advance(1)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe(sent[0])

    clock.advance(60_000)
    await rejection
    expect(correlator.inflight()).toBe(0)
  })
})
