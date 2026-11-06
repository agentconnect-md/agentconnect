// Logto auth for the console (opt-in). When the Logto endpoint + app id are set,
// "Continue with …" runs a real Authorization-Code + PKCE social sign-in
// against Logto and the console sends the resulting bearer token to the Control
// Plane. When UNSET, auth is disabled and the app stays in the CP's zero-config
// no-auth mode (the buttons just enter the app) — the default for OSS self-hosters.
//
// Config is read at RUNTIME, not build time: the server injects window.__AC_ENV
// in the root layout (see lib/public-env), so one prebuilt image can be pointed
// at any tenant via plain container env — no rebuild. The NEXT_PUBLIC_* statics
// remain a build-time fallback for local dev (.env.local) and SSR.
//
// Supported provider targets are a shared static UI list; their credentials and
// connectors remain configured inside Logto. The buttons use Logto's
// `direct_sign_in` to jump straight to a connector.
//
// Token audience: the CP is an OIDC resource server, so it needs a JWT access
// token scoped to an API *resource*. Set the Logto API resource indicator and
// `getAccessToken` mints a JWT for it; the CP verifies that `aud`. Without a
// resource Logto returns an opaque token the CP can't verify, so we fall back to
// the id token (whose `aud` is the app id — set the CP's OIDC_AUDIENCE to the app
// id in that case).
import LogtoClient, { isLogtoRequestError, LogtoClientError, Prompt, UserScope } from '@logto/browser'
import { MOCK_MODE } from '@/lib/data'
import { identifyUser, resetAnalytics } from '@/lib/analytics'
import { forgetOwnershipProof } from '@/lib/ownership-proof'
import type { SocialLoginTarget } from '@/lib/social-login-providers'
import { enableJwksCacheRecovery } from '@/lib/logto-jwks'
import { writeFlowState } from '@/lib/flow-state'

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

/** Public tenant values used by the browser-side Logto Account API client. */
export function getLogtoPublicConfig(): { endpoint: string; appId: string } | undefined {
  const { endpoint, appId } = readConfig()
  if (!endpoint || !appId) return undefined
  return { endpoint, appId }
}

let client: LogtoClient | undefined

function createClient(): LogtoClient | undefined {
  if (typeof window === 'undefined') return undefined
  const { endpoint, appId, apiResource } = readConfig()
  if (!endpoint || !appId) return undefined
  const c = new LogtoClient({
    endpoint,
    appId,
    requestTimeoutMs: 15_000,
    // Request profile claims for identity display and the Account API.
    scopes: [UserScope.Email, UserScope.Profile, UserScope.Identities, UserScope.Roles],
    ...(apiResource ? { resources: [apiResource] } : {})
  })
  enableJwksCacheRecovery(c)
  return c
}

function getClient(): LogtoClient | undefined {
  return (client ??= createClient())
}

let sessionQueue: Promise<unknown> = Promise.resolve()
let sessionRedirecting = false

// All audiences and tabs rotate the same refresh token; hold the lock through the SDK's storage writes.
async function withSession<T>(operation: (c: LogtoClient) => Promise<T>): Promise<T | undefined> {
  const config = getLogtoPublicConfig()
  if (typeof window === 'undefined' || !config) return undefined
  // A fresh SDK instance reads the persisted token cache after the preceding holder releases the lock.
  const run = () => operation(createClient()!)
  if (navigator.locks) return navigator.locks.request(`ac.auth:${config.appId}`, run)
  // Browsers without Web Locks still serialize token audiences within this page.
  const pending = sessionQueue.then(run, run)
  sessionQueue = pending.catch(() => undefined)
  return pending
}

async function withAuthenticatedSession<T>(operation: (c: LogtoClient) => Promise<T>): Promise<T | undefined> {
  return withSession(async (c) => {
    // Queued reads must not replace an intentional sign-in or SSO sign-out navigation.
    if (sessionRedirecting) throw new LogtoClientError('not_authenticated')
    try {
      if (!(await c.isAuthenticated())) throw new LogtoClientError('not_authenticated')
      return await operation(c)
    } catch (error) {
      if (
        (isLogtoRequestError(error) && error.code === 'oidc.invalid_grant') ||
        (error instanceof LogtoClientError && error.code === 'not_authenticated')
      ) {
        await expireSession(c)
      }
      throw error
    }
  })
}

async function navigateWithSession(operation: (c: LogtoClient) => Promise<void>): Promise<void> {
  await withSession(async (c) => {
    await operation(c)
    sessionRedirecting = true
  })
}

/** Start sign-in, jumping straight to a social connector when given. */
export async function login(provider?: SocialLoginTarget): Promise<void> {
  await navigateWithSession((c) =>
    c.signIn({
      redirectUri: `${window.location.origin}/auth/callback`,
      ...(provider
        ? { directSignIn: { method: 'social', target: provider }, prompt: [Prompt.Login, Prompt.Consent] }
        : {})
    })
  )
}

/** Start sign-in through the deployment's SSO connector. */
export async function loginWithSso(connectorId: string): Promise<void> {
  await navigateWithSession((c) =>
    c.signIn({
      redirectUri: `${window.location.origin}/auth/callback`,
      directSignIn: { method: 'sso', target: connectorId },
      prompt: [Prompt.Login, Prompt.Consent]
    })
  )
}

// Social-only sign-up uses the same flow with the register screen selected.
export async function signUp(): Promise<void> {
  await navigateWithSession((c) =>
    c.signIn({
      redirectUri: `${window.location.origin}/auth/callback`,
      firstScreen: 'register'
    })
  )
}

let loginCompletion: Promise<void> | undefined

// Repeated callback effects must share one authorization-code exchange, including across lock holders.
export function completeLogin(): Promise<void> {
  return (loginCompletion ??= withSession((c) => c.handleSignInCallback(window.location.href)))
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

function clearLocalSessionMetadata(): void {
  cachedUser = null
  resetAnalytics()
  // The next sign-in may be a different user, so do not carry the previous
  // session's fallback cookie into it. The CP restores that user's preference.
  document.cookie = 'ac.org=; path=/; max-age=0'
  // A link proof belongs to the session that earned it. Left behind, the next
  // user in this tab would start a link Logto can only reject at the callback.
  forgetOwnershipProof()
}

// Re-entry returns to the page the session expired on, such as an OAuth consent request, not to the console home.
function rememberReturnPath(): void {
  const { pathname, search } = window.location
  if (pathname === '/login' || pathname.startsWith('/auth/')) return
  writeFlowState('returnTo', pathname + search)
}

async function expireSession(c: LogtoClient): Promise<void> {
  if (sessionRedirecting) return
  clearLocalSessionMetadata()
  try {
    await c.clearAllTokens()
  } catch {
    // A new sign-in replaces stale storage; failed cleanup must not prevent navigation.
  }
  rememberReturnPath()
  window.location.replace('/login')
  sessionRedirecting = true
}

// Recheck the persisted cache inside the lock so concurrent 401s reuse a completed refresh.
export async function refreshTokenAfterUnauthorized(
  rejectedToken?: string,
  audience: 'control-plane' | 'account' = 'control-plane'
): Promise<string | undefined> {
  const { apiResource } = readConfig()
  const resource = audience === 'control-plane' ? apiResource : undefined
  return withAuthenticatedSession(async (c) => {
    const currentToken = await accessToken(c, resource)
    if (rejectedToken && currentToken !== rejectedToken) return currentToken
    await c.clearAccessToken()
    return accessToken(c, resource)
  })
}

// A second rejection ends the local session; no-auth installations remain unaffected.
export async function redirectExpiredSession(): Promise<void> {
  await withSession(expireSession)
}

// Concurrent ACCOUNT_GONE replies share one sign-out.
let accountGoneSignOut: Promise<void> | undefined

// ACCOUNT_GONE ends SSO too, so the next sign-in cannot silently reuse a deleted account.
export async function signOutDeletedAccount(): Promise<void> {
  accountGoneSignOut ??= navigateWithSession(async (c) => {
    clearLocalSessionMetadata()
    try {
      await c.signOut(`${window.location.origin}/login`)
    } catch {
      // Clear local tokens even if the remote end-session endpoint is unreachable.
      try {
        await c.clearAllTokens()
      } catch {
        /* storage failure — the redirect below still leaves the console */
      }
      window.location.replace('/login')
    }
  })
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

/**
 * The signed-in OIDC subject (`sub`), or undefined when signed out / auth off.
 * The stable identity key — unlike the email or display name it never changes for
 * an account — so flows that must act as ONE identity across a redirect (activation
 * links) can bind their state to it and detect a swap.
 */
export async function currentSubject(): Promise<string | undefined> {
  const c = getClient()
  if (!c || !(await c.isAuthenticated())) return undefined
  try {
    return (await c.getIdTokenClaims()).sub
  } catch {
    return undefined
  }
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
  const { apiResource } = readConfig()
  return withAuthenticatedSession(async (c) =>
    apiResource ? accessToken(c, apiResource) : ((await c.getIdToken()) ?? undefined)
  )
}

// The Account API requires an opaque access token minted without a resource.
export async function getAccountToken(): Promise<string | undefined> {
  return withAuthenticatedSession((c) => accessToken(c))
}

async function accessToken(c: LogtoClient, resource?: string): Promise<string> {
  return resource ? c.getAccessToken(resource) : c.getAccessToken()
}

// Clear the previous identity; callers must stop when an active SSO session is 'redirecting'.
export async function resetSession(): Promise<'redirecting' | 'cleared'> {
  return (
    (await withSession(async (c) => {
      clearLocalSessionMetadata()
      if (await c.isAuthenticated()) {
        // End SSO too so activation links cannot silently inherit another account's identity.
        await c.signOut(`${window.location.origin}/login`)
        sessionRedirecting = true
        return 'redirecting' as const
      }
      try {
        await c.clearAllTokens()
      } catch {
        // A fresh sign-in replaces stale state if storage is unavailable.
      }
      return 'cleared' as const
    })) ?? 'cleared'
  )
}

/** Clear the local session and redirect to Logto's end-session endpoint. */
export async function logout(): Promise<void> {
  await navigateWithSession(async (c) => {
    clearLocalSessionMetadata()
    await c.signOut(`${window.location.origin}/login`)
  })
}
