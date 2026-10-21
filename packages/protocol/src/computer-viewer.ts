// The console's embedded viewer (computer-use.md §7, §10): signaling rides the relay to the desktop, media goes direct or via TURN.
import { z } from 'zod'

/** The desktop's viewer API prefix; the relay forwards only paths under it besides `/mcp`. */
export const COMPUTER_VIEWER_API_PREFIX = '/view/api/'

/** The browser's entry on a relay: `<relay>/cr/computers/<id>/view/api/<endpoint>` reaches the desktop's `/view/api/<endpoint>`. */
export const RELAY_COMPUTER_VIEW_ROUTE = '/cr/computers/:computerId/view/api/*'

/** A viewer request body is small JSON (an SDP, an input event); a frame response may be large. */
export const COMPUTER_VIEWER_MAX_REQUEST_BYTES = 64 * 1024

/** A viewer token lives this long, or less when its key runs out first; the console renews it at half-life. */
export const COMPUTER_VIEWER_TOKEN_TTL_MS = 120_000

/** How the browser reaches the desktop's media: ICE-lite host candidates, or both sides through TURN. */
export const COMPUTER_VIEWER_TRANSPORTS = ['direct', 'turn'] as const
export type ComputerViewerTransport = (typeof COMPUTER_VIEWER_TRANSPORTS)[number]

/** One TURN server with coturn REST-API credentials (`<expiry>:<user>`, HMAC-SHA1 of the shared secret). */
export const ComputerIceServer = z
  .object({
    urls: z
      .array(
        z
          .string()
          .regex(/^turns?:/)
          .max(256)
      )
      .min(1)
      .max(4),
    username: z.string().min(1).max(256),
    credential: z.string().min(1).max(256)
  })
  .strict()
export type ComputerIceServer = z.infer<typeof ComputerIceServer>

/** The most TURN servers one viewer token or grant names. */
export const COMPUTER_ICE_SERVERS_MAX = 2

/** `POST /view/api/rtc/offer` body; absent means `direct`. */
export const ComputerViewerOfferRequest = z.object({ transport: z.enum(COMPUTER_VIEWER_TRANSPORTS).optional() })
export type ComputerViewerOfferRequest = z.infer<typeof ComputerViewerOfferRequest>

/** A fresh viewer token sent over the DataChannel before the old one lapses; the session closes without one. */
export const ComputerViewerRenewal = z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) })
export type ComputerViewerRenewal = z.infer<typeof ComputerViewerRenewal>

const RELAY_DAEMON_PATH_SUFFIX = '/rd/ws'

/** The viewer API base on a relay, from either its public origin or a roster `/rd/ws` address. */
export function relayComputerViewBase(relayUrl: string, computerId: string): string {
  const url = new URL(relayUrl)
  const prefix = url.pathname.endsWith(RELAY_DAEMON_PATH_SUFFIX)
    ? url.pathname.slice(0, -RELAY_DAEMON_PATH_SUFFIX.length)
    : url.pathname.replace(/\/+$/, '')
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  url.pathname = `${prefix}/cr/computers/${encodeURIComponent(computerId)}/view/api`
  url.search = ''
  url.hash = ''
  return url.toString()
}
