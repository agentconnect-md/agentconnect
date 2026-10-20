import { z } from 'zod'
import { frameSchema } from '../envelope.js'
import { buildEnvelopeRaw, decodeEnvelopeWith, type BuildOpts, type DecodeResultOf } from '../wire.js'
import { ErrorFrame } from './error.js'

// The relay ↔ desktop daemon wire (computer-use.md §3.7): a NAT-ed desktop dials out, and the relay forwards HTTP to its `/mcp`.

/** Subprotocol negotiated on the desktop daemon ↔ relay socket. */
export const RELAY_COMPUTER_SUBPROTOCOL = 'agentconnect.cr.v1'

/** The desktop's dial-in path, beside the daemons' `/rd/ws` on the same per-instance listener. */
export const RELAY_COMPUTER_WS_PATH = '/cr/ws'

/** The agent daemons' HTTP entry on the same listener; the relay forwards it to the named Computer. */
export const RELAY_COMPUTER_MCP_ROUTE = '/cr/computers/:computerId/mcp'

/** One HTTP body, either way; screenshots fit with room to spare. */
export const RELAY_COMPUTER_MAX_BODY_BYTES = 8 * 1024 * 1024

/** The wire's frame ceiling: a maximal body in base64 plus its envelope. */
export const RELAY_COMPUTER_MAX_FRAME_BYTES = 12 * 1024 * 1024

/** The relay gives up on a forwarded request after this long and answers 504. */
export const RELAY_COMPUTER_REQUEST_TIMEOUT_MS = 120_000

const RELAY_DAEMON_PATH_SUFFIX = '/rd/ws'

// A relay's roster url is its daemon-facing `/rd/ws` address; keep any instance-sticky path prefix in front of it.
function relayUrlAt(relayUrl: string, path: string, scheme: { from: string; to: string }[]): string {
  const url = new URL(relayUrl)
  const prefix = url.pathname.endsWith(RELAY_DAEMON_PATH_SUFFIX)
    ? url.pathname.slice(0, -RELAY_DAEMON_PATH_SUFFIX.length)
    : url.pathname.replace(/\/+$/, '')
  for (const { from, to } of scheme) if (url.protocol === from) url.protocol = to
  url.pathname = `${prefix}${path}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Where a desktop daemon dials a relay from the roster. */
export function relayComputerWsUrl(relayUrl: string): string {
  return relayUrlAt(relayUrl, RELAY_COMPUTER_WS_PATH, [
    { from: 'http:', to: 'ws:' },
    { from: 'https:', to: 'wss:' }
  ])
}

/** Where an agent daemon sends MCP for a Computer through a relay from the roster. */
export function relayComputerMcpUrl(relayUrl: string, computerId: string): string {
  const path = RELAY_COMPUTER_MCP_ROUTE.replace(':computerId', encodeURIComponent(computerId))
  return relayUrlAt(relayUrl, path, [
    { from: 'ws:', to: 'http:' },
    { from: 'wss:', to: 'https:' }
  ])
}

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)
const Headers = z.record(z.string().min(1).max(256), z.string().max(8192))

// D→R REQ, the first frame: a relay-audience channel token the desktop signed with its live key; never logged.
export const CrHello = z
  .object({
    computerId: z.string().uuid(),
    token: z.string().min(1).max(2048),
    desktopDaemonVersion: z.string().trim().min(1).max(64)
  })
  .strict()
export type CrHello = z.infer<typeof CrHello>

// R→D REP: the relay names itself so a desktop that reached the wrong instance can tell.
export const CrHelloOk = z.object({ relayId: z.string().min(1).max(64) })
export type CrHelloOk = z.infer<typeof CrHelloOk>

// R→D REQ: one HTTP request an agent daemon sent; the Authorization header carries its mcp token for the desktop to verify.
export const CrHttpRequest = z.object({
  method: z.enum(['GET', 'POST', 'DELETE']),
  path: z.string().min(1).max(2048),
  headers: Headers,
  body: Base64.optional()
})
export type CrHttpRequest = z.infer<typeof CrHttpRequest>

// D→R REP: the desktop's whole response; bodies are buffered, so only JSON responses (not SSE streams) are forwarded.
export const CrHttpResponse = z.object({
  status: z.number().int().min(100).max(599),
  headers: Headers,
  body: Base64.optional()
})
export type CrHttpResponse = z.infer<typeof CrHttpResponse>

export const RELAY_COMPUTER_SCHEMAS = {
  'cr/hello': CrHello,
  'cr/hello/ok': CrHelloOk,
  'cr/http': CrHttpRequest,
  'cr/http/result': CrHttpResponse,
  error: ErrorFrame
} as const

export type RelayComputerFrameType = keyof typeof RELAY_COMPUTER_SCHEMAS

export const RelayComputerFrame = z.discriminatedUnion('type', [
  frameSchema('cr/hello', RELAY_COMPUTER_SCHEMAS['cr/hello']),
  frameSchema('cr/hello/ok', RELAY_COMPUTER_SCHEMAS['cr/hello/ok']),
  frameSchema('cr/http', RELAY_COMPUTER_SCHEMAS['cr/http']),
  frameSchema('cr/http/result', RELAY_COMPUTER_SCHEMAS['cr/http/result']),
  frameSchema('error', RELAY_COMPUTER_SCHEMAS['error'])
])
export type RelayComputerFrame = z.infer<typeof RelayComputerFrame>

export function decodeRelayComputerFrame(text: string): DecodeResultOf<RelayComputerFrame> {
  return decodeEnvelopeWith<RelayComputerFrame>(RELAY_COMPUTER_SCHEMAS, text, {
    maxBytes: RELAY_COMPUTER_MAX_FRAME_BYTES
  })
}

export function buildRelayComputerFrame<T extends RelayComputerFrameType>(
  type: T,
  payload: z.input<(typeof RELAY_COMPUTER_SCHEMAS)[T]>,
  opts: BuildOpts = {}
): RelayComputerFrame {
  return buildEnvelopeRaw(type, payload, opts) as RelayComputerFrame
}
