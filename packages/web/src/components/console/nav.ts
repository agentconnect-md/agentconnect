// Console route metadata, shared by the Shell (rail / mobile nav / app-bar titles)
// and GlobalSearch (the "Pages" and "Settings" result groups). One table per
// surface, defined here so the nav and the search index can never drift apart.

import { featureFlagEnabled, type FeatureFlagId } from '@/lib/feature-flags'

export interface NavItem {
  href: string
  label: string
  icon: string
  /** Feature flag this destination needs. Absent ⇒ always shown. Every consumer
   *  filters through `navVisible`, so the rail, the mobile sheet and the search
   *  index can never disagree about what this deployment offers. */
  requires?: FeatureFlagId
}

/** Is the destination's feature switched on for this deployment? */
export function navVisible(item: { requires?: FeatureFlagId }): boolean {
  return item.requires ? featureFlagEnabled(item.requires) : true
}

// The rail's destinations, in groups separated by a rule: what the organization
// runs (agents and the surfaces they answer on) first, then what it runs on and
// pays for — infrastructure, the usage that came out of it, the bill. You visit
// the second group to check on the deployment, not to get work done.
export const NAV_GROUPS: NavItem[][] = [
  [
    { href: '/home', label: 'Home', icon: 'house' },
    { href: '/agents', label: 'Agents', icon: 'bot' },
    { href: '/sessions', label: 'Sessions', icon: 'messages-square' },
    { href: '/crons', label: 'Schedules', icon: 'calendar-clock' },
    { href: '/tools', label: 'Tools & Skills', icon: 'blocks' },
    { href: '/integrations', label: 'Integrations', icon: 'plug' },
    { href: '/knowledge', label: 'Knowledge', icon: 'book-open' }
  ],
  [
    { href: '/daemons', label: 'Infra', icon: 'server' },
    { href: '/usage', label: 'Analytics', icon: 'circle-gauge' },
    { href: '/billing', label: 'Billing', icon: 'credit-card', requires: 'billing' }
  ]
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

// The "More" sheet's destinations — the desktop rail items beyond the 4 primary
// tabs, plus Settings. Profile is NOT here: it lives in the mobile app bar as a
// top-right avatar (mirroring the desktop top bar). The org switcher is
// prepended separately, in the sheet itself.
export const MORE_ROWS: NavItem[] = [
  { href: '/tools', label: 'Tools & Skills', icon: 'blocks' },
  { href: '/integrations', label: 'Integrations', icon: 'plug' },
  { href: '/knowledge', label: 'Knowledge', icon: 'book-open' },
  { href: '/daemons', label: 'Infra', icon: 'server' },
  { href: '/usage', label: 'Analytics', icon: 'circle-gauge' },
  { href: '/billing', label: 'Billing', icon: 'credit-card', requires: 'billing' },
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
  { prefix: '/tools', label: 'Tools & Skills' },
  { prefix: '/integrations', label: 'Integrations' },
  { prefix: '/knowledge', label: 'Knowledge' },
  { prefix: '/daemons', label: 'Infra' },
  { prefix: '/usage', label: 'Analytics' },
  { prefix: '/billing', label: 'Billing' },
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
  /** SettingsView renders the target card only for org owners — GlobalSearch hides
   *  the entry from everyone else so results never dead-end on a missing anchor. */
  ownerOnly?: boolean
}

// Aliases and on-page features per route. Keep the integrations list in sync with
// the cards actually rendered by IntegrationsView — they are what makes a query
// like "bots" land on the page that owns that feature.
const PAGE_KEYWORDS: Record<string, string[]> = {
  '/crons': ['cron'],
  '/billing': ['balance', 'credit', 'invoice', 'payment', 'top up'],
  '/tools': ['mcp', 'connectors', 'skills'],
  '/integrations': ['bots', 'github', 'slack', 'telegram', 'discord', 'lark', 'feishu'],
  '/usage': ['usage', 'costs', 'tokens']
}

// Card-level settings entries: one per card on /settings (anchored to the card's
// DOM id — keep hrefs in sync with the `id`s SettingsView renders) plus Profile.
// Every entry carries the 'settings' keyword so the bare query still finds them.
const SETTING_CARDS: ConsolePage[] = [
  { href: '/settings#organization', label: 'Organization', icon: 'settings', kind: 'setting', keywords: ['settings'] },
  {
    href: '/settings#agent-visibility',
    label: 'Default agent visibility',
    icon: 'eye',
    kind: 'setting',
    keywords: ['settings', 'agents']
  },
  {
    href: '/settings#session-access',
    label: 'Session access',
    icon: 'messages-square',
    kind: 'setting',
    keywords: ['settings', 'slack', 'github', 'feishu']
  },
  {
    href: '/settings#environment',
    label: 'Variables & secrets',
    icon: 'key-round',
    kind: 'setting',
    keywords: ['settings', 'environment', 'env'],
    ownerOnly: true
  },
  {
    href: '/settings#members',
    label: 'Members & roles',
    icon: 'users',
    kind: 'setting',
    keywords: ['settings', 'invite']
  },
  {
    href: '/settings#invite-links',
    label: 'Invite links',
    icon: 'link',
    kind: 'setting',
    keywords: ['settings', 'invite'],
    ownerOnly: true
  },
  { href: '/profile', label: 'Profile', icon: 'circle-user-round', kind: 'setting', keywords: ['account'] }
]

// Everything GlobalSearch offers as a navigation target: the rail destinations as
// "Pages", plus the per-card settings entries and Profile as "Settings". The
// settings entries only exist in authed mode — no-auth deployments bounce those
// routes to /home (see Shell), so search must hide them there too.
export const SEARCH_PAGES: ConsolePage[] = [
  ...NAV_GROUPS.flat().map((n) => ({ ...n, kind: 'page' as const, keywords: PAGE_KEYWORDS[n.href] })),
  ...SETTING_CARDS
]
