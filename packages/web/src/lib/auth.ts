// Logto auth for the console (opt-in). When the Logto endpoint + app id are set,
// "Continue with GitHub/Google" runs a real Authorization-Code + PKCE sign-in
// against Logto and the console sends the resulting bearer token to the Control
// Plane. When UNSET, auth is disabled and the app stays in the CP's zero-config
// no-auth mode (the buttons just enter the app) — the default for OSS self-hosters.
//
// Config is read at RUNTIME, not build time: the server injects window.__AC_ENV
// in the root layout (see lib/public-env), so one prebuilt image can be pointed
// at any tenant via plain container env — no rebuild. The NEXT_PUBLIC_* statics
// remain a build-time fallback for local dev (.env.local) and SSR.
//
// Social providers (Google/GitHub) are configured inside Logto, not here; the
// buttons use Logto's `direct_sign_in` to jump straight to a connector.
//
// Token audience: the CP is an OIDC resource server, so it needs a JWT access
// token scoped to an API *resource*. Set the Logto API resource indicator and
// `getAccessToken` mints a JWT for it; the CP verifies that `aud`. Without a
// resource Logto returns an opaque token the CP can't verify, so we fall back to
// the id token (whose `aud` is the app id — set the CP's OIDC_AUDIENCE to the app
// id in that case).
import LogtoClient, { isLogtoRequestError } from '@logto/browser'
import { MOCK_MODE } from '@/lib/data'
import { identifyUser, resetAnalytics } from '@/lib/analytics'

declare global {
  interface Window {
    __AC_ENV?: Record<string, string>
  }
}

interface LogtoConfig {
  endpoint?: string
  appId?: string
  apiResource?: string
}

/** Resolve Logto config: runtime config wins, NEXT_PUBLIC_* is the build-time fallback. */
function readConfig(): LogtoConfig {
  // Runtime source: window.__AC_ENV in the browser, process.env during SSR. The
  // server must read the same LOGTO_* vars or it renders `isAuthConfigured() ===
  // false` and paints the console before the client redirects to /login (the
  // pre-login flash), since a deployed image leaves NEXT_PUBLIC_* unset.
  const src = typeof window === 'undefined' ? process.env : (window.__AC_ENV ?? {})
  return {
    endpoint: src.LOGTO_ENDPOINT || process.env.NEXT_PUBLIC_LOGTO_ENDPOINT,
    appId: src.LOGTO_APP_ID || process.env.NEXT_PUBLIC_LOGTO_APP_ID,
    apiResource: src.LOGTO_API_RESOURCE || process.env.NEXT_PUBLIC_LOGTO_API_RESOURCE
  }
}

/** True when Logto is configured — gates the whole social-login UI. */
export function isAuthConfigured(): boolean {
  const { endpoint, appId } = readConfig()
  return Boolean(endpoint && appId)
}

let client: LogtoClient | undefined

/** Lazily build the LogtoClient (browser-only — touches window/localStorage). */
function getClient(): LogtoClient | undefined {
  if (typeof window === 'undefined') return undefined
  const { endpoint, appId, apiResource } = readConfig()
  if (!endpoint || !appId) return undefined
  if (!client) {
    client = new LogtoClient({
      endpoint,
      appId,
      // Request the profile claims so the CP can read email/name (from the token or
      // its /userinfo endpoint) and show a real creator instead of a placeholder.
      scopes: ['email', 'profile'],
      ...(apiResource ? { resources: [apiResource] } : {})
    })
  }
  return client
}

/** Start sign-in, jumping straight to a social connector when given. */
export async function login(provider?: 'github' | 'google'): Promise<void> {
  const c = getClient()
  if (!c) return
  await c.signIn({
    redirectUri: `${window.location.origin}/auth/callback`,
    ...(provider ? { directSignIn: { method: 'social', target: provider } } : {})
  })
}

/**
 * Start sign-up. Social-only tenants auto-provision on first login, so this is
 * the same flow as `login()` but opens Logto's register screen first.
 */
export async function signUp(): Promise<void> {
  const c = getClient()
  if (!c) return
  await c.signIn({
    redirectUri: `${window.location.origin}/auth/callback`,
    firstScreen: 'register'
  })
}

/** Complete the redirect on the /auth/callback page. */
export async function completeLogin(): Promise<void> {
  const c = getClient()
  if (!c) return
  await c.handleSignInCallback(window.location.href)
}

/** The signed-in user's display profile, derived from the id token claims. */
export interface AuthUser {
  name: string
  email?: string
  initials: string
  /** Avatar URL from the `picture` claim; absent when the profile has no photo. */
  picture?: string
}

// Header/profile identity when nobody is signed in (no-auth OSS mode). In mock mode
// it's the design's demo persona; otherwise a neutral local placeholder, so a live
// console shows no fabricated name/email.
export const FALLBACK_USER: AuthUser = MOCK_MODE
  ? { name: 'Dana Reyes', email: 'dana@acme.dev', initials: 'DR' }
  : { name: 'Local user', initials: 'LU' }

/** Two-letter initials from a name (or email local-part) for the avatar. */
export function initialsFrom(name: string, email?: string): string {
  const base = (name || email?.split('@')[0] || '').trim()
  if (!base) return '?'
  const parts = base.split(/[\s._-]+/).filter(Boolean)
  const [first, second] = parts
  if (first && second) return (first.charAt(0) + second.charAt(0)).toUpperCase()
  return base.slice(0, 2).toUpperCase()
}

// Last-known signed-in user, cached from getUser(). Lets synchronous render paths
// (creator labels) and request headers read the identity without another async
// round-trip. Null when signed out or auth is disabled.
let cachedUser: AuthUser | null = null

// Multiple API reads can discover the same dead refresh token at once. Share
// one cleanup so they do not race several redirects to the login page.
let invalidGrantCleanup: Promise<void> | undefined

function clearLocalSessionMetadata(): void {
  cachedUser = null
  resetAnalytics()
  // The next sign-in may be a different user, so do not carry the previous
  // user's organization selection into the new session.
  document.cookie = 'ac.org=; path=/; max-age=0'
}

async function clearInvalidGrantSession(c: LogtoClient): Promise<void> {
  invalidGrantCleanup ??= (async () => {
    clearLocalSessionMetadata()
    try {
      await c.clearAllTokens()
    } catch {
      // A storage failure must not strand the console on a session that can no
      // longer refresh. Starting a new sign-in flow will replace stale state.
    }
    window.location.replace('/login')
  })()
  await invalidGrantCleanup
}

// Many in-flight calls can hit the same ACCOUNT_GONE reply at once; share one
// sign-out so they do not race several redirects (mirrors invalidGrantCleanup).
let accountGoneSignOut: Promise<void> | undefined

/**
 * Sign out because the CP says this session's account is gone (401
 * `ACCOUNT_GONE` — an admin deleted it). Ends the Logto session too, so the
 * next sign-in is a deliberate one: whatever is signed in now maps to nothing
 * and every further request would fail the same way.
 */
export async function signOutDeletedAccount(): Promise<void> {
  const c = getClient()
  if (!c) return
  accountGoneSignOut ??= (async () => {
    clearLocalSessionMetadata()
    try {
      await c.signOut(`${window.location.origin}/login`)
    } catch {
      // End-session unreachable — drop the local tokens at least, so the console
      // cannot keep replaying a session that has no account behind it.
      try {
        await c.clearAllTokens()
      } catch {
        /* storage failure — the redirect below still leaves the console */
      }
      window.location.replace('/login')
    }
  })()
  await accountGoneSignOut
}

/** The cached signed-in user (see `cachedUser`); null when signed out / auth off. */
export function currentUser(): AuthUser | null {
  return cachedUser
}

/** The current user from the id token, or null when not signed in / auth off. */
export async function getUser(): Promise<AuthUser | null> {
  const c = getClient()
  if (!c || !(await c.isAuthenticated())) {
    cachedUser = null
    return null
  }
  const claims = await c.getIdTokenClaims()
  // Social accounts without a display name (e.g. a GitHub profile with Name
  // unset) yield no `name` claim — fall back to the email local-part, not the
  // full address (which would render the email twice in the header/profile).
  const name = claims.name || claims.username || claims.email?.split('@')[0] || 'Account'
  cachedUser = {
    name,
    email: claims.email ?? undefined,
    initials: initialsFrom(claims.name || claims.username || '', claims.email ?? undefined),
    ...(typeof claims.picture === 'string' && claims.picture ? { picture: claims.picture } : {})
  }
  // Tie analytics events to this user (no-op when analytics is off). `sub` is the
  // stable OIDC subject — the same distinct id the CP used to identify by.
  identifyUser(claims.sub, {
    ...(claims.email ? { email: claims.email } : {}),
    ...(cachedUser.name ? { name: cachedUser.name } : {})
  })
  return cachedUser
}

/** The raw signed id token — forwarded to the CP (`x-ac-id-token`) as a
 *  verifiable identity hint (email/name) for JIT provisioning. */
export async function getIdTokenRaw(): Promise<string | undefined> {
  const c = getClient()
  if (!c || !(await c.isAuthenticated())) return undefined
  try {
    return (await c.getIdToken()) ?? undefined
  } catch {
    return undefined
  }
}

/** Bearer token for CP calls — a JWT for the CP API resource, else the id token. */
export async function getToken(): Promise<string | undefined> {
  const c = getClient()
  if (!c || !(await c.isAuthenticated())) return undefined
  const { apiResource } = readConfig()
  if (apiResource) {
    try {
      return await c.getAccessToken(apiResource)
    } catch (error) {
      // A rejected refresh grant cannot recover through retries. Expire only
      // the local app session and let Logto's SSO session make re-entry cheap.
      if (!isLogtoRequestError(error) || error.code !== 'oidc.invalid_grant') throw error
      await clearInvalidGrantSession(c)
      throw error
    }
  }
  return (await c.getIdToken()) ?? undefined
}

/**
 * Drop whatever session this browser holds so the next sign-in starts clean.
 * Used by flows that must NOT inherit the last signed-in identity (activation
 * links: the residual session may belong to another — or a since-deleted —
 * account, and redeeming under it activates the wrong user).
 *
 * Returns `'redirecting'` when an active session was ended through Logto (the
 * browser is already leaving for the end-session endpoint and lands on
 * `/login`, so the caller must stop), or `'cleared'` when there was nothing to
 * end and only local token storage was wiped (the caller keeps driving).
 */
export async function resetSession(): Promise<'redirecting' | 'cleared'> {
  const c = getClient()
  if (!c) return 'cleared'
  clearLocalSessionMetadata()
  if (await c.isAuthenticated()) {
    // Ends the Logto SSO session too — a local-only wipe would silently sign the
    // same account straight back in, which is the bug this exists to avoid.
    // `/login` (not the caller's path) because Logto only accepts a registered
    // post-logout redirect URI; the caller stashes where to resume.
    await c.signOut(`${window.location.origin}/login`)
    return 'redirecting'
  }
  try {
    await c.clearAllTokens()
  } catch {
    /* storage failure — a fresh sign-in replaces the stale state anyway */
  }
  return 'cleared'
}

/** Clear the local session and redirect to Logto's end-session endpoint. */
export async function logout(): Promise<void> {
  const c = getClient()
  if (!c) return
  clearLocalSessionMetadata()
  await c.signOut(`${window.location.origin}/login`)
}
