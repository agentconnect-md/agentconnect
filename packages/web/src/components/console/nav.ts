// Console route metadata, shared by the Shell (rail / mobile nav / app-bar titles)
// and GlobalSearch (the "Pages" and "Settings" result groups). One table per
// surface, defined here so the nav and the search index can never drift apart.

export interface NavItem {
  href: string
  label: string
  icon: string
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'house' },
  { href: '/agents', label: 'Agents', icon: 'bot' },
  { href: '/sessions', label: 'Sessions', icon: 'messages-square' },
  { href: '/crons', label: 'Schedules', icon: 'calendar-clock' },
  { href: '/daemons', label: 'Daemons', icon: 'server' },
  { href: '/tools', label: 'Tools & Skills', icon: 'blocks' },
  { href: '/knowledge', label: 'Knowledge', icon: 'book-open' },
  { href: '/usage', label: 'Analytics', icon: 'circle-gauge' }
]

// Bottom tab bar (mobile only) — exactly the design's 5-slot bar: the 4 primary
// destinations as equal columns plus a "More" slot that opens a bottom sheet.
// (Schedules uses `alarm-clock` per the design, not `calendar-clock`.)
export const MOBILE_NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'house' },
  { href: '/agents', label: 'Agents', icon: 'bot' },
  { href: '/sessions', label: 'Sessions', icon: 'messages-square' },
  { href: '/crons', label: 'Schedules', icon: 'alarm-clock' }
]

// The "More" sheet's destinations — Analytics / Tools & Skills / Settings (the desktop rail
// items beyond the 4 primary tabs). Profile is NOT here: it lives in the mobile app
// bar as a top-right avatar (mirroring the desktop top bar). The org switcher is
// prepended separately, in the sheet itself.
export const MORE_ROWS: NavItem[] = [
  { href: '/daemons', label: 'Daemons', icon: 'server' },
  { href: '/usage', label: 'Analytics', icon: 'circle-gauge' },
  { href: '/tools', label: 'Tools & Skills', icon: 'blocks' },
  { href: '/knowledge', label: 'Knowledge', icon: 'book-open' },
  { href: '/settings', label: 'Settings', icon: 'settings' }
]

// Section label for the mobile app bar, matched by path prefix. (Desktop has no
// title strip — the rail's active row says where you are.)
export const SECTIONS: { prefix: string; label: string }[] = [
  { prefix: '/home', label: 'Home' },
  { prefix: '/agents', label: 'Agents' },
  { prefix: '/sessions', label: 'Sessions' },
  // Merged conversation pages live in the Sessions section (§5.3).
  { prefix: '/conversations', label: 'Sessions' },
  { prefix: '/crons', label: 'Schedules' },
  { prefix: '/daemons', label: 'Daemons' },
  { prefix: '/tools', label: 'Tools & Skills' },
  { prefix: '/knowledge', label: 'Knowledge' },
  { prefix: '/usage', label: 'Analytics' },
  { prefix: '/settings', label: 'Settings' },
  { prefix: '/profile', label: 'Profile' }
]

// ── Search page index ────────────────────────────────────────────────────────

export interface ConsolePage extends NavItem {
  /** Which GlobalSearch group the entry belongs to. */
  kind: 'page' | 'setting'
  /** Match terms the label doesn't cover: route aliases and the features/settings
   *  that live on the page but have no route of their own. */
  keywords?: string[]
}

// Aliases and on-page features per route. Keep the settings lists in sync with the
// cards actually rendered by SettingsView / ProfileView — they are what makes a
// query like "members" or "secrets" land on the page that owns that setting.
const PAGE_KEYWORDS: Record<string, string[]> = {
  '/crons': ['cron'],
  '/tools': ['mcp', 'connectors', 'skills'],
  '/usage': ['usage', 'costs', 'tokens'],
  '/settings': [
    'organization',
    'members',
    'roles',
    'invite links',
    'variables',
    'secrets',
    'environment',
    'bots',
    'github',
    'session access',
    'agent visibility'
  ],
  '/profile': ['account']
}

// Everything GlobalSearch offers as a navigation target: the rail destinations as
// "Pages", plus Settings and Profile (rail-account / More-sheet targets) as
// "Settings". The settings entries only exist in authed mode — no-auth deployments
// bounce those routes to /home (see Shell), so search must hide them there too.
export const SEARCH_PAGES: ConsolePage[] = [
  ...NAV_ITEMS.map((n) => ({ ...n, kind: 'page' as const, keywords: PAGE_KEYWORDS[n.href] })),
  { href: '/settings', label: 'Settings', icon: 'settings', kind: 'setting', keywords: PAGE_KEYWORDS['/settings'] },
  {
    href: '/profile',
    label: 'Profile',
    icon: 'circle-user-round',
    kind: 'setting',
    keywords: PAGE_KEYWORDS['/profile']
  }
]
