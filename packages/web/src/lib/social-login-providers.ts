// The social sign-in methods the console offers, in display order. Each `target`
// IS a Logto connector target, passed through verbatim by `directSignIn` (login)
// and by the CP when it resolves the connector to link (Profile). Adding one here
// lights up BOTH surfaces — but the tenant must have that connector enabled, and
// the CP's own `SocialTarget` allowlist (routes/me-social-identities.ts) must
// accept it, or linking is refused server-side.
export const SOCIAL_LOGIN_PROVIDERS = [
  { target: 'github', name: 'GitHub' },
  { target: 'google', name: 'Google' },
  { target: 'slack', name: 'Slack' }
] as const

export type SocialLoginProvider = (typeof SOCIAL_LOGIN_PROVIDERS)[number]
export type SocialLoginTarget = SocialLoginProvider['target']
