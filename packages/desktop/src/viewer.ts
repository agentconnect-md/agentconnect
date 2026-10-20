import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { ComputerViewerOfferRequest, type ComputerIceServer } from '@agentconnect.md/protocol/computer'
import { ComputerError, type Computer, type ViewerInput } from './computer.js'
import type { RtcSessions } from './stream/rtc.js'
import { VIEWER_PAGE } from './viewer-page.js'

const Fraction = z.number().min(0).max(1)
const Point = z.object({ x: Fraction, y: Fraction })
const ViewerInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), x: Fraction, y: Fraction }),
  z.object({
    type: z.literal('click'),
    x: Fraction,
    y: Fraction,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().min(1).max(3).optional(),
    modifiers: z.array(z.string()).max(4).optional()
  }),
  z.object({ type: z.literal('drag'), from: Point, to: Point }),
  z.object({
    type: z.literal('scroll'),
    x: Fraction,
    y: Fraction,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(50).optional()
  }),
  z.object({ type: z.literal('type'), text: z.string().min(1) }),
  z.object({ type: z.literal('key'), keys: z.array(z.string().min(1)).min(1).max(5) })
])
const ControlSchema = z.object({ action: z.enum(['take', 'release']) })
const AnswerSchema = z.object({ id: z.string(), sdp: z.string().max(64 * 1024) })
const ChannelMessage = z.object({ seq: z.number().optional(), input: z.unknown() })

const MAX_BODY_BYTES = 64 * 1024
// A takeover whose browser stopped polling (tab closed, network gone) is handed back to agents.
const VIEWER_STALE_MS = 15_000

/** Who is watching: a local client token, or a console member's CP-issued view token. */
export interface ViewerPrincipal {
  client: string
  // Whether this viewer may take over input; a `view` token only watches.
  control: boolean
  // TURN servers the CP issued with the token; without them only the direct path is offered.
  iceServers?: ComputerIceServer[]
  // Re-checks a short-lived token; false once it lapsed or its key is gone, which closes the viewer.
  valid?: () => boolean
}

/** One viewer API call, from the local port or forwarded by a relay. */
export interface ViewerRequest {
  method: string
  path: string
  authorization: string | undefined
  body?: Buffer
  // The local address the browser reached, for the direct path's host candidate; unknown through a relay.
  hostAddress?: string
}

export interface ViewerResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export interface ViewerOptions {
  computer: Computer
  authenticate: (authorization: string | undefined) => ViewerPrincipal | undefined
  log: (line: string) => void
  // Absent when no ffmpeg is available; the page then falls back to screenshot polling.
  rtc?: RtcSessions
  // Why WebRTC cannot start right now (e.g. ffmpeg still downloading), or undefined when it can.
  rtcUnavailable?: () => string | undefined
  streamError?: () => string | undefined
  // Why the Control Plane's authority is missing; while set, no frame, stream or input is served.
  refusal?: () => string | undefined
}

export interface Viewer {
  // DataChannel input from a WebRTC viewer, validated like the HTTP path.
  channelMessage(principal: ViewerPrincipal, message: unknown): Promise<unknown>
  // The viewer API (`/view/api/*`) for the local port and the relay alike.
  api(request: ViewerRequest): Promise<ViewerResponse>
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>
  // Drop every live stream and takeover now (revoked, or the channel key lapsed); viewers may come back later.
  disconnectAll(reason: string): void
  close(): void
}

const json = (status: number, body: unknown): ViewerResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: Buffer.from(JSON.stringify(body))
})

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ComputerError('invalid_argument', 'request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const parseJson = (body: Buffer | undefined): unknown => {
  if (body && body.length > MAX_BODY_BYTES) throw new ComputerError('invalid_argument', 'request body too large')
  return JSON.parse(body?.toString('utf8') || '{}')
}

const watchOnly = () => new ComputerError('denied', 'this viewer may watch but not take control')

// Browser remote desktop: WebRTC or screenshot polling for frames, driver input while the human holds control.
export function createViewer(options: ViewerOptions): Viewer {
  const { computer, log } = options
  const lastSeen = new Map<string, number>()
  const reaper = setInterval(() => {
    for (const [client, seen] of lastSeen) {
      if (Date.now() - seen < VIEWER_STALE_MS) continue
      lastSeen.delete(client)
      if (computer.handBack(client)) log(`viewer ${client} went away; control handed back to agents`)
    }
  }, 5000)
  reaper.unref()

  const status = (principal: ViewerPrincipal) => {
    const info = computer.info()
    return {
      you: principal.client,
      mode: principal.control ? 'control' : 'view',
      inControl: computer.controlledBy(principal.client),
      webrtc: {
        unavailable: options.rtc ? (options.rtcUnavailable?.() ?? null) : 'disabled',
        error: options.streamError?.() ?? null,
        turn: (principal.iceServers?.length ?? 0) > 0
      },
      ...info
    }
  }

  async function route(request: ViewerRequest, principal: ViewerPrincipal): Promise<ViewerResponse> {
    const { method, path } = request
    if (path === '/view/api/status' && method === 'GET') return json(200, status(principal))
    const refusal = options.refusal?.()
    if (refusal) return json(403, { error: 'unavailable', message: refusal })
    if (path === '/view/api/frame' && method === 'GET') {
      const frame = await computer.frame()
      return {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'x-frame-width': String(frame.width),
          'x-frame-height': String(frame.height)
        },
        body: frame.png
      }
    }
    if (path === '/view/api/rtc/offer' && method === 'POST') {
      const unavailable = options.rtc ? options.rtcUnavailable?.() : 'disabled'
      if (!options.rtc || unavailable) return json(503, { error: 'webrtc_unavailable', message: unavailable })
      const { transport = 'direct' } = ComputerViewerOfferRequest.parse(parseJson(request.body))
      if (transport === 'turn' && !principal.iceServers?.length) {
        return json(409, { error: 'turn_unavailable', message: 'no TURN server was issued with this viewer token' })
      }
      try {
        return json(200, await options.rtc.offer(principal, { hostAddress: request.hostAddress, transport }))
      } catch (error) {
        return json(502, { error: 'webrtc_failed', message: (error as Error).message })
      }
    }
    if (path === '/view/api/rtc/answer' && method === 'POST') {
      if (!options.rtc) return json(503, { error: 'webrtc_unavailable' })
      const { id, sdp } = AnswerSchema.parse(parseJson(request.body))
      await options.rtc.answer(principal.client, id, sdp)
      return json(200, { ok: true })
    }
    if (path === '/view/api/control' && method === 'POST') {
      const { action } = ControlSchema.parse(parseJson(request.body))
      if (action === 'take') {
        if (!principal.control) throw watchOnly()
        computer.takeOver(principal.client)
        log(`viewer ${principal.client} took control; agent input is blocked until it is released`)
      } else if (computer.handBack(principal.client)) {
        log(`viewer ${principal.client} released control`)
      }
      return json(200, status(principal))
    }
    if (path === '/view/api/input' && method === 'POST') {
      if (!principal.control) throw watchOnly()
      const input = ViewerInputSchema.parse(parseJson(request.body)) as ViewerInput
      await computer.viewerInput(principal.client, input)
      return json(200, { ok: true })
    }
    return json(404, { error: 'not found' })
  }

  const api = async (request: ViewerRequest): Promise<ViewerResponse> => {
    const principal = options.authenticate(request.authorization)
    if (!principal) return json(401, { error: 'unauthorized' })
    lastSeen.set(principal.client, Date.now())
    try {
      return await route(request, principal)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return json(400, { error: 'invalid_argument', message: error.message })
      }
      if (error instanceof ComputerError) {
        const code =
          error.code === 'invalid_argument'
            ? 400
            : error.code === 'human_in_control'
              ? 409
              : error.code === 'unavailable' || error.code === 'denied'
                ? 403
                : 502
        return json(code, { error: error.code, message: error.message, ...error.details })
      }
      return json(500, { error: 'failed', message: (error as Error).message })
    }
  }

  return {
    close: () => {
      clearInterval(reaper)
      options.rtc?.stop()
    },
    disconnectAll(reason) {
      options.rtc?.closeAll()
      lastSeen.clear()
      log(`viewers disconnected: ${reason}`)
    },
    async channelMessage(principal, message) {
      lastSeen.set(principal.client, Date.now())
      if (!principal.control) throw watchOnly()
      const { input } = ChannelMessage.parse(message)
      await computer.viewerInput(principal.client, ViewerInputSchema.parse(input) as ViewerInput)
      return null
    },
    api,
    async handle(req, res, path) {
      if (path === '/view' || path === '/view/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; media-src blob: mediastream:; connect-src 'self'"
        })
        return void res.end(VIEWER_PAGE)
      }
      let body: Buffer | undefined
      try {
        body = req.method === 'POST' ? await readBody(req) : undefined
      } catch (error) {
        const out = json(400, { error: 'invalid_argument', message: (error as Error).message })
        res.writeHead(out.status, out.headers)
        return void res.end(out.body)
      }
      const out = await api({
        method: req.method ?? 'GET',
        path,
        authorization: req.headers.authorization,
        ...(body ? { body } : {}),
        ...(req.socket.localAddress ? { hostAddress: req.socket.localAddress } : {})
      })
      res.writeHead(out.status, out.headers)
      res.end(out.body)
    }
  }
}
