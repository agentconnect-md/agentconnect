import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WireEmailCall } from '@agentconnect.md/protocol'
import { EMAIL_SENDS_PER_BOT_PER_DAY } from './counters.js'
import { EmailRelayEgress, emailSendRequest, type EmailSender } from './egress.js'
import { mintEmailTicket } from './ticket.js'
import { AGENT_ADDRESS, COLLEAGUE, EMAIL_CONFIG, MEMBER, NOW } from '../../../test/fixtures/email-messages.js'

const BOT = '11111111-1111-4111-8111-111111111111'
const SENDER: EmailSender = { botId: BOT, address: AGENT_ADDRESS, organization: 'org-a' }
const KEY = Buffer.from(EMAIL_CONFIG.ticketKey, 'base64url')
const AUDIENCE = [MEMBER, COLLEAGUE]
const ticketFor = (botId = BOT, audience = AUDIENCE) =>
  mintEmailTicket(KEY, botId, { threadKey: 'm1@corp.example.test', issuedAtMs: NOW }, audience)!

const call = (over: Partial<WireEmailCall> = {}): WireEmailCall => ({
  op: 'send',
  ticket: ticketFor(),
  audience: AUDIENCE,
  to: [MEMBER],
  cc: [COLLEAGUE],
  fromName: 'Helper',
  subject: 'Re: Quarterly numbers',
  inReplyTo: 'm1@corp.example.test',
  references: ['m0@corp.example.test', 'm1@corp.example.test'],
  text: 'Here is the summary.',
  html: '<p>Here is the summary.</p>',
  ...over
})

interface Received {
  method: string
  url: string
  authorization: string | undefined
  body: Record<string, unknown>
}

type Answer = (req: IncomingMessage, res: ServerResponse, n: number) => void

const sent = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const delivered: Answer = (_req, res) =>
  sent(res, 200, { success: true, errors: [], messages: [], result: { delivered: [MEMBER], queued: [] } })

// The provider, faked over HTTP: the egress posts to a local server and never to the real API.
describe('email relay egress', () => {
  let server: Server
  let base: string
  let received: Received[]
  let answer: Answer

  beforeEach(async () => {
    received = []
    answer = delivered
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        })
        answer(req, res, received.length)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const egress = (budgetMs?: number) => new EmailRelayEgress(fetch, base, () => NOW, budgetMs)

  it("sends as the assignment's address with the deployment's token, the threading headers and the automatic-reply mark", async () => {
    const reply = await egress().send(EMAIL_CONFIG, SENDER, call())
    expect(reply).toEqual({
      outcome: 'ok',
      payload: {
        status: 200,
        body: { success: true, errors: [], messages: [], result: { delivered: [MEMBER], queued: [] } }
      }
    })
    expect(received).toEqual([
      {
        method: 'POST',
        url: `/client/v4/accounts/${EMAIL_CONFIG.accountId}/email/sending/send`,
        authorization: `Bearer ${EMAIL_CONFIG.apiToken}`,
        body: {
          from: { address: AGENT_ADDRESS, name: 'Helper' },
          to: [MEMBER],
          cc: [COLLEAGUE],
          subject: 'Re: Quarterly numbers',
          text: 'Here is the summary.',
          html: '<p>Here is the summary.</p>',
          headers: {
            'In-Reply-To': '<m1@corp.example.test>',
            References: '<m0@corp.example.test> <m1@corp.example.test>',
            'Auto-Submitted': 'auto-replied'
          }
        }
      }
    ])
  })

  it('builds a request with no display name or Cc when none is given, and keeps References inside one header value', () => {
    const plain = emailSendRequest(SENDER, call({ fromName: undefined, cc: [], references: [] }))
    expect(plain).toMatchObject({ from: { address: AGENT_ADDRESS }, to: [MEMBER] })
    expect(plain).not.toHaveProperty('cc')
    expect((plain.headers as Record<string, string>).References).toBe('<m1@corp.example.test>')
    // A recipient named in both fields is sent the mail once.
    expect(emailSendRequest(SENDER, call({ to: [MEMBER, MEMBER], cc: [MEMBER, COLLEAGUE] }))).toMatchObject({
      to: [MEMBER],
      cc: [COLLEAGUE]
    })
    const long = Array.from({ length: 50 }, (_, index) => `${'r'.repeat(90)}${index}@corp.example.test`)
    const header = (emailSendRequest(SENDER, call({ references: long })).headers as Record<string, string>).References!
    expect(Buffer.byteLength(header)).toBeLessThanOrEqual(2_048)
    // The newest IDs are the ones kept.
    expect(header.endsWith(`<${long.at(-1)}>`)).toBe(true)
    expect(header).not.toContain(`<${long[0]}>`)
  })

  it('refuses a ticket of another bot, a restated audience the ticket was not minted over, and a recipient outside it, calling nobody', async () => {
    const e = egress()
    expect(
      await e.send(EMAIL_CONFIG, SENDER, call({ ticket: ticketFor('22222222-2222-4222-8222-222222222222') }))
    ).toEqual({
      outcome: 'refused',
      reason: 'ticket'
    })
    expect(await e.send(EMAIL_CONFIG, SENDER, call({ audience: [...AUDIENCE, 'eve@other.example.test'] }))).toEqual({
      outcome: 'refused',
      reason: 'ticket'
    })
    expect(await e.send(EMAIL_CONFIG, SENDER, call({ to: ['eve@other.example.test'] }))).toEqual({
      outcome: 'refused',
      reason: 'recipient'
    })
    expect(await e.send(EMAIL_CONFIG, SENDER, call({ cc: ['eve@other.example.test'] }))).toEqual({
      outcome: 'refused',
      reason: 'recipient'
    })
    // A key another deployment signs with opens nothing here.
    const otherKey = { ...EMAIL_CONFIG, ticketKey: Buffer.alloc(32, 9).toString('base64url') }
    expect(await e.send(otherKey, SENDER, call())).toEqual({ outcome: 'refused', reason: 'ticket' })
    expect(received).toHaveLength(0)
  })

  it('refuses a bot past its daily budget without calling the provider', async () => {
    const e = egress()
    for (let i = 0; i < EMAIL_SENDS_PER_BOT_PER_DAY; i += 1) await e.send(EMAIL_CONFIG, SENDER, call())
    expect(received).toHaveLength(EMAIL_SENDS_PER_BOT_PER_DAY)
    expect(await e.send(EMAIL_CONFIG, SENDER, call())).toEqual({ outcome: 'refused', reason: 'budget_bot' })
    expect(received).toHaveLength(EMAIL_SENDS_PER_BOT_PER_DAY)
  })

  it("refuses past the operator's deployment figure, and gives the place back when the provider refused the send", async () => {
    const limited = { ...EMAIL_CONFIG, dailySendLimit: 1 }
    const e = egress()
    answer = (_req, res) =>
      sent(res, 400, { success: false, errors: [{ code: 10001, message: 'recipient suppressed' }] })
    // The provider's own refusal is the answer the daemon gets, and it spends nothing.
    expect(await e.send(limited, SENDER, call())).toEqual({
      outcome: 'ok',
      payload: { status: 400, body: { success: false, errors: [{ code: 10001, message: 'recipient suppressed' }] } }
    })
    answer = delivered
    expect(await e.send(limited, SENDER, call())).toMatchObject({ outcome: 'ok', payload: { status: 200 } })
    expect(await e.send(limited, { ...SENDER, botId: BOT, organization: 'org-b' }, call())).toEqual({
      outcome: 'refused',
      reason: 'budget_deployment'
    })
    expect(received).toHaveLength(2)
  })

  it('tries a rate-limited send once more after the wait the provider names', async () => {
    answer = (req, res, n) =>
      n === 1 ? sent(res, 429, { success: false }, { 'retry-after': '0' }) : delivered(req, res, n)
    expect(await egress().send(EMAIL_CONFIG, SENDER, call())).toMatchObject({ outcome: 'ok', payload: { status: 200 } })
    expect(received).toHaveLength(2)
  })

  it('answers a second rate limit, or a wait longer than the budget, as it stands', async () => {
    answer = (_req, res) => sent(res, 429, { success: false }, { 'retry-after': '0' })
    expect(await egress().send(EMAIL_CONFIG, SENDER, call())).toEqual({
      outcome: 'ok',
      payload: { status: 429, body: { success: false }, retryAfterMs: 0 }
    })
    expect(received).toHaveLength(2)
    received.length = 0
    answer = (_req, res) => sent(res, 429, { success: false }, { 'retry-after': '60' })
    expect(await egress().send(EMAIL_CONFIG, SENDER, call())).toEqual({
      outcome: 'ok',
      payload: { status: 429, body: { success: false }, retryAfterMs: 60_000 }
    })
    expect(received).toHaveLength(1)
  })

  it('never repeats a send the provider failed or did not answer, since it may have gone out', async () => {
    answer = (_req, res) => sent(res, 500, { success: false })
    expect(await egress().send(EMAIL_CONFIG, SENDER, call())).toMatchObject({ outcome: 'ok', payload: { status: 500 } })
    expect(received).toHaveLength(1)
    // No answer inside the budget reads as a gateway timeout, and keeps its place in the budgets.
    answer = () => {}
    const limited = { ...EMAIL_CONFIG, dailySendLimit: 1 }
    const slow = egress(150)
    expect(await slow.send(limited, SENDER, call())).toEqual({ outcome: 'ok', payload: { status: 504 } })
    expect(received).toHaveLength(2)
    expect(await slow.send(limited, SENDER, call())).toEqual({ outcome: 'refused', reason: 'budget_deployment' })
  })
})
