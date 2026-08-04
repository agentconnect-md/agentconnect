/**
 * Resolve a user's stored Slack App Configuration token to a usable ACCESS token
 * (docs/designs/slack-install-smoothing.md §Tier B).
 *
 * PER-USER: the token belongs to whoever initiates the install, so the app the
 * funnel creates is owned by them (and only they can mint its app-level token).
 *
 * App Configuration access tokens expire ~12h after issue. When the caller stored a
 * refresh token, this rotates it (`tooling.tokens.rotate`) once the access token is
 * within `ROTATE_MARGIN_MS` of expiry, persisting the fresh pair. Rotation is
 * single-use (each rotate invalidates the old refresh), so a rotate that fails is
 * retried once by reloading the row — under a concurrent install by the same user
 * another request may have just rotated and persisted a fresh token we can use.
 *
 * When the caller stored ONLY the access (config) token — no refresh token — there is
 * nothing to rotate: the access token is used as-is while fresh, and once it lapses the
 * resolution is `expired`, so the console asks the caller to re-enter it. Never logs
 * token material.
 */
import type { SlackConfigApi } from './slack-config-api.js'
import type { SlackUserConfigStore } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'

/** The narrow slice of `HttpDeps` the resolution needs — a structural subset,
 *  so route call sites keep passing the full bundle while the Slack platform
 *  provider's `providerToolingCredentials` facet (§9) can delegate here without
 *  faking an entire `HttpDeps` in tests. */
export interface SlackUserConfigDeps {
  slackConfigApi?: SlackConfigApi
  repos: { slackUserConfig: SlackUserConfigStore }
}

/** Rotate when fewer than 5 minutes of access-token life remain (covers clock skew
 *  + the install round-trip that follows). */
export const ROTATE_MARGIN_MS = 5 * 60 * 1000

/** Slack App Configuration access tokens live ~12h from issue. When only the access
 *  token is stored (no refresh to rotate), the row's expiry is stamped this far out. */
export const CONFIG_ACCESS_TTL_MS = 12 * 60 * 60 * 1000

export type UserConfigResolution =
  | { ok: true; accessToken: string }
  // `expired`: an access-only token (no refresh) has lapsed — the caller must re-enter it.
  | { ok: false; reason: 'not_configured' | 'expired' | 'rotate_failed' | 'unreachable' }

/** True while the stored access token has enough life left to use as-is. */
export function accessTokenFresh(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() > ROTATE_MARGIN_MS
}

/** Whether the stored config can start an install right now: a refresh token can always
 *  mint a fresh access token; without one, the access token must still be fresh. */
export function configUsable(row: { refreshToken: string | null; accessExpiresAt: Date } | null, now: Date): boolean {
  return !!row && (!!row.refreshToken || accessTokenFresh(row.accessExpiresAt, now))
}

export async function resolveUserConfigAccessToken(
  deps: SlackUserConfigDeps,
  orgId: OrgId,
  userId: string,
  now: Date
): Promise<UserConfigResolution> {
  const api = deps.slackConfigApi
  if (!api) return { ok: false, reason: 'unreachable' } // funnel off — shouldn't be reached
  const row = await deps.repos.slackUserConfig.get(orgId, userId)
  if (!row) return { ok: false, reason: 'not_configured' }
  if (accessTokenFresh(row.accessExpiresAt, now)) return { ok: true, accessToken: row.accessToken }
  // Stale access token and no refresh token to rotate ⇒ the caller must re-enter it.
  if (!row.refreshToken) return { ok: false, reason: 'expired' }

  const rotated = await api.rotateConfigToken(row.refreshToken)
  if (rotated.ok) {
    await deps.repos.slackUserConfig.put(orgId, userId, rotated.rotated)
    return { ok: true, accessToken: rotated.rotated.accessToken }
  }
  if (rotated.error === 'unreachable') return { ok: false, reason: 'unreachable' }
  // Rotate rejected — the refresh may already have been spent by a concurrent
  // install by the same user that persisted a fresh pair. Reload once and use it.
  const reloaded = await deps.repos.slackUserConfig.get(orgId, userId)
  if (reloaded && accessTokenFresh(reloaded.accessExpiresAt, now)) {
    return { ok: true, accessToken: reloaded.accessToken }
  }
  return { ok: false, reason: 'rotate_failed' }
}
