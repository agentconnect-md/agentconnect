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
import { WebAPIPlatformError, WebClient, type AppsManifestCreateArguments, type WebClientOptions } from '@slack/web-api'

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

function slackError(error: unknown): string {
  return error instanceof WebAPIPlatformError ? error.data.error : 'unreachable'
}

export interface SlackConfigApiOptions {
  fetch?: WebClientOptions['fetch']
}

/** Slack's official client owns transport, encoding, API errors, and response types. */
export function createSlackConfigApi(options: SlackConfigApiOptions = {}): SlackConfigApi {
  const client = () =>
    new WebClient(undefined, {
      fetch: options.fetch ?? (globalThis.fetch as WebClientOptions['fetch']),
      timeout: SLACK_TIMEOUT_MS,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true
    })

  return {
    async createApp(configToken, manifest) {
      try {
        const body = await client().apps.manifest.create({
          token: configToken,
          manifest: manifest as AppsManifestCreateArguments['manifest']
        })
        const credentials = body.credentials ?? {}
        if (
          !body.app_id ||
          !credentials.client_id ||
          !credentials.client_secret ||
          !credentials.signing_secret ||
          !body.oauth_authorize_url
        ) {
          return { ok: false, error: 'malformed_response' }
        }
        return {
          ok: true,
          app: {
            appId: body.app_id,
            clientId: credentials.client_id,
            clientSecret: credentials.client_secret,
            signingSecret: credentials.signing_secret,
            oauthAuthorizeUrl: body.oauth_authorize_url
          }
        }
      } catch (error) {
        return { ok: false, error: slackError(error) }
      }
    },

    async exportApp(configToken, appId) {
      try {
        const body = await client().apps.manifest.export({ token: configToken, app_id: appId })
        if (body.manifest === null || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) {
          return { ok: false, error: 'malformed_response' }
        }
        return { ok: true, manifest: body.manifest as Record<string, unknown> }
      } catch (error) {
        return { ok: false, error: slackError(error) }
      }
    },

    async updateApp(configToken, appId, manifest) {
      try {
        const body = await client().apps.manifest.update({
          token: configToken,
          app_id: appId,
          manifest: manifest as AppsManifestCreateArguments['manifest']
        })
        if (typeof body.permissions_updated !== 'boolean') return { ok: false, error: 'malformed_response' }
        return { ok: true, permissionsUpdated: body.permissions_updated }
      } catch (error) {
        return { ok: false, error: slackError(error) }
      }
    },

    async exchangeOAuth({ clientId, clientSecret, code, redirectUri }) {
      try {
        const body = await client().oauth.v2.access({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri
        })
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
      } catch (error) {
        return { ok: false, error: slackError(error) }
      }
    },

    async rotateConfigToken(refreshToken) {
      try {
        const body = await client().tooling.tokens.rotate({ refresh_token: refreshToken })
        if (!body.token || !body.refresh_token || !body.exp) return { ok: false, error: 'malformed_response' }
        return {
          ok: true,
          rotated: {
            accessToken: body.token,
            refreshToken: body.refresh_token,
            accessExpiresAt: new Date(body.exp * 1000)
          }
        }
      } catch (error) {
        return { ok: false, error: slackError(error) }
      }
    }
  }
}

/** The live implementation (the container wires this; tests inject a stub). */
export const slackConfigApi = createSlackConfigApi()
