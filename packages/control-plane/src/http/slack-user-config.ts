/**
 * Resolve a user's stored Slack App Configuration token to a usable ACCESS token
 * (docs/designs/slack-install-smoothing.md §Tier B).
 *
 * PER-USER: the token belongs to whoever initiates the install, so the app the
 * funnel creates is owned by them (and only they can mint its app-level token).
 *
 * App Configuration access tokens expire ~12h after issue, so this rotates the
 * stored refresh token (`tooling.tokens.rotate`) when the access token is within
 * `ROTATE_MARGIN_MS` of expiry, persisting the fresh pair. Rotation is single-use
 * (each rotate invalidates the old refresh), so a rotate that fails is retried once
 * by reloading the row — under a concurrent install by the same user another request
 * may have just rotated and persisted a fresh token we can use. Never logs token
 * material.
 */
import type { HttpDeps } from './deps.js'
import type { OrgId } from '../domain/ids.js'

/** Rotate when fewer than 5 minutes of access-token life remain (covers clock skew
 *  + the install round-trip that follows). */
export const ROTATE_MARGIN_MS = 5 * 60 * 1000

export type UserConfigResolution =
  { ok: true; accessToken: string } | { ok: false; reason: 'not_configured' | 'rotate_failed' | 'unreachable' }

function fresh(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() > ROTATE_MARGIN_MS
}

export async function resolveUserConfigAccessToken(
  deps: HttpDeps,
  orgId: OrgId,
  userId: string,
  now: Date
): Promise<UserConfigResolution> {
  const api = deps.slackConfigApi
  if (!api) return { ok: false, reason: 'unreachable' } // funnel off — shouldn't be reached
  const row = await deps.repos.slackUserConfig.get(orgId, userId)
  if (!row) return { ok: false, reason: 'not_configured' }
  if (fresh(row.accessExpiresAt, now)) return { ok: true, accessToken: row.accessToken }

  const rotated = await api.rotateConfigToken(row.refreshToken)
  if (rotated.ok) {
    await deps.repos.slackUserConfig.put(orgId, userId, rotated.rotated)
    return { ok: true, accessToken: rotated.rotated.accessToken }
  }
  if (rotated.error === 'unreachable') return { ok: false, reason: 'unreachable' }
  // Rotate rejected — the refresh may already have been spent by a concurrent
  // install by the same user that persisted a fresh pair. Reload once and use it.
  const reloaded = await deps.repos.slackUserConfig.get(orgId, userId)
  if (reloaded && fresh(reloaded.accessExpiresAt, now)) return { ok: true, accessToken: reloaded.accessToken }
  return { ok: false, reason: 'rotate_failed' }
}
