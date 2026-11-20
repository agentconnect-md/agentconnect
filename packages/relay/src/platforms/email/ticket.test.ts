import { describe, expect, it } from 'vitest'
import { EMAIL_TICKET_MAX, WireEmailTicket } from '@agentconnect.md/protocol'
import { emailTicketAudience, mintEmailTicket, openEmailTicket } from './ticket.js'

const KEY = Buffer.alloc(32, 1)
const BOT = '11111111-1111-4111-8111-111111111111'
const THREAD = { threadKey: 'root@corp.example.test', issuedAtMs: 1_800_000_000_000 }
const AUDIENCE = ['bob@corp.example.test', 'alice@corp.example.test']

describe('email reply tickets', () => {
  it('mints a ticket the wire schema takes and opens it for the same bot and people', () => {
    const ticket = mintEmailTicket(KEY, BOT, THREAD, AUDIENCE)!
    expect(WireEmailTicket.safeParse(ticket).success).toBe(true)
    expect(openEmailTicket(KEY, BOT, ticket, AUDIENCE)).toEqual(THREAD)
    // The people are a set: order and repeats do not matter.
    expect(openEmailTicket(KEY, BOT, ticket, [...AUDIENCE].reverse().concat(AUDIENCE[0]!))).toEqual(THREAD)
    expect(emailTicketAudience(['b@x.example.test', 'a@x.example.test', 'b@x.example.test'])).toEqual([
      'a@x.example.test',
      'b@x.example.test'
    ])
  })

  it('refuses another bot, another key, and any change to the people', () => {
    const ticket = mintEmailTicket(KEY, BOT, THREAD, AUDIENCE)!
    expect(openEmailTicket(KEY, '22222222-2222-4222-8222-222222222222', ticket, AUDIENCE)).toBeUndefined()
    expect(openEmailTicket(Buffer.alloc(32, 2), BOT, ticket, AUDIENCE)).toBeUndefined()
    expect(openEmailTicket(KEY, BOT, ticket, [...AUDIENCE, 'eve@other.example.test'])).toBeUndefined()
    expect(openEmailTicket(KEY, BOT, ticket, [AUDIENCE[0]!])).toBeUndefined()
    expect(openEmailTicket(KEY, BOT, ticket, [])).toBeUndefined()
  })

  it('refuses a ticket whose thread, issue time or shape was changed', () => {
    const ticket = mintEmailTicket(KEY, BOT, THREAD, AUDIENCE)!
    const [version, thread, issued, tag] = ticket.split('.') as [string, string, string, string]
    const other = Buffer.from('other@corp.example.test').toString('base64url')
    for (const forged of [
      `${version}.${other}.${issued}.${tag}`,
      `${version}.${thread}.${Number(issued) + 1}.${tag}`,
      `e2.${thread}.${issued}.${tag}`,
      `${version}.${thread}.${issued}`,
      `${ticket}.extra`,
      `${version}.${thread}.${issued}.${tag.slice(0, -2)}`,
      `${version}..${issued}.${tag}`,
      ''
    ])
      expect(openEmailTicket(KEY, BOT, forged, AUDIENCE), forged).toBeUndefined()
  })

  it('mints nothing for a thread key too long to carry, or for no thread at all', () => {
    expect(
      mintEmailTicket(KEY, BOT, { threadKey: 'x'.repeat(EMAIL_TICKET_MAX), issuedAtMs: 1 }, AUDIENCE)
    ).toBeUndefined()
    expect(mintEmailTicket(KEY, BOT, { threadKey: '', issuedAtMs: 1 }, AUDIENCE)).toBeUndefined()
    expect(mintEmailTicket(KEY, BOT, { threadKey: 'a@b.example.test', issuedAtMs: -1 }, AUDIENCE)).toBeUndefined()
  })
})
