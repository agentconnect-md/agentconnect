// Console color theme: dark is a token remap keyed off `data-theme="dark"` on <html>, applied only while the console shell is mounted.

export type Theme = 'light' | 'dark'

/** The user's choice; `system` follows the device's `prefers-color-scheme`. */
export type ThemePreference = 'system' | Theme

/** localStorage key holding the persisted console theme preference. */
export const THEME_KEY = 'ac-theme'

/** Media query matching a device in dark mode. */
export const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Click order of the theme toggle. */
const NEXT: Record<ThemePreference, ThemePreference> = { light: 'dark', dark: 'system', system: 'light' }

export function nextThemePreference(pref: ThemePreference): ThemePreference {
  return NEXT[pref]
}

/** The persisted preference, defaulting to `system` (also the SSR / storage-blocked value). */
export function getStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

/** Whether the device currently prefers a dark color scheme. */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches === true
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** Persist the preference; `system` clears the key so the device setting wins. */
export function storeThemePreference(pref: ThemePreference): void {
  try {
    if (pref === 'system') window.localStorage.removeItem(THEME_KEY)
    else window.localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* private mode / storage disabled — theme still applies for this session */
  }
}

/** Reflect the resolved `theme` on <html> (dark ⇒ attribute present). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
}

/** Drop the theme attribute (on console unmount) without touching the stored choice. */
export function clearThemeAttr(): void {
  if (typeof document === 'undefined') return
  document.documentElement.removeAttribute('data-theme')
}

/** Pre-paint script for the (app) layout: applies the stored or system dark theme before hydration. */
export const THEME_INIT = `try{var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(p==='dark'||(p!=='light'&&window.matchMedia&&window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches))document.documentElement.setAttribute('data-theme','dark')}catch(e){}`
