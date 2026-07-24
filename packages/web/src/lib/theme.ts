// Console color theme (light / dark). Dark mode is a semantic-token remap keyed
// off `data-theme="dark"` on <html> (see `:root[data-theme='dark']` in globals.css) —
// so flipping this one attribute re-themes the whole document, including modal
// scrims rendered outside the `.app` subtree. The choice is a per-device
// preference persisted in localStorage; it is applied only while the console shell
// is mounted, so /login and /auth/callback stay light.

export type Theme = 'light' | 'dark'

/** localStorage key holding the persisted console color theme. */
export const THEME_KEY = 'ac-theme'

/** The persisted theme, defaulting to light (also the SSR / storage-blocked value). */
export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** Reflect `theme` on <html> (dark ⇒ attribute present) and persist the choice. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* private mode / storage disabled — theme still applies for this session */
  }
}

/** Drop the theme attribute (on console unmount) without touching the stored choice. */
export function clearThemeAttr(): void {
  if (typeof document === 'undefined') return
  document.documentElement.removeAttribute('data-theme')
}
