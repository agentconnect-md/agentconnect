/**
 * One-shot signed `state` for the GitHub install deep link / setup callback.
 *
 * The setup callback is unauthenticated (GitHub redirects a browser), so the
 * org being claimed rides inside a signed state: HMAC-SHA256 under a subkey
 * DOMAIN-SEPARATED from API_KEY_PEPPER (never the pepper itself — the pepper
 * already keys api_key hashing, and cross-purpose key reuse entangles two
 * rotation lifecycles). Payload = orgId + expiry + a random nonce; the nonce is
 * persisted and consumed exactly once (replay ⇒ reject), and expiry is inside
 * the signature so a stale row can never be resurrected.
 *
 * GitHub's state passthrough to the Setup URL is undocumented behavior that has
 * regressed before (community #61291) — callers must treat a MISSING state as
 * degraded-but-recoverable (redirect to console → Sync), never an error.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Clock } from '../domain/clock.js'

export const INSTALL_STATE_TTL_MS = 15 * 60 * 1000

/** Domain-separated signing subkey; the pepper itself never signs states. */
export function deriveInstallStateKey(pepper: string): Buffer {
  return createHmac('sha256', pepper).update('github-install-state-v1').digest()
}

export interface InstallState {
  orgId: string
  nonce: string
  expiresAt: Date
}

interface StatePayload {
  o: string // orgId
  e: number // expiry, epoch seconds
  n: string // nonce (persisted, one-shot)
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

/** `<base64url payload>.<base64url mac>` + the nonce/expiry to persist. */
export function mintInstallState(key: Buffer, orgId: string, clock: Clock): { state: string } & InstallState {
  const nonce = randomBytes(16).toString('base64url')
  const expiresAt = new Date(clock.now() + INSTALL_STATE_TTL_MS)
  const payload: StatePayload = { o: orgId, e: Math.floor(expiresAt.getTime() / 1000), n: nonce }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = mac(key, encoded).toString('base64url')
  return { state: `${encoded}.${sig}`, orgId, nonce, expiresAt }
}

/** Null on ANY defect: malformed, bad signature, expired. Constant-time compare. */
export function verifyInstallState(key: Buffer, state: string, clock: Clock): InstallState | null {
  const dot = state.indexOf('.')
  if (dot <= 0 || dot === state.length - 1) return null
  const encoded = state.slice(0, dot)
  const sig = Buffer.from(state.slice(dot + 1), 'base64url')
  const expected = mac(key, encoded)
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload
  } catch {
    return null
  }
  if (typeof payload.o !== 'string' || typeof payload.e !== 'number' || typeof payload.n !== 'string') return null
  if (payload.e * 1000 <= clock.now()) return null
  return { orgId: payload.o, nonce: payload.n, expiresAt: new Date(payload.e * 1000) }
}
