import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { RcEmailDeployment, RdPlatformReply } from '@agentconnect.md/protocol'
import { registerEmailSendRoute } from './send-route.js'

const CONFIG = { mailDomain: 'mail.example.test' } as RcEmailDeployment

function app(config: RcEmailDeployment | undefined, answer: RdPlatformReply | undefined) {
  const redeemSend = vi.fn(async () => answer)
  const server = Fastify()
  registerEmailSendRoute(server, { config: () => config, egress: { redeemSend } })
  return { server, redeemSend }
}

describe('POST /email/send/<ticket>', () => {
  it('redeems the ticket with the posted mail and answers the reply a frame would carry', async () => {
    const { server, redeemSend } = app(CONFIG, { outcome: 'ok', payload: { status: 200 } })
    const res = await server.inject({ method: 'POST', url: '/email/send/abc.def', payload: { op: 'start' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ outcome: 'ok', payload: { status: 200 } })
    expect(redeemSend).toHaveBeenCalledWith(CONFIG, 'abc.def', { op: 'start' })
  })

  it('answers 404 alike for a ticket that does not redeem and a relay that serves no mail', async () => {
    expect(
      (await app(CONFIG, undefined).server.inject({ method: 'POST', url: '/email/send/x', payload: {} })).statusCode
    ).toBe(404)
    const bare = app(undefined, { outcome: 'ok' })
    expect((await bare.server.inject({ method: 'POST', url: '/email/send/x', payload: {} })).statusCode).toBe(404)
    expect(bare.redeemSend).not.toHaveBeenCalled()
  })
})
