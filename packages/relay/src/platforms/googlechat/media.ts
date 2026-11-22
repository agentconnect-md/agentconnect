// The deployment app's ticketed attachment download (google-chat-integration.md §5): Google's bytes pass through, bounded, and are never kept.
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { FastifyInstance } from 'fastify'
import { GOOGLE_CHAT_MEDIA_PATH } from '@agentconnect.md/protocol'
import type { Logger } from '../../log.js'
import type { GoogleChatRelayEgress } from './egress.js'

export interface GoogleChatMediaRouteDeps {
  egress: () => GoogleChatRelayEgress | undefined
  log: Logger
}

// Fails the stream once it passes the ticket's bound, so a body that lied about its length is cut off.
function bounded(maxBytes: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length
      if (seen > maxBytes) done(new Error('the attachment exceeds the ticket bound'))
      else done(null, chunk)
    }
  })
}

/** Mount `GET /googlechat/media/<ticket>`, a wildcard since a ticket outgrows a path parameter; the ticket is the only credential, so the route logs no URL. */
export function registerGoogleChatMediaRoute(app: FastifyInstance, deps: GoogleChatMediaRouteDeps): void {
  app.get<{ Params: { '*': string } }>(`${GOOGLE_CHAT_MEDIA_PATH}/*`, { logLevel: 'warn' }, async (req, reply) => {
    const egress = deps.egress()
    const opened = egress ? await egress.openMedia(req.params['*']) : { status: 404 }
    if ('status' in opened) return reply.code(opened.status).send()
    const { response, maxBytes } = opened
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      deps.log.warn(`googlechat media: Google answered ${response.status}`)
      return reply.code(response.status === 404 || response.status === 403 ? response.status : 502).send()
    }
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body.cancel().catch(() => {})
      return reply.code(413).send()
    }
    const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>).pipe(bounded(maxBytes))
    return reply
      .header('content-type', response.headers.get('content-type') ?? 'application/octet-stream')
      .header('cache-control', 'no-store')
      .send(body)
  })
}
