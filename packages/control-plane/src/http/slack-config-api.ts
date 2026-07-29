/**
 * Slack App-management + OAuth calls for the config-token auto-install funnel
 * (docs/designs/slack-install-smoothing.md §Tier B).
 *
 * Two calls, both against api.slack.com, both handling token material — they NEVER
 * log it (no request/response body dumps). Each returns a discriminated result so
 * the route maps Slack's error string to an HTTP status without exceptions on the
 * happy path; a transport failure surfaces as `error: 'unreachable'` (→ 502).
 *
 * Contracts confirmed against docs.slack.dev (apps.manifest.create, oauth.v2.access).
 */

const SLACK_TIMEOUT_MS = 10_000

/** What `apps.manifest.create` hands back — the new app id + its OAuth credentials. */
export interface SlackAppCreation {
  appId: string
  clientId: string
  clientSecret: string
  signingSecret: string
  /** Pre-built authorize URL (carries client_id + scopes); we append state + redirect_uri. */
  oauthAuthorizeUrl: string
}

/** What `oauth.v2.access` hands back once the user approves the install. */
export interface SlackOAuthResult {
  botToken: string // xoxb-… — the bot user OAuth token, the thing we persist
  appId: string
  /** Workspace id ("T…") — the platform-app path persists it as the relay demux
   *  key (Bot.teamId); the per-app funnel has no use for it. */
  teamId: string | null
  teamName: string | null
  botUserId: string | null
}

/** A rotated App Configuration token pair — a fresh access + refresh + expiry. Each
 *  rotate consumes the old refresh token and issues a NEW one (persist both). */
export interface SlackRotatedConfig {
  accessToken: string // xoxe.xoxp-…
  refreshToken: string // xoxe-…
  accessExpiresAt: Date // from the `exp` claim (unix seconds → Date)
}

export type SlackAppCreateResult = { ok: true; app: SlackAppCreation } | { ok: false; error: string }
export type SlackManifestExportResult = { ok: true; manifest: Record<string, unknown> } | { ok: false; error: string }
export type SlackManifestUpdateResult = { ok: true; permissionsUpdated: boolean } | { ok: false; error: string }
export type SlackOAuthExchangeResult = { ok: true; result: SlackOAuthResult } | { ok: false; error: string }
export type SlackRotateResult = { ok: true; rotated: SlackRotatedConfig } | { ok: false; error: string }

/** The two funnel calls, bundled so the container wires one dep and tests stub one object. */
export interface SlackConfigApi {
  /** `apps.manifest.create` — build a new Slack app from `manifest`, authorized by
   *  the user's App Configuration access token (`xoxe.xoxp-…`). */
  createApp(configToken: string, manifest: unknown): Promise<SlackAppCreateResult>
  /** `apps.manifest.export` — read the complete current manifest before refresh;
   *  update is a full replacement, so callers must preserve unknown fields. */
  exportApp(configToken: string, appId: string): Promise<SlackManifestExportResult>
  /** `apps.manifest.update` — replace an existing app's complete manifest. */
  updateApp(configToken: string, appId: string, manifest: unknown): Promise<SlackManifestUpdateResult>
  /** `oauth.v2.access` — exchange the OAuth `code` for the bot token. `redirectUri`
   *  MUST be byte-identical to the one used in the authorize step. */
  exchangeOAuth(p: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
  }): Promise<SlackOAuthExchangeResult>
  /** `tooling.tokens.rotate` — trade a refresh token for a fresh App Configuration
   *  access+refresh pair. The refresh token IS the auth (no other credential). */
  rotateConfigToken(refreshToken: string): Promise<SlackRotateResult>
}

async function postForm(url: string, form: Record<string, string>): Promise<{ ok: boolean; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS)
    })
    if (!res.ok) return null
    return { ok: true, body: await res.json() }
  } catch {
    return null
  }
}

/** The live implementation (the container wires this; tests inject a stub). */
export const slackConfigApi: SlackConfigApi = {
  async createApp(configToken, manifest) {
    const r = await postForm('https://slack.com/api/apps.manifest.create', {
      token: configToken,
      manifest: JSON.stringify(manifest)
    })
    if (!r) return { ok: false, error: 'unreachable' }
    const body = r.body as {
      ok?: boolean
      error?: string
      app_id?: string
      credentials?: { client_id?: string; client_secret?: string; signing_secret?: string }
      oauth_authorize_url?: string
    }
    if (!body.ok) return { ok: false, error: body.error ?? 'unknown_error' }
    const c = body.credentials ?? {}
    if (!body.app_id || !c.client_id || !c.client_secret || !body.oauth_authorize_url) {
      return { ok: false, error: 'malformed_response' }
    }
    return {
      ok: true,
      app: {
        appId: body.app_id,
        clientId: c.client_id,
        clientSecret: c.client_secret,
        signingSecret: c.signing_secret ?? '',
        oauthAuthorizeUrl: body.oauth_authorize_url
      }
    }
  },

  async exportApp(configToken, appId) {
    const r = await postForm('https://slack.com/api/apps.manifest.export', {
      token: configToken,
      app_id: appId
    })
    if (!r) return { ok: false, error: 'unreachable' }
    const body = r.body as { ok?: boolean; error?: string; manifest?: unknown }
    if (!body.ok) return { ok: false, error: body.error ?? 'unknown_error' }
    if (body.manifest === null || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) {
      return { ok: false, error: 'malformed_response' }
    }
    return { ok: true, manifest: body.manifest as Record<string, unknown> }
  },

  async updateApp(configToken, appId, manifest) {
    const r = await postForm('https://slack.com/api/apps.manifest.update', {
      token: configToken,
      app_id: appId,
      manifest: JSON.stringify(manifest)
    })
    if (!r) return { ok: false, error: 'unreachable' }
    const body = r.body as { ok?: boolean; error?: string; permissions_updated?: boolean }
    if (!body.ok) return { ok: false, error: body.error ?? 'unknown_error' }
    if (typeof body.permissions_updated !== 'boolean') return { ok: false, error: 'malformed_response' }
    return { ok: true, permissionsUpdated: body.permissions_updated }
  },

  async exchangeOAuth({ clientId, clientSecret, code, redirectUri }) {
    const r = await postForm('https://slack.com/api/oauth.v2.access', {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    })
    if (!r) return { ok: false, error: 'unreachable' }
    const body = r.body as {
      ok?: boolean
      error?: string
      access_token?: string
      app_id?: string
      bot_user_id?: string
      team?: { id?: string; name?: string }
    }
    if (!body.ok) return { ok: false, error: body.error ?? 'unknown_error' }
    if (!body.access_token || !body.app_id) return { ok: false, error: 'malformed_response' }
    return {
      ok: true,
      result: {
        botToken: body.access_token,
        appId: body.app_id,
        teamId: body.team?.id ?? null,
        teamName: body.team?.name ?? null,
        botUserId: body.bot_user_id ?? null
      }
    }
  },

  async rotateConfigToken(refreshToken) {
    const r = await postForm('https://slack.com/api/tooling.tokens.rotate', { refresh_token: refreshToken })
    if (!r) return { ok: false, error: 'unreachable' }
    const body = r.body as { ok?: boolean; error?: string; token?: string; refresh_token?: string; exp?: number }
    if (!body.ok) return { ok: false, error: body.error ?? 'unknown_error' }
    if (!body.token || !body.refresh_token || !body.exp) return { ok: false, error: 'malformed_response' }
    return {
      ok: true,
      rotated: {
        accessToken: body.token,
        refreshToken: body.refresh_token,
        accessExpiresAt: new Date(body.exp * 1000) // `exp` is unix seconds
      }
    }
  }
}
