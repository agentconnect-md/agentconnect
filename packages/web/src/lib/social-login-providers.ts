// Which social sign-in methods the console offers.
//
// Two halves, on purpose:
//
//  - The CATALOG below is code, because it is presentation: a display name and
//    (via <SocialLoginMark>) a brand mark for every target we know how to draw.
//  - WHICH of them a deployment offers is config, because it is a property of
//    the Logto tenant, not of this repo. `SOCIAL_PROVIDERS` names the enabled
//    targets, and the CP reads the same variable to decide what it will link, so
//    one deployment entry configures both sides — instead of two hardcoded lists
//    that have to be kept in step by hand.
//
// Deliberately NOT read from Logto's API: the value reaches the browser inlined
// in `window.__AC_ENV` (see lib/public-env), so it costs no request and cannot
// flash the wrong buttons on first paint. Querying the tenant would cost both.
//
// Unset or `*` ⇒ the whole catalog, matching the CP's own list conventions (see
// control-plane connectors/filter.ts#parseWhitelist). A target whose connector
// the tenant has not configured lands the user on Logto's error page, so a
// deployment offering fewer should say so here.

/** Every target this console can render. Order is display order. */
export const SOCIAL_LOGIN_CATALOG = [
  { target: 'github', name: 'GitHub' },
  { target: 'google', name: 'Google' },
  { target: 'slack', name: 'Slack' }
] as const

export type SocialLoginProvider = (typeof SOCIAL_LOGIN_CATALOG)[number]
/** Any target the catalog knows — independent of what a deployment enables. */
export type SocialLoginTarget = SocialLoginProvider['target']

/** Parse the configured target list. Unset / blank / `*` ⇒ null (no restriction). */
export function parseEnabledTargets(raw: string | undefined): Set<string> | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === '*') return null
  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.length > 0 ? new Set(entries) : null
}

/** Catalog entries this deployment offers, in catalog order. */
export function selectEnabledProviders(raw: string | undefined): readonly SocialLoginProvider[] {
  const enabled = parseEnabledTargets(raw)
  if (!enabled) return SOCIAL_LOGIN_CATALOG
  const selected = SOCIAL_LOGIN_CATALOG.filter((provider) => enabled.has(provider.target))
  // A value naming only unknown targets would otherwise leave the sign-in page
  // with no way in at all; the full catalog is the safer reading of a typo.
  return selected.length > 0 ? selected : SOCIAL_LOGIN_CATALOG
}

/** The providers to render. Reads the runtime config the server inlined. */
export function socialLoginProviders(): readonly SocialLoginProvider[] {
  const src = typeof window === 'undefined' ? process.env : (window.__AC_ENV ?? {})
  return selectEnabledProviders(src.SOCIAL_PROVIDERS || process.env.NEXT_PUBLIC_SOCIAL_PROVIDERS)
}
