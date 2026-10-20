import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
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

export interface ViewerOptions {
  computer: Computer
  authenticate: (authorization: string | undefined) => string | undefined
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
  channelMessage(client: string, message: unknown): Promise<unknown>
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>
  // Drop every live stream and takeover now (revoked, or the channel key lapsed); viewers may come back later.
  disconnectAll(reason: string): void
  close(): void
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ComputerError('invalid_argument', 'request body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

// Browser remote desktop at /view: screenshot polling for frames, driver input while the human holds control.
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

  const status = (client: string) => {
    const info = computer.info()
    return {
      you: client,
      inControl: computer.controlledBy(client),
      webrtc: {
        unavailable: options.rtc ? (options.rtcUnavailable?.() ?? null) : 'disabled',
        error: options.streamError?.() ?? null
      },
      ...info
    }
  }

  return {
    close: () => {
      clearInterval(reaper)
      options.rtc?.closeAll()
    },
    disconnectAll(reason) {
      options.rtc?.closeAll()
      lastSeen.clear()
      log(`viewers disconnected: ${reason}`)
    },
    async channelMessage(client, message) {
      lastSeen.set(client, Date.now())
      const { input } = ChannelMessage.parse(message)
      await computer.viewerInput(client, ViewerInputSchema.parse(input) as ViewerInput)
      return null
    },
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
      const client = options.authenticate(req.headers.authorization)
      if (!client) return json(res, 401, { error: 'unauthorized' })
      lastSeen.set(client, Date.now())
      try {
        if (path === '/view/api/status' && req.method === 'GET') return json(res, 200, status(client))
        const refusal = options.refusal?.()
        if (refusal) return json(res, 403, { error: 'unavailable', message: refusal })
        if (path === '/view/api/frame' && req.method === 'GET') {
          const frame = await computer.frame()
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'no-store',
            'x-frame-width': String(frame.width),
            'x-frame-height': String(frame.height)
          })
          return void res.end(frame.png)
        }
        if (path === '/view/api/rtc/offer' && req.method === 'POST') {
          const unavailable = options.rtc ? options.rtcUnavailable?.() : 'disabled'
          if (!options.rtc || unavailable) return json(res, 503, { error: 'webrtc_unavailable', message: unavailable })
          return json(res, 200, await options.rtc.offer(client, req.socket.localAddress))
        }
        if (path === '/view/api/rtc/answer' && req.method === 'POST') {
          if (!options.rtc) return json(res, 503, { error: 'webrtc_unavailable' })
          const { id, sdp } = AnswerSchema.parse(await readJson(req))
          await options.rtc.answer(client, id, sdp)
          return json(res, 200, { ok: true })
        }
        if (path === '/view/api/control' && req.method === 'POST') {
          const { action } = ControlSchema.parse(await readJson(req))
          if (action === 'take') {
            computer.takeOver(client)
            log(`viewer ${client} took control; agent input is blocked until it is released`)
          } else if (computer.handBack(client)) {
            log(`viewer ${client} released control`)
          }
          return json(res, 200, status(client))
        }
        if (path === '/view/api/input' && req.method === 'POST') {
          const input = ViewerInputSchema.parse(await readJson(req)) as ViewerInput
          await computer.viewerInput(client, input)
          return json(res, 200, { ok: true })
        }
        json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
          return json(res, 400, { error: 'invalid_argument', message: error.message })
        }
        if (error instanceof ComputerError) {
          const code =
            error.code === 'invalid_argument'
              ? 400
              : error.code === 'human_in_control'
                ? 409
                : error.code === 'unavailable'
                  ? 403
                  : 502
          return json(res, code, { error: error.code, message: error.message, ...error.details })
        }
        json(res, 500, { error: 'failed', message: (error as Error).message })
      }
    }
  }
}
