import { describe, expect, it } from 'vitest'
import {
  RD_EMAIL_ATTACHMENTS_V1,
  type RdPlatformReply,
  type RdPlatformRequest,
  type WireEmailCall
} from '@agentconnect.md/protocol'
import { EmailConnection } from '../src/platforms/email/connection.js'
import { PlatformRelayUnsent, type PlatformRequestOptions } from '../src/platforms/platform-relay.js'

const AGENT = 'helper@mail.example.test'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const TAG = 'abcdefghijklmnopqrst'
const URL_BASE = 'https://relay.example.test/email/send/ticket-1'

const start = (over: Partial<Extract<WireEmailCall, { op: 'start' }>> = {}): WireEmailCall => ({
  op: 'start',
  tag: TAG,
  to: ['bob@corp.example.test'],
  cc: [],
  subject: 'Report',
  text: 'See attached.',
  html: '<p>See attached.</p>',
  attachments: [{ name: 'report.html', type: 'text/html', content: Buffer.from('<p>r</p>').toString('base64') }],
  ...over
})

function harness(opts: { grant?: RdPlatformReply | Error; post?: () => Response | Promise<Response> } = {}) {
  const requests: { req: RdPlatformRequest; opts: PlatformRequestOptions | undefined }[] = []
  const posts: { url: string; body: unknown }[] = []
  const conn = new EmailConnection({
    group: {
      key: AGENT,
      config: { address: AGENT, egress: 'relay', botId: BOT },
      integrations: [{ agentId: '00000000-0000-4000-8000-0000000000a1', integrationId: 'int-email' }]
    },
    relay: {
      request: async (req, o) => {
        requests.push({ req, opts: o })
        const grant = opts.grant ?? { outcome: 'ok', payload: { url: URL_BASE } }
        if (grant instanceof Error) throw grant
        return grant
      }
    },
    fetch: (async (input: URL, init: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init.body)) })
      return opts.post
        ? await opts.post()
        : Response.json({ outcome: 'ok', payload: { status: 200, body: { result: { messageId: 'p1@x.test' } } } })
    }) as typeof fetch,
    store: () => ({ emailMessages: {} as never, admittedTextRowsByTs: async () => [] }),
    transcriptChannel: (channel) => channel,
    sleep: async () => {}
  })
  return { conn, requests, posts }
}

describe('a started mail with attachments (§6.4)', () => {
  it('asks a relay that can send attachments for a ticket, then posts the whole mail to it over HTTP', async () => {
    const h = harness()
    expect(await h.conn.send(start())).toEqual({ outcome: 'sent', messageId: 'p1@x.test' })
    expect(h.requests).toEqual([
      {
        req: { platformId: 'email', botId: BOT, payload: { op: 'send-ticket', tag: TAG } },
        opts: { requires: [RD_EMAIL_ATTACHMENTS_V1] }
      }
    ])
    expect(h.posts).toEqual([{ url: URL_BASE, body: start() }])
  })

  it('sends a mail with no attachments in the frame, as before', async () => {
    const h = harness({ grant: { outcome: 'ok', payload: { status: 200 } } })
    await h.conn.send(start({ attachments: undefined }))
    expect(h.requests[0]!.req.payload).toMatchObject({ op: 'start' })
    expect(h.posts).toEqual([])
  })

  it('says no relay can send attachments when none advertises it, and never posts', async () => {
    const h = harness({ grant: new PlatformRelayUnsent('none') })
    expect(await h.conn.send(start())).toEqual({ outcome: 'unsent', reason: 'no reachable relay can send attachments' })
    expect(h.posts).toEqual([])
  })

  it('follows no URL but the relay’s own send route', async () => {
    const h = harness({ grant: { outcome: 'ok', payload: { url: 'https://elsewhere.example.test/upload/x' } } })
    expect(await h.conn.send(start())).toEqual({ outcome: 'unsent', reason: 'the relay refused it (invalid_ticket)' })
    expect(h.posts).toEqual([])
  })

  it('reads a refused ticket as unsent, and a failure after the post as perhaps sent', async () => {
    const refused = harness({ post: () => new Response(null, { status: 404 }) })
    expect(await refused.conn.send(start())).toEqual({ outcome: 'unsent', reason: 'the relay refused it (http_404)' })
    const lost = harness({ post: () => new Response(null, { status: 502 }) })
    expect((await lost.conn.send(start())).outcome).toBe('unknown')
    expect(lost.posts).toHaveLength(1)
  })
})
