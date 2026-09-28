// Google ID tokens as a Workspace add-on's requests carry them, and the JWKS that signs them, over one test key pair (google-chat-integration.md §11.2).
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'
import { GOOGLE_OIDC_JWKS_URL } from '../../src/platforms/googlechat/token.js'
import { EVENTS_URL, PROJECT_NUMBER } from './google-chat-events.js'

export const NOW = Date.UTC(2026, 8, 27, 4, 30, 0)
export const KID = 'kid-2026-09'
export const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const OTHER_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
/** The test key as Google's JWKS publishes a signing key. */
export const JWK = { ...KEYS.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }

/** The add-on service account of a project, the only identity its requests are signed for. */
export function addOnServiceAccount(projectNumber: string): string {
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
}

export interface TokenOver {
  aud?: string
  iss?: string
  iat?: number
  exp?: number
  kid?: string
  alg?: 'RS256' | 'RS512'
  key?: KeyObject
  email?: string | undefined
  emailVerified?: unknown
}

/** A token shaped like Google's: RS256, `kid`, a Google issuer, the events URL as audience, the add-on's service account, one hour of life. */
export async function token(over: TokenOver = {}): Promise<string> {
  const iat = over.iat ?? Math.floor(NOW / 1000) - 5
  const email = 'email' in over ? over.email : addOnServiceAccount(PROJECT_NUMBER)
  const verified = 'emailVerified' in over ? over.emailVerified : true
  return new SignJWT({
    ...(email !== undefined ? { email } : {}),
    ...(verified !== undefined ? { email_verified: verified } : {}),
    sub: '100000000000000000077'
  })
    .setProtectedHeader({ alg: over.alg ?? 'RS256', typ: 'JWT', kid: over.kid ?? KID })
    .setIssuer(over.iss ?? 'https://accounts.google.com')
    .setAudience(over.aud ?? EVENTS_URL)
    .setIssuedAt(iat)
    .setExpirationTime(over.exp ?? iat + 3600)
    .sign(over.key ?? KEYS.privateKey)
}

/** `Authorization` carrying {@link token}. */
export async function bearer(over: TokenOver = {}): Promise<string> {
  return `Bearer ${await token(over)}`
}

/** Google's JWKS endpoint, recorded per fetch and rotatable between fetches. */
export function fakeJwks(jwks: { keys: unknown[] } = { keys: [JWK] }, headers: Record<string, string> = {}) {
  const calls: string[] = []
  let current = jwks
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url === GOOGLE_OIDC_JWKS_URL) return Response.json(current, { headers })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    rotate(next: { keys: unknown[] }) {
      current = next
    }
  }
}
