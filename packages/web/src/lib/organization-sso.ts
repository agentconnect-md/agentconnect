// Organization single sign-on, as the browser sees it: the deployment switch, the remembered sign-in method, and a test sign-in in flight.
import type { SocialLoginTarget } from '@/lib/social-login-providers'

/** True where organizations own their SSO connections; matches PublicEnvScript so server and browser agree. */
export function organizationSsoEnabled(): boolean {
  const raw =
    typeof window === 'undefined'
      ? (process.env.ORGANIZATION_SSO ?? process.env.NEXT_PUBLIC_ORGANIZATION_SSO)
      : window.__AC_ENV?.ORGANIZATION_SSO
  return raw === 'true'
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The sign-in method this browser used last; it is offered first next time, and the server is never asked. */
export type LastSignIn = { method: 'email'; email: string } | { method: 'social'; target: SocialLoginTarget }

const LAST_KEY = 'ac.lastSignIn'
const PENDING_KEY = 'ac.pendingSignIn'

function parseSignIn(raw: string | null): LastSignIn | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<{ method: string; email: string; target: string }>
    if (value.method === 'email' && typeof value.email === 'string' && EMAIL_RE.test(value.email)) {
      return { method: 'email', email: value.email }
    }
    if (value.method === 'social' && typeof value.target === 'string') {
      return { method: 'social', target: value.target as SocialLoginTarget }
    }
  } catch {
    /* an unreadable value is no preference */
  }
  return null
}

export function readLastSignIn(): LastSignIn | null {
  try {
    return parseSignIn(localStorage.getItem(LAST_KEY))
  } catch {
    return null
  }
}

/** Note the method a sign-in is leaving with; it only counts once the sign-in completes. */
export function notePendingSignIn(method: LastSignIn): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(method))
  } catch {
    /* storage unavailable: the next visit simply has no preference */
  }
}

/** A sign-in completed: the method it left with becomes the remembered one. */
export function commitPendingSignIn(): void {
  try {
    const pending = parseSignIn(sessionStorage.getItem(PENDING_KEY))
    sessionStorage.removeItem(PENDING_KEY)
    if (pending) localStorage.setItem(LAST_KEY, JSON.stringify(pending))
  } catch {
    /* storage unavailable */
  }
}

/** A test sign-in in flight: what the landing page presents and shows. */
export interface PendingSsoTest {
  nonce: string
  /** Where "Back to Settings" returns. */
  returnTo: string
  /** When the test window closes; a later sign-in in this tab is an ordinary one. */
  expiresAt: string
}

const TEST_KEY = 'ac.ssoTest'

/** Checked before a test window opens: without this storage the landing page could not present the nonce. */
export function canStashSsoTest(): boolean {
  try {
    sessionStorage.setItem(`${TEST_KEY}.probe`, '1')
    sessionStorage.removeItem(`${TEST_KEY}.probe`)
    return true
  } catch {
    return false
  }
}

export function stashSsoTest(test: PendingSsoTest): void {
  try {
    sessionStorage.setItem(TEST_KEY, JSON.stringify(test))
  } catch {
    /* checked with canStashSsoTest before the window opened */
  }
}

/** Read once: a reload of the landing page must not present the nonce again. */
export function takeSsoTest(now: number = Date.now()): PendingSsoTest | null {
  try {
    const raw = sessionStorage.getItem(TEST_KEY)
    sessionStorage.removeItem(TEST_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PendingSsoTest>
    if (typeof value.nonce !== 'string') return null
    if (typeof value.expiresAt !== 'string' || !(Date.parse(value.expiresAt) > now)) return null
    const returnTo =
      typeof value.returnTo === 'string' && value.returnTo.startsWith('/') && !value.returnTo.startsWith('//')
        ? value.returnTo
        : '/settings'
    return { nonce: value.nonce, returnTo, expiresAt: value.expiresAt }
  } catch {
    return null
  }
}
