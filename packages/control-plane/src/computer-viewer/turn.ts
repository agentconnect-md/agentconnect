// TURN for the console viewer (computer-use.md §7.2): coturn's REST-API credentials minted from a shared secret, or Cloudflare's from its API.
import { createHmac, hkdfSync } from 'node:crypto'
import { z } from 'zod'
import {
  COMPUTER_ICE_SERVERS_MAX,
  COMPUTER_TURN_URLS_MAX,
  ComputerIceServer,
  ComputerTurnUrl
} from '@agentconnect.md/protocol/computer-viewer'

export interface TurnConfig {
  urls: string[]
  secret: string
  ttlSec: number
}

export interface CloudflareTurnConfig {
  keyId: string
  apiToken: string
  ttlSec: number
}

/** One peer's TURN servers; `who` names the peer, so a server that reads it tells the desktop and the viewer apart. */
export type ExternalTurn = (who: string, nowMs: number) => Promise<ComputerIceServer[]>

/** The deployment's TURN servers, or undefined when none are configured; a half-configured TURN fails fast. */
export function turnConfigFrom(env: {
  COMPUTER_TURN_URLS?: string | undefined
  COMPUTER_TURN_SECRET?: string | undefined
  COMPUTER_TURN_TTL_SEC: number
}): TurnConfig | undefined {
  const urls = (env.COMPUTER_TURN_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  if (urls.length === 0 && !env.COMPUTER_TURN_SECRET) return undefined
  if (urls.length === 0 || !env.COMPUTER_TURN_SECRET) {
    throw new Error('COMPUTER_TURN_URLS and COMPUTER_TURN_SECRET must be set together')
  }
  const bad = urls.find((url) => !/^turns?:[^\s]+$/.test(url) || url.length > 256)
  if (bad) throw new Error(`COMPUTER_TURN_URLS: not a turn: or turns: URL: ${bad}`)
  if (urls.length > 4) throw new Error('COMPUTER_TURN_URLS: at most 4 URLs')
  return { urls, secret: env.COMPUTER_TURN_SECRET, ttlSec: env.COMPUTER_TURN_TTL_SEC }
}

/** Cloudflare Realtime TURN, or undefined when not configured; it fails fast half configured or beside a coturn. */
export function cloudflareTurnConfigFrom(env: {
  COMPUTER_TURN_CLOUDFLARE_KEY_ID?: string | undefined
  COMPUTER_TURN_CLOUDFLARE_API_TOKEN?: string | undefined
  COMPUTER_TURN_URLS?: string | undefined
  COMPUTER_TURN_TTL_SEC: number
}): CloudflareTurnConfig | undefined {
  const keyId = env.COMPUTER_TURN_CLOUDFLARE_KEY_ID?.trim()
  const apiToken = env.COMPUTER_TURN_CLOUDFLARE_API_TOKEN?.trim()
  if (!keyId && !apiToken) return undefined
  if (!keyId || !apiToken) {
    throw new Error('COMPUTER_TURN_CLOUDFLARE_KEY_ID and COMPUTER_TURN_CLOUDFLARE_API_TOKEN must be set together')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(keyId)) throw new Error('COMPUTER_TURN_CLOUDFLARE_KEY_ID: not a TURN key ID')
  if (env.COMPUTER_TURN_URLS?.trim())
    throw new Error('COMPUTER_TURN_URLS and Cloudflare TURN are alternatives; set one')
  return { keyId, apiToken, ttlSec: env.COMPUTER_TURN_TTL_SEC }
}

/** coturn `use-auth-secret` credentials: username `<expiry>:<who>`, password base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(config: TurnConfig, who: string, nowMs: number): ComputerIceServer {
  const username = `${Math.floor(nowMs / 1000) + config.ttlSec}:${who}`
  const credential = createHmac('sha1', config.secret).update(username).digest('base64')
  return { urls: config.urls, username, credential }
}

/** A coturn's credentials, minted locally. */
export function coturnTurn(config: TurnConfig): ExternalTurn {
  return (who, nowMs) => Promise.resolve([turnCredentials(config, who, nowMs)])
}

const CLOUDFLARE_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'
const CLOUDFLARE_TIMEOUT_MS = 5_000

/** Cloudflare's credentials, one API call per peer; a failure leaves the viewer without TURN rather than without a grant. */
export function cloudflareTurn(
  config: CloudflareTurnConfig,
  deps: { warn: (obj: object, msg: string) => void; fetch?: typeof fetch }
): ExternalTurn {
  const doFetch = deps.fetch ?? fetch
  const url = `${CLOUDFLARE_TURN_API}/${config.keyId}/credentials/generate-ice-servers`
  return async () => {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: config.ttlSec }),
        signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS)
      })
      if (!res.ok) {
        deps.warn({ status: res.status }, 'cloudflare turn: credentials refused')
        return []
      }
      const servers = cloudflareIceServers(await res.json())
      if (servers.length === 0) deps.warn({}, 'cloudflare turn: no usable TURN server in the answer')
      return servers
    } catch (err) {
      deps.warn({ err }, 'cloudflare turn: credentials failed')
      return []
    }
  }
}

const CloudflareAnswer = z.object({
  iceServers: z.array(
    z.object({
      urls: z.union([z.string(), z.array(z.string())]),
      username: z.string().optional(),
      credential: z.string().optional()
    })
  )
})

// Browsers block TURN on 53, and the desktop is given no plain-HTTP egress for 80.
const SKIPPED_PORTS = new Set(['53', '80'])

/** The TURN entries of Cloudflare's answer both peers can use: its STUN entry and the ports above dropped. */
export function cloudflareIceServers(body: unknown): ComputerIceServer[] {
  const answer = CloudflareAnswer.safeParse(body)
  if (!answer.success) return []
  return answer.data.iceServers
    .flatMap((server) => {
      const urls = (typeof server.urls === 'string' ? [server.urls] : server.urls)
        .filter((url) => ComputerTurnUrl.safeParse(url).success)
        .filter((url) => !SKIPPED_PORTS.has(/:(\d+)(\?|$)/.exec(url)?.[1] ?? ''))
        .slice(0, COMPUTER_TURN_URLS_MAX)
      const parsed = ComputerIceServer.safeParse({ urls, username: server.username, credential: server.credential })
      return parsed.success ? [parsed.data] : []
    })
    .slice(0, COMPUTER_ICE_SERVERS_MAX)
}

/** The secret relay TURN credentials are minted from, derived from the pepper so relay TURN needs no secret of its own. */
export function relayTurnSecret(pepper: string): string {
  return Buffer.from(hkdfSync('sha256', pepper, 'agentconnect', 'computer relay TURN v1', 32)).toString('base64url')
}
