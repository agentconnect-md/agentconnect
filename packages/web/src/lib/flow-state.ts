// Scratch storage for state that must survive a redirect out of the app and back
// (the post-sign-in return path, the activation-link freshness marker).
//
// sessionStorage is the natural home — per tab, dies with it — but a privacy mode
// or a blocked-storage setting can make it unavailable while a completed Logto
// session still sits in localStorage. A flow that silently loses its state then
// runs under whatever session is already there, so every write REPORTS whether it
// stuck: callers that cannot proceed safely without it must fail closed.
//
// Fallback order: sessionStorage → a short-lived cookie (browser-wide rather than
// per-tab, hence only a fallback) → failure.

const COOKIE_TTL_SECONDS = 600

type FlowKey = 'returnTo' | 'activate.pending' | 'activate.fresh'

// Both stores share the `ac.` namespace — `ac.returnTo` is the key other pages
// (join, oauth consent, waitlist) already write into sessionStorage directly, so
// this module stays interoperable with them.
const storageKey = (key: FlowKey): string => `ac.${key}`
const cookieName = storageKey

function readCookie(key: FlowKey): string | null {
  const prefix = `${cookieName(key)}=`
  try {
    for (const part of document.cookie.split('; ')) {
      if (!part.startsWith(prefix)) continue
      // An empty value is a deleted cookie (some contexts leave `name=` behind
      // after an expiry), never a stored one — we only ever write non-empty values.
      const value = decodeURIComponent(part.slice(prefix.length))
      return value === '' ? null : value
    }
  } catch {
    /* no cookie access — reads as "nothing stored", never as a throw at the caller */
  }
  return null
}

function writeCookie(key: FlowKey, value: string): boolean {
  try {
    document.cookie = `${cookieName(key)}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_TTL_SECONDS}; SameSite=Lax`
    return readCookie(key) === value
  } catch {
    return false
  }
}

function clearCookie(key: FlowKey): void {
  try {
    document.cookie = `${cookieName(key)}=; path=/; max-age=0; SameSite=Lax`
  } catch {
    /* cookies unavailable — nothing was written either */
  }
}

/** Store flow state across a redirect. Returns false when it could NOT be stored
 *  (neither sessionStorage nor cookies) — the caller must not assume a resume. */
export function writeFlowState(key: FlowKey, value: string): boolean {
  try {
    sessionStorage.setItem(storageKey(key), value)
    // Read back: some browsers accept the write and drop it (quota, privacy mode).
    if (sessionStorage.getItem(storageKey(key)) === value) return true
  } catch {
    /* fall through to the cookie */
  }
  return writeCookie(key, value)
}

/** Read flow state without consuming it. */
export function readFlowState(key: FlowKey): string | null {
  try {
    const v = sessionStorage.getItem(storageKey(key))
    if (v !== null) return v
  } catch {
    /* fall through to the cookie */
  }
  return readCookie(key)
}

/** Forget flow state in both stores (a fallback write may live in either). */
export function clearFlowState(key: FlowKey): void {
  try {
    sessionStorage.removeItem(storageKey(key))
  } catch {
    /* nothing stored there */
  }
  clearCookie(key)
}

/** Read-and-forget — for one-shot markers. */
export function takeFlowState(key: FlowKey): string | null {
  const v = readFlowState(key)
  clearFlowState(key)
  return v
}
