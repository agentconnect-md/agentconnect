/**
 * Slack token verification for the install flow
 * (design docs/designs/slack-install-smoothing.md §Tier A).
 *
 * `POST /integrations` calls these to (a) VALIDATE the pasted tokens against Slack
 * before storing them — so a stale / wrong-app / swapped token fails the request
 * with a 400 instead of silently producing an integration whose Socket Mode socket
 * never opens — and (b) derive the bot's display name from `auth.test` when the
 * install omits one (one call does both, so we don't re-fetch just to name the bot).
 *
 * Both are best-effort about *reachability*: a network error / timeout / non-2xx is
 * reported as `unreachable` (inconclusive) and MUST NOT block the install — the CP
 * momentarily failing to reach Slack is not evidence the token is bad. Only a
 * definitive credential error from Slack is treated as `invalid`; transient
 * `ok:false` errors (rate limiting, migrations, service failures) stay
 * `unreachable` so callers never recommend reinstalling a healthy app.
 *
 * These are the only spots the CP touches a token to reach Slack. They NEVER log it.
 */

/** `auth.test` outcome: a valid token (with its derived name), a token Slack
 *  rejected, or an inconclusive reachability failure. */
export type SlackBotVerification =
  | {
      status: 'ok'
      name: string | null
      appId: string | null
      teamId: string | null
      scopes: string[] | null
    } // valid; scopes from x-oauth-scopes
  | { status: 'invalid' } // Slack definitively rejected the credential
  | { status: 'unreachable' } // network / timeout / non-2xx — inconclusive, do not block

export type SlackBotVerifier = (botToken: string) => Promise<SlackBotVerification>

/** An app-level (Socket Mode) token check: valid, rejected, or inconclusive. */
export type SlackTokenCheck = 'ok' | 'invalid' | 'unreachable'
export type SlackAppTokenVerifier = (appToken: string) => Promise<SlackTokenCheck>
type SlackTokenRejection = Exclude<SlackTokenCheck, 'ok'>

const SLACK_TIMEOUT_MS = 5000

const INVALID_CREDENTIAL_ERRORS = new Set([
  'account_inactive',
  'invalid_auth',
  'not_allowed_token_type',
  'not_authed',
  'team_access_not_granted',
  'token_expired',
  'token_revoked'
])

function rejectedCredential(error: unknown, extraInvalidErrors: readonly string[] = []): SlackTokenRejection {
  return typeof error === 'string' && (INVALID_CREDENTIAL_ERRORS.has(error) || extraInvalidErrors.includes(error))
    ? 'invalid'
    : 'unreachable'
}

/** `auth.test` does not consistently include `app_id`, but it does return the
 * workspace-specific `bot_id`. Resolve that through `bots.info` (covered by the
 * manifest's existing `users:read` scope) so refresh can safely bind the bot token
 * to the app it is about to update. Failure is inconclusive, never invalid. */
async function resolveBotAppId(botToken: string, botId: string): Promise<string | null> {
  try {
    const res = await fetch('https://slack.com/api/bots.info', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ bot: botId }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; bot?: { app_id?: string } }
    return body.ok ? (body.bot?.app_id ?? null) : null
  } catch {
    return null
  }
}

/** `auth.test` with the bot token → validity + the derived name (`user`, else `team`). */
export const verifySlackBot: SlackBotVerifier = async (botToken) => {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS)
    })
    if (!res.ok) return { status: 'unreachable' }
    const body = (await res.json()) as {
      ok?: boolean
      error?: string
      user?: string
      team?: string
      team_id?: string
      app_id?: string
      bot_id?: string
    }
    if (!body.ok) return { status: rejectedCredential(body.error) }
    const scopeHeader = res.headers.get('x-oauth-scopes')
    const scopes = scopeHeader
      ? scopeHeader
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean)
      : null
    const appId = body.app_id ?? (body.bot_id ? await resolveBotAppId(botToken, body.bot_id) : null)
    return { status: 'ok', name: body.user ?? body.team ?? null, appId, teamId: body.team_id ?? null, scopes }
  } catch {
    return { status: 'unreachable' }
  }
}

/** `apps.connections.open` with the app-level token → whether it's a usable Socket
 *  Mode token (needs the `connections:write` scope). The call returns a throwaway
 *  WSS URL we never connect to; the daemon opens its own socket. */
export const verifySlackAppToken: SlackAppTokenVerifier = async (appToken) => {
  try {
    const res = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appToken}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS)
    })
    if (!res.ok) return 'unreachable'
    const body = (await res.json()) as { ok?: boolean; error?: string }
    return body.ok ? 'ok' : rejectedCredential(body.error, ['missing_scope'])
  } catch {
    return 'unreachable'
  }
}
