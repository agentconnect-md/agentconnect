// Bot Framework tokens as the Bot Connector signs them, and the OpenID metadata and JWKS that publish the key, over one test key pair (teams-integration.md §3).
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'
import { BOT_FRAMEWORK_ISSUER, BOT_FRAMEWORK_OPENID_CONFIG_URL } from '../../src/platforms/msteams/token.js'
import { APP_ID, SERVICE_URL } from './msteams-activities.js'

export const NOW = Date.UTC(2026, 0, 1, 0, 0, 30)
export const KID = 'kid-example-1'
export const KEYS_URL = 'https://login.botframework.com/v1/.well-known/keys'
export const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const OTHER_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
/** The test key as the Bot Framework publishes one, endorsed for the channels it signs for. */
export const JWK = {
  ...KEYS.publicKey.export({ format: 'jwk' }),
  kid: KID,
  use: 'sig',
  endorsements: ['msteams', 'webchat']
}

export interface TokenOver {
  aud?: string
  iss?: string
  nbf?: number
  exp?: number
  kid?: string
  alg?: 'RS256' | 'RS512'
  key?: KeyObject
  serviceurl?: string | undefined
}

/** A token shaped like the Bot Connector's: RS256, `kid`, the Bot Framework issuer, the app ID as audience, the `serviceurl` claim, one hour of life. */
export async function token(over: TokenOver = {}): Promise<string> {
  const nbf = over.nbf ?? Math.floor(NOW / 1000) - 5
  const serviceurl = 'serviceurl' in over ? over.serviceurl : SERVICE_URL
  return new SignJWT(serviceurl !== undefined ? { serviceurl } : {})
    .setProtectedHeader({ alg: over.alg ?? 'RS256', typ: 'JWT', kid: over.kid ?? KID })
    .setIssuer(over.iss ?? BOT_FRAMEWORK_ISSUER)
    .setAudience(over.aud ?? APP_ID)
    .setNotBefore(nbf)
    .setExpirationTime(over.exp ?? nbf + 3600)
    .sign(over.key ?? KEYS.privateKey)
}

/** `Authorization` carrying {@link token}. */
export async function bearer(over: TokenOver = {}): Promise<string> {
  return `Bearer ${await token(over)}`
}

/** The Bot Framework's OpenID metadata and keys endpoints, recorded per fetch and rotatable between fetches. */
export function fakeBotFramework(jwks: { keys: unknown[] } = { keys: [JWK] }, headers: Record<string, string> = {}) {
  const calls: string[] = []
  let current = jwks
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url === BOT_FRAMEWORK_OPENID_CONFIG_URL)
      return Response.json({ issuer: BOT_FRAMEWORK_ISSUER, jwks_uri: KEYS_URL })
    if (url === KEYS_URL) return Response.json(current, { headers })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    /** How many times the key set was fetched. */
    keyFetches: () => calls.filter((url) => url === KEYS_URL).length,
    rotate(next: { keys: unknown[] }) {
      current = next
    }
  }
}
