// The deployment app's attachment download (google-chat-integration.md §5): a fenced ticket, then Google's bytes streamed over HTTP and bounded.
import { generateKeyPairSync } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type {
  RcGoogleChatDeploymentApp,
  RdPlatformReply,
  WireGoogleChatMediaTicketResult
} from '@agentconnect.md/protocol'
import { GOOGLE_CHAT_MEDIA_TICKET_TTL_MS, GOOGLE_TOKEN_ENDPOINT, GoogleChatRelayEgress } from './egress.js'
import { registerGoogleChatMediaRoute } from './media.js'

const PROJECT_NUMBER = '100000000000'
const BOT_ID = '11111111-1111-4111-8111-111111111111'
const OWN_CUSTOMER = 'customers/C0000000001'
const SPACE = 'spaces/OWN_SPACE'
const OTHER_SPACE = 'spaces/OTHER_SPACE'
const ATTACHMENT = `${SPACE}/messages/M1/attachments/A1`
const RELAY = 'https://relay.example.test'
const ROW = { botId: BOT_ID, tenantIds: [OWN_CUSTOMER] }

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyJson = (id: string) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: id,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'chat-app@example.test'
  })
const APP: RcGoogleChatDeploymentApp = { projectNumber: PROJECT_NUMBER, serviceAccountKey: keyJson('kid-1') }

// A fake Google holding one uploaded attachment in the row's own Space and one in a foreign Space.
function google(bytes = Buffer.from('attachment bytes')) {
  const paths: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.href === GOOGLE_TOKEN_ENDPOINT) return Response.json({ access_token: 'token-1', expires_in: 3600 })
    paths.push(`${url.pathname}${url.search}`)
    if (url.pathname === `/v1/${SPACE}`)
      return Response.json({ name: SPACE, spaceType: 'SPACE', customer: OWN_CUSTOMER })
    if (url.pathname === `/v1/${OTHER_SPACE}`)
      return Response.json({ name: OTHER_SPACE, spaceType: 'SPACE', customer: 'customers/C0000000002' })
    if (url.pathname === `/v1/${ATTACHMENT}`)
      return Response.json({
        name: ATTACHMENT,
        source: 'UPLOADED_CONTENT',
        attachmentDataRef: { resourceName: 'RES-1' }
      })
    if (url.pathname === '/v1/media/RES-1')
      return new Response(bytes, { headers: { 'content-type': 'application/pdf' } })
    return new Response(null, { status: 404 })
  }) as typeof fetch
  return { fetchImpl, paths }
}

const ticketOf = (reply: RdPlatformReply) => {
  expect(reply.outcome).toBe('ok')
  return reply.payload as WireGoogleChatMediaTicketResult
}

async function served(egress: GoogleChatRelayEgress | undefined, url: string) {
  const app = Fastify()
  registerGoogleChatMediaRoute(app, {
    egress: () => egress,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
  const res = await app.inject({ method: 'GET', url: new URL(url, RELAY).pathname })
  await app.close()
  return res
}

describe('the deployment app’s attachment download', () => {
  it('signs a ticket for the row’s own attachment and streams Google’s bytes for it', async () => {
    const { fetchImpl, paths } = google()
    const egress = new GoogleChatRelayEgress(APP, fetchImpl)
    const ticket = ticketOf(
      await egress.mediaTicket(ROW, { op: 'media-ticket', attachment: ATTACHMENT, maxBytes: 1024 }, RELAY)
    )
    expect(ticket.status).toBe(200)
    expect(ticket.url?.startsWith(`${RELAY}/googlechat/media/`)).toBe(true)
    // Google's resource name never reaches the daemon in the clear.
    expect(ticket.url).not.toContain('RES-1')
    const res = await served(egress, ticket.url!)
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.toString()).toBe('attachment bytes')
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(paths).toContain('/v1/media/RES-1?alt=media')
  })

  it('refuses a foreign tenant’s attachment before reading it', async () => {
    const { fetchImpl, paths } = google()
    const egress = new GoogleChatRelayEgress(APP, fetchImpl)
    const foreign = `${OTHER_SPACE}/messages/M1/attachments/A1`
    const reply = await egress.mediaTicket(ROW, { op: 'media-ticket', attachment: foreign, maxBytes: 1024 }, RELAY)
    expect(reply).toMatchObject({ outcome: 'refused', reason: 'tenant_refused' })
    expect(paths.some((path) => path.includes('/attachments/'))).toBe(false)
  })

  it('answers Google’s refusal of the attachment and needs a public origin to name a URL', async () => {
    const { fetchImpl } = google()
    const egress = new GoogleChatRelayEgress(APP, fetchImpl)
    const gone = `${SPACE}/messages/M1/attachments/GONE`
    expect(
      ticketOf(await egress.mediaTicket(ROW, { op: 'media-ticket', attachment: gone, maxBytes: 1 }, RELAY))
    ).toEqual({
      status: 404
    })
    expect(
      await egress.mediaTicket(ROW, { op: 'media-ticket', attachment: ATTACHMENT, maxBytes: 1 }, undefined)
    ).toMatchObject({
      outcome: 'refused',
      reason: 'no_public_url'
    })
  })

  it('refuses a forged, expired, or rotated-key ticket and anything over its bound', async () => {
    let now = Date.parse('2026-11-22T00:00:00.000Z')
    const { fetchImpl } = google(Buffer.alloc(64))
    const egress = new GoogleChatRelayEgress(APP, fetchImpl, { now: () => now })
    const mint = async (maxBytes: number) =>
      ticketOf(await egress.mediaTicket(ROW, { op: 'media-ticket', attachment: ATTACHMENT, maxBytes }, RELAY)).url!
    const small = await mint(16)
    expect((await served(egress, small)).statusCode).toBe(500)
    const url = await mint(1024)
    const [payload, mac] = url.slice(url.lastIndexOf('/') + 1).split('.')
    expect((await served(egress, `/googlechat/media/${payload}.${mac!.slice(1)}x`)).statusCode).toBe(404)
    expect((await served(undefined, url)).statusCode).toBe(404)
    now += GOOGLE_CHAT_MEDIA_TICKET_TTL_MS + 1
    expect((await served(egress, url)).statusCode).toBe(404)
    now -= GOOGLE_CHAT_MEDIA_TICKET_TTL_MS + 1
    egress.update({ ...APP, serviceAccountKey: keyJson('kid-2') })
    expect((await served(egress, url)).statusCode).toBe(404)
  })
})
