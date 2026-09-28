// Google-shaped bearer tokens of both forms and their key endpoints over one test key pair (google-chat-integration.md §2, §11).
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'
import {
  GOOGLE_CHAT_CERTIFICATE_URL,
  GOOGLE_CHAT_TOKEN_ISSUER,
  GOOGLE_OIDC_JWKS_URL
} from '../../src/platforms/googlechat/token.js'
import { selfSignedCertificatePem } from './google-chat-certificate.js'
import { AUDIENCE, EVENTS_URL } from './google-chat-events.js'

export const NOW = Date.UTC(2026, 8, 27, 4, 30, 0)
export const KID = 'kid-2026-09'
export const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const OTHER_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const CERTIFICATE = selfSignedCertificatePem(KEYS.privateKey)
export const OIDC_KID = 'oidc-kid-2026-09'
/** The test key as Google's JWKS publishes a signing key. */
export const JWK = { ...KEYS.publicKey.export({ format: 'jwk' }), kid: OIDC_KID, alg: 'RS256', use: 'sig' }
/** The add-on's per-project service account (§11). */
export const ADD_ON_EMAIL = `service-${AUDIENCE}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`

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

export interface AddOnTokenOver extends TokenOver {
  email?: string | undefined
  emailVerified?: unknown
}

/** A Workspace add-on's token: a Google ID token for the events URL, signed for the add-on's service account (§11). */
export async function addOnToken(over: AddOnTokenOver = {}): Promise<string> {
  const iat = over.iat ?? Math.floor(NOW / 1000) - 5
  const email = 'email' in over ? over.email : ADD_ON_EMAIL
  const verified = 'emailVerified' in over ? over.emailVerified : true
  return new SignJWT({
    ...(email !== undefined ? { email } : {}),
    ...(verified !== undefined ? { email_verified: verified } : {}),
    sub: '100000000000000000077'
  })
    .setProtectedHeader({ alg: over.alg ?? 'RS256', typ: 'JWT', kid: over.kid ?? OIDC_KID })
    .setIssuer(over.iss ?? 'https://accounts.google.com')
    .setAudience(over.aud ?? EVENTS_URL)
    .setIssuedAt(iat)
    .setExpirationTime(over.exp ?? iat + 3600)
    .sign(over.key ?? KEYS.privateKey)
}

/** Google's two key endpoints: the Chat certificate map and the OIDC JWKS, recorded per fetch, rotatable between fetches. */
export function fakeCertificates(
  map: Record<string, string> = { [KID]: CERTIFICATE },
  headers: Record<string, string> = {},
  jwks: { keys: unknown[] } = { keys: [JWK] }
) {
  const calls: string[] = []
  let current = map
  let currentJwks = jwks
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url === GOOGLE_CHAT_CERTIFICATE_URL) return Response.json(current, { headers })
    if (url === GOOGLE_OIDC_JWKS_URL) return Response.json(currentJwks, { headers })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    rotate(next: Record<string, string>) {
      current = next
    },
    rotateJwks(next: { keys: unknown[] }) {
      currentJwks = next
    }
  }
}
