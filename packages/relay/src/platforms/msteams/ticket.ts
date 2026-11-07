// Conversation tickets (teams-integration.md §8.5): what a verified inbound activity proves, signed so any relay can check it later without a table.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { MSTEAMS_TICKET_MAX } from '@agentconnect.md/protocol'

const VERSION = 't1'

/** The Bot Connector hosts a token is ever sent to: the public cloud's and the government clouds' documented service URL hosts. */
export const MSTEAMS_SERVICE_HOSTS: ReadonlySet<string> = new Set([
  'smba.trafficmanager.net',
  'smba.infra.gcc.teams.microsoft.com',
  'smba.infra.gov.teams.microsoft.us',
  'smba.infra.dod.teams.microsoft.us'
])

/** A service URL the relay may send a token to: https on the default port, an allowlisted host, and nothing but a path. */
export function allowedMsTeamsServiceUrl(serviceUrl: string): boolean {
  let url: URL
  try {
    url = new URL(serviceUrl)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    MSTEAMS_SERVICE_HOSTS.has(url.hostname.toLowerCase())
  )
}

/** A raw conversation ID's conversation: a channel thread's `;messageid=` suffix is dropped, so one ticket covers every thread. */
export function msTeamsTicketConversation(conversationId: string): string {
  return conversationId.split(';')[0]!
}

/** What a ticket binds besides its own content: the bot row and the tenant its assignment serves. */
export interface MsTeamsTicketBinding {
  botId: string
  tenantId: string
}

/** What a ticket vouches for: the conversation and the service URL its activity arrived from. */
export interface MsTeamsTicketed {
  conversationId: string
  serviceUrl: string
}

function mac(key: Buffer, binding: MsTeamsTicketBinding, ticketed: MsTeamsTicketed): Buffer {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        VERSION,
        binding.botId,
        binding.tenantId.toLowerCase(),
        ticketed.conversationId,
        ticketed.serviceUrl
      ])
    )
    .digest()
}

/** `t1.<base64url [conversationId, serviceUrl]>.<base64url MAC>`; undefined for a service URL no token may go to, or one too long to carry. */
export function mintMsTeamsTicket(
  key: Buffer,
  binding: MsTeamsTicketBinding,
  raw: { conversationId: string; serviceUrl: string }
): string | undefined {
  if (!allowedMsTeamsServiceUrl(raw.serviceUrl)) return undefined
  const ticketed = { conversationId: msTeamsTicketConversation(raw.conversationId), serviceUrl: raw.serviceUrl }
  const payload = Buffer.from(JSON.stringify([ticketed.conversationId, ticketed.serviceUrl])).toString('base64url')
  const ticket = `${VERSION}.${payload}.${mac(key, binding, ticketed).toString('base64url')}`
  return ticket.length <= MSTEAMS_TICKET_MAX ? ticket : undefined
}

/** The conversation and service URL a ticket vouches for, when its MAC holds for this bot and tenant; undefined otherwise. */
export function openMsTeamsTicket(
  key: Buffer,
  binding: MsTeamsTicketBinding,
  ticket: string
): MsTeamsTicketed | undefined {
  const [version, payload, tag, ...rest] = ticket.split('.')
  if (version !== VERSION || !payload || !tag || rest.length > 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  const [conversationId, serviceUrl] = parsed as unknown[]
  if (typeof conversationId !== 'string' || typeof serviceUrl !== 'string' || !conversationId) return undefined
  const ticketed = { conversationId, serviceUrl }
  const expected = mac(key, binding, ticketed)
  const given = Buffer.from(tag, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  return allowedMsTeamsServiceUrl(serviceUrl) ? ticketed : undefined
}
