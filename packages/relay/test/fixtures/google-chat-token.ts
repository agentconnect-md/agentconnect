// A Google-shaped bearer token and certificate endpoint over one test key pair (google-chat-integration.md §2).
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'
import { GOOGLE_CHAT_CERTIFICATE_URL, GOOGLE_CHAT_TOKEN_ISSUER } from '../../src/platforms/googlechat/token.js'
import { selfSignedCertificatePem } from './google-chat-certificate.js'
import { AUDIENCE } from './google-chat-events.js'

export const NOW = Date.UTC(2026, 8, 27, 4, 30, 0)
export const KID = 'kid-2026-09'
export const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const OTHER_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const CERTIFICATE = selfSignedCertificatePem(KEYS.privateKey)

export interface TokenOver {
  aud?: string
  iss?: string
  iat?: number
  exp?: number
  kid?: string
  alg?: 'RS256' | 'RS512'
  key?: KeyObject
}

/** A token shaped like Google's: RS256, `kid`, the Chat issuer, the project number, one hour of life. */
export async function token(over: TokenOver = {}): Promise<string> {
  const iat = over.iat ?? Math.floor(NOW / 1000) - 5
  return new SignJWT({})
    .setProtectedHeader({ alg: over.alg ?? 'RS256', typ: 'JWT', kid: over.kid ?? KID })
    .setIssuer(over.iss ?? GOOGLE_CHAT_TOKEN_ISSUER)
    .setAudience(over.aud ?? AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(over.exp ?? iat + 3600)
    .sign(over.key ?? KEYS.privateKey)
}

/** Google's certificate endpoint: one JSON map, recorded per fetch, rotatable between fetches. */
export function fakeCertificates(
  map: Record<string, string> = { [KID]: CERTIFICATE },
  headers: Record<string, string> = {}
) {
  const calls: string[] = []
  let current = map
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url !== GOOGLE_CHAT_CERTIFICATE_URL) throw new Error(`unexpected request to ${url}`)
    return Response.json(current, { headers })
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    rotate(next: Record<string, string>) {
      current = next
    }
  }
}
