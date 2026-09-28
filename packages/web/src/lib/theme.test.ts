import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getStoredThemePreference,
  nextThemePreference,
  resolveTheme,
  storeThemePreference,
  systemPrefersDark,
  THEME_KEY
} from '@/lib/theme'

// Node environment: `window` is absent until stubbed, which also covers the SSR branch.
function stubWindow(initial: string | null, dark = false) {
  const store = new Map<string, string>()
  if (initial !== null) store.set(THEME_KEY, initial)
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    },
    matchMedia: () => ({ matches: dark })
  })
  return store
}

afterEach(() => vi.unstubAllGlobals())

describe('theme preference', () => {
  it('defaults to system when nothing or an unknown value is stored', () => {
    expect(getStoredThemePreference()).toBe('system')
    stubWindow(null)
    expect(getStoredThemePreference()).toBe('system')
    stubWindow('bogus')
    expect(getStoredThemePreference()).toBe('system')
  })

  it('keeps an explicit light or dark choice', () => {
    stubWindow('light')
    expect(getStoredThemePreference()).toBe('light')
    stubWindow('dark')
    expect(getStoredThemePreference()).toBe('dark')
  })

  it('resolves system from the device color scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('reads the device color scheme', () => {
    expect(systemPrefersDark()).toBe(false)
    stubWindow(null, true)
    expect(systemPrefersDark()).toBe(true)
  })

  it('cycles light → dark → system → light', () => {
    expect(nextThemePreference('light')).toBe('dark')
    expect(nextThemePreference('dark')).toBe('system')
    expect(nextThemePreference('system')).toBe('light')
  })

  it('stores explicit choices and clears the key for system', () => {
    const store = stubWindow('dark')
    storeThemePreference('light')
    expect(store.get(THEME_KEY)).toBe('light')
    storeThemePreference('system')
    expect(store.has(THEME_KEY)).toBe(false)
  })
})
