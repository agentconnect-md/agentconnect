// TURN for the console viewer (computer-use.md §7.2): coturn's REST-API credentials, minted per viewer from a shared secret.
import { createHmac, hkdfSync } from 'node:crypto'
import type { ComputerIceServer } from '@agentconnect.md/protocol'

export interface TurnConfig {
  urls: string[]
  secret: string
  ttlSec: number
}

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

/** coturn `use-auth-secret` credentials: username `<expiry>:<who>`, password base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(config: TurnConfig, who: string, nowMs: number): ComputerIceServer {
  const username = `${Math.floor(nowMs / 1000) + config.ttlSec}:${who}`
  const credential = createHmac('sha1', config.secret).update(username).digest('base64')
  return { urls: config.urls, username, credential }
}

/** The secret relay TURN credentials are minted from, derived from the pepper so relay TURN needs no secret of its own. */
export function relayTurnSecret(pepper: string): string {
  return Buffer.from(hkdfSync('sha256', pepper, 'agentconnect', 'computer relay TURN v1', 32)).toString('base64url')
}
