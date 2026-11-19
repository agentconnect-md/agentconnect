// The organization settings page's tabs: General is the bare `/settings`, the others are `?tab=<id>`.

export type SettingsTab = 'general' | 'members' | 'sso'

/** The tabs on offer; Single sign-on only where the deployment runs organization SSO and the viewer has something there. */
export function settingsTabs(ssoShown: boolean): SettingsTab[] {
  return ssoShown ? ['general', 'members', 'sso'] : ['general', 'members']
}

/** The tab a `?tab=` value opens; anything unknown or not on offer is General. */
export function resolveSettingsTab(raw: string | null, available: readonly SettingsTab[]): SettingsTab {
  return available.find((tab) => tab === raw) ?? 'general'
}

/** The org-relative path of a tab, with an optional card anchor. */
export function settingsTabHref(tab: SettingsTab, anchor?: string): string {
  return `/settings${tab === 'general' ? '' : `?tab=${tab}`}${anchor ? `#${anchor}` : ''}`
}
