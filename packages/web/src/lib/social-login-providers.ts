export const SOCIAL_LOGIN_PROVIDERS = [
  { target: 'github', name: 'GitHub' },
  { target: 'google', name: 'Google' }
] as const

export type SocialLoginProvider = (typeof SOCIAL_LOGIN_PROVIDERS)[number]
export type SocialLoginTarget = SocialLoginProvider['target']
