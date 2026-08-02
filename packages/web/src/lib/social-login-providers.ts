// Which social sign-in methods the console offers.
//
// Two halves, on purpose:
//
//  - The CATALOG below is code, because it is presentation: a display name and
//    (via <SocialLoginMark>) a brand mark for every target we know how to draw.
//  - WHICH of them a deployment offers is config, because it is a property of
//    the Logto tenant, not of this repo. `SOCIAL_PROVIDERS` names the enabled
//    targets, and this module is the ONLY place that decides. The CP deliberately
//    does not re-derive the set: a second implementation of these rules is how the
//    buttons and the server came to disagree, so it validates shape only and lets
//    the tenant's connector list be the real gate.
//
// Deliberately NOT read from Logto's API: the value reaches the browser inlined
// in `window.__AC_ENV` (see lib/public-env), so it costs no request and cannot
// flash the wrong buttons on first paint. Querying the tenant would cost both.
//
// Unset keeps the original GitHub / Google / Slack set. New providers are
// opt-in because adding one to this catalog must not make an upgraded deployment
// offer a button for a connector its Logto tenant does not have. `*` explicitly
// opts into the whole catalog. A target whose connector the tenant has not
// configured lands the user on Logto's error page, so deployments should name
// exactly the connectors they offer.

/** Every target this console can render. Order is display order. */
export const SOCIAL_LOGIN_CATALOG = [
  { target: 'github', name: 'GitHub' },
  { target: 'google', name: 'Google' },
  { target: 'slack', name: 'Slack' },
  { target: 'lark', name: 'Lark' },
  { target: 'feishu', name: 'Feishu' }
] as const

export type SocialLoginProvider = (typeof SOCIAL_LOGIN_CATALOG)[number]
/** Any target the catalog knows — independent of what a deployment enables. */
export type SocialLoginTarget = SocialLoginProvider['target']

const DEFAULT_SOCIAL_LOGIN_TARGETS = new Set<SocialLoginTarget>(['github', 'google', 'slack'])

/** Parse the configured target list. Unset / blank ⇒ legacy defaults; `*` ⇒ all. */
export function parseEnabledTargets(raw: string | undefined): Set<string> | null {
  const trimmed = raw?.trim()
  if (!trimmed) return new Set(DEFAULT_SOCIAL_LOGIN_TARGETS)
  if (trimmed === '*') return null
  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.length > 0 ? new Set(entries) : new Set(DEFAULT_SOCIAL_LOGIN_TARGETS)
}

/** Catalog entries this deployment offers, in catalog order. */
export function selectEnabledProviders(raw: string | undefined): readonly SocialLoginProvider[] {
  const enabled = parseEnabledTargets(raw)
  if (!enabled) return SOCIAL_LOGIN_CATALOG
  const selected = SOCIAL_LOGIN_CATALOG.filter((provider) => enabled.has(provider.target))
  // A value naming only unknown targets would otherwise leave the sign-in page
  // with no way in at all; retain the pre-Lark/Feishu defaults without assuming
  // that the tenant has either newly supported connector.
  return selected.length > 0
    ? selected
    : SOCIAL_LOGIN_CATALOG.filter((provider) => DEFAULT_SOCIAL_LOGIN_TARGETS.has(provider.target))
}

/** The providers to render. Reads the runtime config the server inlined. */
export function socialLoginProviders(): readonly SocialLoginProvider[] {
  const src = typeof window === 'undefined' ? process.env : (window.__AC_ENV ?? {})
  return selectEnabledProviders(src.SOCIAL_PROVIDERS || process.env.NEXT_PUBLIC_SOCIAL_PROVIDERS)
}
