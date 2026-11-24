// Signed callback token for Mattermost interactive message attachment buttons (POST /mattermost/actions).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/** Relay HTTP route path that receives Mattermost interactive message button callbacks. */
export const MATTERMOST_ACTION_PATH = '/mattermost/actions'

/** Maximum characters in a Mattermost interactive button ephemeral refusal/notice response. */
export const MATTERMOST_CARD_NOTE_MAX = 400

const ACTION_SIGNING_PREFIX = 'mm-action-v1:'
const ACTION_SIGNING_V2_PREFIX = 'mm-action-v2:'
const ORG_SCOPED_TOKEN_PREFIX = 'mm1'
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Derive an organization-scoped Mattermost interactive action secret from the master deployment secret. */
export function deriveMattermostOrgActionSecret(masterSecret: string, orgId: string): string {
  return createHmac('sha256', masterSecret).update(`agentconnect:mattermost-action-org:v1:${orgId}`).digest('base64url')
}

export const MattermostActionClaims = z.object({
  v: z.literal(1),
  orgId: z.string().regex(SAFE_ID_RE).optional(),
  daemonId: z.string().uuid(),
  agentId: z.string().uuid(),
  integrationId: z.string().uuid(),
  channelId: z.string().regex(SAFE_ID_RE),
  kind: z.enum(['approval', 'elicit', 'capability', 'draft']),
  requestId: z.string().min(1).max(128),
  option: z.number().int().min(0).max(99).optional(),
  token: z.string().max(128).nullable().optional(),
  cardId: z.string().uuid().optional(),
  generation: z.number().int().positive().optional(),
  exp: z.number().int().positive()
})
export type MattermostActionClaims = z.infer<typeof MattermostActionClaims>

function hmacSign(signedInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signedInput).digest('base64url')
}

function timingSafeSigEqual(providedSig: string, expectedSig: string): boolean {
  const providedBuf = Buffer.from(providedSig, 'utf8')
  const expectedBuf = Buffer.from(expectedSig, 'utf8')
  return providedBuf.byteLength === expectedBuf.byteLength && timingSafeEqual(providedBuf, expectedBuf)
}

function decodeAndCheckClaims(
  payloadB64: string,
  nowMs: number,
  expectedOrgId?: string
): MattermostActionClaims | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const parsed = MattermostActionClaims.safeParse(decoded)
  if (!parsed.success) return null
  if (parsed.data.exp <= nowMs) return null
  if (expectedOrgId !== undefined && parsed.data.orgId !== expectedOrgId) return null
  return parsed.data
}

function parseOrgScopedToken(raw: string): { orgIdB64: string; orgId: string; payloadB64: string; sig: string } | null {
  const parts = raw.split('.')
  if (parts.length !== 4 || parts[0] !== ORG_SCOPED_TOKEN_PREFIX) return null
  const [, orgIdB64, payloadB64, sig] = parts
  if (!orgIdB64 || orgIdB64.length > 96 || !payloadB64 || !sig) return null
  let orgId: string
  try {
    orgId = Buffer.from(orgIdB64, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!SAFE_ID_RE.test(orgId) || Buffer.from(orgId, 'utf8').toString('base64url') !== orgIdB64) {
    return null
  }
  return { orgIdB64, orgId, payloadB64, sig }
}

/** Sign claims for one Mattermost interactive button's `integration.context.token`. */
export function signMattermostActionToken(claims: MattermostActionClaims, secret: string): string {
  const parsed = MattermostActionClaims.parse(claims)
  const payloadB64 = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url')
  if (parsed.orgId) {
    const orgIdB64 = Buffer.from(parsed.orgId, 'utf8').toString('base64url')
    const sig = hmacSign(`${ACTION_SIGNING_V2_PREFIX}${orgIdB64}.${payloadB64}`, secret)
    return `${ORG_SCOPED_TOKEN_PREFIX}.${orgIdB64}.${payloadB64}.${sig}`
  }
  const sig = hmacSign(`${ACTION_SIGNING_PREFIX}${payloadB64}`, secret)
  return `${payloadB64}.${sig}`
}

/** Verify signature, schema, and expiry (`exp > nowMs`) using an org-scoped or standalone secret. */
export function verifyMattermostActionToken(
  raw: string,
  secret: string,
  nowMs = Date.now()
): MattermostActionClaims | null {
  if (!secret || typeof raw !== 'string') return null
  if (raw.startsWith(`${ORG_SCOPED_TOKEN_PREFIX}.`)) {
    const scoped = parseOrgScopedToken(raw)
    if (!scoped) return null
    const expectedSig = hmacSign(`${ACTION_SIGNING_V2_PREFIX}${scoped.orgIdB64}.${scoped.payloadB64}`, secret)
    if (!timingSafeSigEqual(scoped.sig, expectedSig)) return null
    return decodeAndCheckClaims(scoped.payloadB64, nowMs, scoped.orgId)
  }
  const parts = raw.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, providedSig] = parts
  if (!payloadB64 || !providedSig) return null
  const expectedSig = hmacSign(`${ACTION_SIGNING_PREFIX}${payloadB64}`, secret)
  if (!timingSafeSigEqual(providedSig, expectedSig)) return null
  const claims = decodeAndCheckClaims(payloadB64, nowMs)
  return claims && claims.orgId === undefined ? claims : null
}

/** Verify an `mm1` org-scoped token using the deployment's master secret before parsing untrusted JSON. */
export function verifyMattermostActionTokenWithMaster(
  raw: string,
  masterSecret: string,
  nowMs = Date.now()
): MattermostActionClaims | null {
  if (!masterSecret || typeof raw !== 'string') return null
  const scoped = parseOrgScopedToken(raw)
  if (!scoped) return null
  const orgSecret = deriveMattermostOrgActionSecret(masterSecret, scoped.orgId)
  const expectedSig = hmacSign(`${ACTION_SIGNING_V2_PREFIX}${scoped.orgIdB64}.${scoped.payloadB64}`, orgSecret)
  if (!timingSafeSigEqual(scoped.sig, expectedSig)) return null
  return decodeAndCheckClaims(scoped.payloadB64, nowMs, scoped.orgId)
}
