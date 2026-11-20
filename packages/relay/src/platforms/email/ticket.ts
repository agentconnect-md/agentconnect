// Reply tickets (email-integration.md §6.2): the thread and the people an admitted mail named, signed so any relay can check a later send without a table.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { EMAIL_TICKET_MAX } from '@agentconnect.md/protocol'

const VERSION = 'e1'

/** What a ticket vouches for: the thread key of the mail it was minted with, and when. */
export interface EmailTicketed {
  threadKey: string
  issuedAtMs: number
}

/** The people a mail named, as the MAC covers them: each address once, sorted. */
export function emailTicketAudience(addresses: readonly string[]): string[] {
  return [...new Set(addresses)].sort()
}

function mac(key: Buffer, botId: string, ticketed: EmailTicketed, audience: readonly string[]): Buffer {
  return createHmac('sha256', key)
    .update(JSON.stringify([VERSION, botId, ticketed.threadKey, ticketed.issuedAtMs, emailTicketAudience(audience)]))
    .digest()
}

/** `e1.<base64url thread key>.<issue time, epoch milliseconds>.<base64url MAC>`; undefined for one too long to carry. */
export function mintEmailTicket(
  key: Buffer,
  botId: string,
  ticketed: EmailTicketed,
  audience: readonly string[]
): string | undefined {
  if (!ticketed.threadKey || !Number.isSafeInteger(ticketed.issuedAtMs) || ticketed.issuedAtMs < 0) return undefined
  const thread = Buffer.from(ticketed.threadKey, 'utf8').toString('base64url')
  const ticket = `${VERSION}.${thread}.${ticketed.issuedAtMs}.${mac(key, botId, ticketed, audience).toString('base64url')}`
  return ticket.length <= EMAIL_TICKET_MAX ? ticket : undefined
}

/** The thread a ticket vouches for, when its MAC holds for this bot and the audience the caller restates; undefined otherwise. */
export function openEmailTicket(
  key: Buffer,
  botId: string,
  ticket: string,
  audience: readonly string[]
): EmailTicketed | undefined {
  const [version, thread, issued, tag, ...rest] = ticket.split('.')
  if (version !== VERSION || !thread || !issued || !tag || rest.length > 0 || !/^[0-9]{1,15}$/.test(issued))
    return undefined
  const ticketed = { threadKey: Buffer.from(thread, 'base64url').toString('utf8'), issuedAtMs: Number(issued) }
  if (!ticketed.threadKey) return undefined
  const expected = mac(key, botId, ticketed, audience)
  const given = Buffer.from(tag, 'base64url')
  return given.length === expected.length && timingSafeEqual(given, expected) ? ticketed : undefined
}
