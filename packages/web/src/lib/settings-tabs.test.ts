import { describe, expect, it } from 'vitest'
import { resolveSettingsTab, settingsTabHref, settingsTabs } from './settings-tabs'

describe('settings tabs', () => {
  it('offers Single sign-on only when it is shown', () => {
    expect(settingsTabs(true)).toEqual(['general', 'members', 'sso'])
    expect(settingsTabs(false)).toEqual(['general', 'members'])
  })

  it('opens General for no, an unknown or an unavailable tab', () => {
    expect(resolveSettingsTab(null, settingsTabs(true))).toBe('general')
    expect(resolveSettingsTab('billing', settingsTabs(true))).toBe('general')
    expect(resolveSettingsTab('sso', settingsTabs(false))).toBe('general')
    expect(resolveSettingsTab('members', settingsTabs(false))).toBe('members')
    expect(resolveSettingsTab('sso', settingsTabs(true))).toBe('sso')
  })

  it('gives General the bare path', () => {
    expect(settingsTabHref('general')).toBe('/settings')
    expect(settingsTabHref('members', 'invite-links')).toBe('/settings?tab=members#invite-links')
    expect(settingsTabHref('sso')).toBe('/settings?tab=sso')
  })
})
