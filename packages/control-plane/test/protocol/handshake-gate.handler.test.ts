// The gateway's handshake gate as a connection applies it: a slot covers only the CP's own auth and register work.
import { describe, it, expect } from 'vitest'
import { CloseCode } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { HandshakeGate } from '../../src/ws/handshake-gate.js'

const DAEMON = 'abababab-abab-4bab-8bab-abababababab'
const AGENT = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'
const MOVE_ID = '55555555-5555-4555-8555-555555555555'

function authPayload(token: string) {
  return { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }
}

function registerPayload(stagedAgents: Array<{ agentId: string; moveId?: string }> = []) {
  return {
    host: 'host-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents }
  }
}

describe('handshake gate — slots cover the CP work of auth and register only', () => {
  it('refuses auth with a retryable RATE_LIMITED and close 4429 while every slot is held', async () => {
    const handshakes = new HandshakeGate(1)
    const h = buildWsHarness(prisma, { handshakes })
    const token = await h.mintToken(DAEMON)
    const held = handshakes.tryAcquire()!

    const { stub } = h.connect()
    const authId = stub.inject('auth', authPayload(token))
    await stub.settled()
    const refusal = stub.lastSent('error')
    expect(refusal?.corr).toBe(authId)
    expect(refusal?.payload).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(stub.closed?.code).toBe(CloseCode.RATE_LIMITED)
    expect(stub.lastSent('auth/ok')).toBeUndefined()

    held()
    const retry = h.connect().stub
    retry.inject('auth', authPayload(token))
    await retry.expectFrame('auth/ok')
    await retry.settled()
    expect(handshakes.size).toBe(0)
  })

  it('makes a daemon past auth wait for a slot to register instead of refusing it', async () => {
    const handshakes = new HandshakeGate(1)
    const h = buildWsHarness(prisma, { handshakes })
    const token = await h.mintToken(DAEMON)
    const { stub } = h.connect()
    stub.inject('auth', authPayload(token))
    await stub.expectFrame('auth/ok')
    await stub.settled()

    const held = handshakes.tryAcquire()!
    stub.inject('register', registerPayload())
    expect(handshakes.waiting).toBe(1)
    expect(stub.lastSent('register/ok')).toBeUndefined()
    expect(stub.closed).toBeUndefined()

    held()
    await stub.expectFrame('register/ok')
    await stub.settled()
    expect(handshakes.size).toBe(0)
  })

  it('frees the register slot at READY, before the register tail runs', async () => {
    const handshakes = new HandshakeGate(1)
    const h = buildWsHarness(prisma, { handshakes })
    const token = await h.mintToken(DAEMON)
    const slotsHeldDuringTail: number[] = []
    h.deps.recoverStagedAgent = async () => {
      slotsHeldDuringTail.push(handshakes.size)
    }
    const { stub } = h.connect()
    stub.inject('auth', authPayload(token))
    await stub.expectFrame('auth/ok')
    await stub.settled()

    stub.inject('register', registerPayload([{ agentId: AGENT, moveId: MOVE_ID }]))
    await stub.expectFrame('register/ok')
    await stub.settled()
    expect(slotsHeldDuringTail).toEqual([0])
  })
})
