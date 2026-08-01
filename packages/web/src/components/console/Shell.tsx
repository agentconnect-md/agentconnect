'use client'

// The console shell: the persistent rail + top bar that wrap every route, plus
// the auth gate and the data/playground/modal providers. Replaces the old
// in-component `page` switch — navigation is now real routing (<Link> +
// usePathname), so each view lives at its own URL.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { SiModelcontextprotocol } from 'react-icons/si'
import { SWRConfig, type SWRConfiguration } from 'swr'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { ConsoleDataProvider, useConsoleData } from '@/lib/data-context'
import { OrgProvider, useOrgs, orgColor, subPath } from '@/lib/org-context'
import { ApiError, getMyAccess, type OrgDto } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { PlaygroundProvider } from './PlaygroundProvider'
import { ModalProvider, useModal } from './ModalProvider'
import ConnectAiModal from './ConnectAiModal'
import GettingStarted from './GettingStarted'
import { GlobalSearch } from './GlobalSearch'
import { TooltipLayer } from './Tooltip'
import { SearchOpenContext } from './search-open'
import { LoadingState, LogoMark, OrgIconView } from '@/components/marks'
import { Avatar, Icon } from '@/components/ui'
import { getUser, isAuthConfigured, logout } from '@/lib/auth'
import { useProfile } from '@/lib/profile'
import { useIsMobile } from '@/lib/use-is-mobile'
import { applyTheme, clearThemeAttr, getStoredTheme, type Theme } from '@/lib/theme'

interface NavItem {
  href: string
  label: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
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
const MOBILE_NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'house' },
  { href: '/agents', label: 'Agents', icon: 'bot' },
  { href: '/sessions', label: 'Sessions', icon: 'messages-square' },
  { href: '/crons', label: 'Schedules', icon: 'alarm-clock' }
]

// The "More" sheet's destinations — Analytics / Tools & Skills / Settings (the desktop rail
// items beyond the 4 primary tabs). Profile is NOT here: it lives in the mobile app
// bar as a top-right avatar (mirroring the desktop top bar). The org switcher is
// prepended separately, in the sheet itself.
const MORE_ROWS: NavItem[] = [
  { href: '/daemons', label: 'Daemons', icon: 'server' },
  { href: '/usage', label: 'Analytics', icon: 'circle-gauge' },
  { href: '/tools', label: 'Tools & Skills', icon: 'blocks' },
  { href: '/knowledge', label: 'Knowledge', icon: 'book-open' },
  { href: '/settings', label: 'Settings', icon: 'settings' }
]

// Top-level routes own the tab-bar + list app bar (no back button, bottom nav shown);
// every other route is a "push" screen (back-button app bar, no bottom nav) on mobile.
// Home is a top-level surface (the default landing), not a push screen.
const LIST_ROUTES = ['/home', '/agents', '/sessions', '/crons', '/daemons']
const SESSION_FILTER_KEYS = ['agent', 'integration', 'channel', 'trigger']
const CONSOLE_SWR_CONFIG = {
  dedupingInterval: 2_000,
  focusThrottleInterval: 5_000,
  shouldRetryOnError: (error: unknown) =>
    !(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500
} satisfies SWRConfiguration
// The per-list-tab "+" action → which modal it opens.
const ADD_KIND: Record<string, 'agent' | 'cron' | 'daemon'> = {
  '/agents': 'agent',
  '/crons': 'cron',
  '/daemons': 'daemon'
}

// Section label for the header breadcrumb, matched by path prefix.
const SECTIONS: { prefix: string; label: string }[] = [
  { prefix: '/home', label: 'Home' },
  { prefix: '/agents', label: 'Agents' },
  { prefix: '/sessions', label: 'Sessions' },
  { prefix: '/crons', label: 'Schedules' },
  { prefix: '/daemons', label: 'Daemons' },
  { prefix: '/tools', label: 'Tools & Skills' },
  { prefix: '/knowledge', label: 'Knowledge' },
  { prefix: '/usage', label: 'Analytics' },
  { prefix: '/settings', label: 'Settings' },
  { prefix: '/profile', label: 'Profile' }
]

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + '/')

// Rail-footer "Help & resources" menu targets. `mcp` is the connector guide (how to
// wire Claude — or any MCP client — to AgentConnect), reached as the "More" link of
// the Connect-your-AI dialog. Each is overridable at deploy time via runtime env
// (window.__AC_ENV / NEXT_PUBLIC_*), so an OSS fork can point them at its own docs /
// releases / support without rebuilding; unset ⇒ these agentconnect.md defaults. See
// lib/public-env.tsx (HELP_* keys) + resolveHelpLinks().
const HELP_LINK_DEFAULTS = {
  mcp: 'https://docs.agentconnect.md/docs/mcp-connector',
  docs: 'https://docs.agentconnect.md',
  releases: 'https://github.com/agentconnect-md/agentconnect/releases',
  support: 'mailto:support@agentconnect.md'
}

// Resolve at render (not module load) so it reads the runtime config: window.__AC_ENV
// in the browser, process.env during SSR — mirroring lib/auth.ts. `support` accepts a
// mailto: or an https: URL. NEXT_PUBLIC_* is the local-dev build-time fallback.
function resolveHelpLinks(): typeof HELP_LINK_DEFAULTS {
  const src = typeof window === 'undefined' ? process.env : (window.__AC_ENV ?? {})
  return {
    mcp: src.HELP_MCP_URL || process.env.NEXT_PUBLIC_HELP_MCP_URL || HELP_LINK_DEFAULTS.mcp,
    docs: src.HELP_DOCS_URL || process.env.NEXT_PUBLIC_HELP_DOCS_URL || HELP_LINK_DEFAULTS.docs,
    releases: src.HELP_RELEASES_URL || process.env.NEXT_PUBLIC_HELP_RELEASES_URL || HELP_LINK_DEFAULTS.releases,
    support: src.HELP_SUPPORT_URL || process.env.NEXT_PUBLIC_HELP_SUPPORT_URL || HELP_LINK_DEFAULTS.support
  }
}

function sessionFilterSearch(search: string): string {
  const current = new URLSearchParams(search)
  const next = new URLSearchParams()
  for (const key of SESSION_FILTER_KEYS) {
    const value = current.get(key)
    if (value && value !== 'all') next.set(key, value)
  }
  const qs = next.toString()
  return qs ? `?${qs}` : ''
}

// A slot the Sessions view fills so its mobile filter can be triggered from the
// app bar (which the shell owns). The view registers `{ active, open }` while
// mounted; the mobile app bar renders a filter button that calls `open` and shows
// a dot when `active`. Keeps the option lists + URL state inside SessionsView.
export interface MobileFilterSlot {
  active: boolean
  open: () => void
}
const MobileFilterContext = createContext<{
  filter: MobileFilterSlot | null
  register: (f: MobileFilterSlot | null) => void
}>({ filter: null, register: () => {} })
export const useMobileFilterSlot = () => useContext(MobileFilterContext)

export default function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <OrgProvider>
      <SWRConfig value={CONSOLE_SWR_CONFIG}>
        <ConsoleDataProvider>
          <PlaygroundProvider>
            <ModalProvider>
              <ShellChrome>{children}</ShellChrome>
            </ModalProvider>
          </PlaygroundProvider>
        </ConsoleDataProvider>
      </SWRConfig>
    </OrgProvider>
  )
}

// Rail org switcher (design: `ws.*`) — auth mode only. In no-auth mode there is
// exactly one local default org, so the picker is hidden entirely.
function OrgSwitcher({ collapsed, canCreateOrg }: { collapsed: boolean; canCreateOrg: boolean }) {
  const { orgs, activeOrg, setActiveOrg } = useOrgs()
  const { openModal } = useModal()
  const [open, setOpen] = useState(false)
  if (!activeOrg) return null

  const square = (org: OrgDto) => (
    <OrgIconView
      icon={org.icon}
      iconUrl={org.iconUrl}
      label={org.name ?? org.slug}
      fallbackColor={orgColor(org.id)}
      size={22}
      className="rounded-[5px] text-[11px]"
    />
  )

  return (
    <div className={`relative pt-[10px] pb-[2px] ${collapsed ? 'px-2' : 'px-3'}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={activeOrg.name ?? activeOrg.slug}
        className={`flex w-full cursor-pointer items-center rounded-[7px] border border-(--border-inverse) bg-[rgba(255,255,255,.05)] py-[6px] text-left ${collapsed ? 'justify-center px-0' : 'gap-[9px] px-[9px]'}`}
      >
        {square(activeOrg)}
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-semibold leading-normal text-white">
              {activeOrg.name ?? activeOrg.slug}
            </span>
            <Icon name="chevrons-up-down" size={14} color="var(--text-inverse-dim)" className="flex-none" />
          </>
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-45" />
          <div
            className={`absolute top-[calc(100%_-_1px)] z-50 rounded-md border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg) ${collapsed ? 'left-2 w-[230px]' : 'right-3 left-3'}`}
          >
            {orgs.map((o) => (
              <button
                key={o.id}
                className="dmi justify-between"
                onClick={() => {
                  setActiveOrg(o.id)
                  setOpen(false)
                }}
              >
                <span className="inline-flex items-center gap-[9px]">
                  {square(o)}
                  {o.name ?? o.slug}
                </span>
                {o.id === activeOrg.id && <Icon name="check" size={15} color="var(--brand)" />}
              </button>
            ))}
            {canCreateOrg && (
              <>
                <div className="mx-[2px] my-1 h-[1px] bg-(--border-subtle)" />
                <button
                  className="dmi"
                  onClick={() => {
                    setOpen(false)
                    openModal('createOrg')
                  }}
                >
                  <Icon name="plus" size={15} />
                  Create organization
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ShellChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const params = useParams<{ slug?: string }>()
  const { orgPath, orgs, activeOrg, setActiveOrg } = useOrgs()
  const { openModal } = useModal()
  const { daemons, agents, crons, allSessions } = useConsoleData()
  // Mobile-only chrome state: which bottom sheet is open, and the full-screen search.
  const [mobileSheet, setMobileSheet] = useState<'more' | 'org' | null>(null)
  const [mobileSearch, setMobileSearch] = useState(false)
  const [locationSearch, setLocationSearch] = useState('')
  const isMobile = useIsMobile()
  // Open global search from anywhere (e.g. a not-found page's "Search" action):
  // the full-screen overlay on mobile, or the desktop top-bar box via its own ⌘K
  // listener. Provided to the page subtree through SearchOpenContext.
  const openSearch = useCallback(() => {
    if (isMobile) setMobileSearch(true)
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  }, [isMobile])
  // Filter slot the current view (Sessions) registers so the app bar can trigger it.
  const [mobileFilter, setMobileFilter] = useState<MobileFilterSlot | null>(null)
  // Active/crumb matching runs on the console path WITHOUT the org segment
  // (`/acme/agents` → `/agents`); hrefs go the other way via orgPath().
  const barePath = subPath(pathname, typeof params.slug === 'string' ? decodeURIComponent(params.slug) : '-')
  const router = useRouter()
  // Rail-footer help popover + the shortcuts modal it can open.
  const [helpMenu, setHelpMenu] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [connectAiOpen, setConnectAiOpen] = useState(false)
  const help = resolveHelpLinks()
  // Push-screen share action: the session detail app bar surfaces a top-right link
  // icon (design) that copies the deep link; a brief check-swap confirms the copy.
  const [linkCopied, setLinkCopied] = useState(false)
  // Gate the first paint until the auth check resolves so an unauthenticated
  // visitor never flashes the console before the /login redirect. In no-auth
  // OSS mode there's nothing to check, so we're ready immediately.
  const [authReady, setAuthReady] = useState(!isAuthConfigured())
  // Whether the signed-in user may create orgs. Always true unless WAITLIST_MODE is
  // on and the user is not yet activated (waitlist-and-login.md §9) — then the
  // "Create organization" entry points are hidden (the real block is server-side).
  const [canCreateOrg, setCanCreateOrg] = useState(true)

  // Auth + admission gate. When auth is configured but nobody is signed in, bounce
  // to /login. When closed-beta (waitlist) mode is on and the user isn't admitted
  // yet, bounce to /waitlist and keep the gate spinner (never flash the console).
  // No-auth OSS mode is left untouched. Fails OPEN on a transient /me/access error
  // — the server still enforces the gate on every write.
  useEffect(() => {
    if (!isAuthConfigured()) return
    let active = true
    void (async () => {
      const u = await getUser()
      if (!active) return
      if (!u) {
        router.replace('/login')
        return
      }
      try {
        const access = await getMyAccess()
        if (!active) return
        if (access.waitlistMode && access.status !== 'active') {
          router.replace('/waitlist')
          return
        }
        setCanCreateOrg(!access.waitlistMode || access.activated)
      } catch {
        /* fail open — server-side gate is authoritative */
      }
      if (active) setAuthReady(true)
    })()
    return () => {
      active = false
    }
  }, [router])

  // Who to show in the avatar/menu — the signed-in identity with the CP /me
  // overlay (live: repaints when the edit-profile dialog saves), else the
  // no-auth placeholder (the design's demo persona only in mock mode).
  const { user: display } = useProfile()

  // Color theme (light / dark). `mounted` gates the apply-effect so the first
  // client pass never stomps the attribute the (app)-layout init script already
  // set — avoiding a dark→light→dark flash on hard reload. The stored preference
  // is read after mount (SSR renders the light default), applied to <html>, and
  // cleared when the console unmounts so /login stays light.
  const [theme, setTheme] = useState<Theme>('light')
  const [themeReady, setThemeReady] = useState(false)
  // `mounted` flips after the first client render. The desktop-first SSR markup
  // (useIsMobile is false on the server) briefly paints on phones before the mobile
  // layout swaps in — most visibly the magenta "Add agent" button. A CSS rule keeps
  // `.content` hidden on mobile until `.app.mounted`, so that flash never shows.
  // Desktop is untouched: the rule lives inside the mobile media query.
  const [mounted, setMounted] = useState(false)
  // Desktop rail collapse (icons-only 64px rail). Persisted so it survives reloads;
  // SSR renders expanded, then the mount effect applies the stored preference. The
  // width transition is enabled a frame later (`railAnim`) so that first apply snaps
  // instead of sweeping. The rail is hidden on mobile, so this is desktop-only.
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [railAnim, setRailAnim] = useState(false)
  useEffect(() => {
    setTheme(getStoredTheme())
    setThemeReady(true)
    setMounted(true)
    try {
      setRailCollapsed(localStorage.getItem('ac.rail-collapsed') === '1')
    } catch {
      /* storage unavailable — stay expanded */
    }
  }, [])
  useEffect(() => {
    if (!mounted) return
    const id = requestAnimationFrame(() => setRailAnim(true))
    return () => cancelAnimationFrame(id)
  }, [mounted])
  useEffect(() => {
    if (!themeReady) return
    applyTheme(theme)
    return () => clearThemeAttr()
  }, [theme, themeReady])
  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])
  const toggleRail = useCallback(() => {
    setRailCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('ac.rail-collapsed', next ? '1' : '0')
      } catch {
        /* storage unavailable — collapse still applies for this session */
      }
      return next
    })
  }, [])

  const signOut = useCallback(() => {
    if (isAuthConfigured()) void logout()
    else router.push('/login')
  }, [router])

  // Close any open mobile sheet / full-screen search whenever the route changes —
  // a nav tap, a search selection, a More-row link, or the browser back button.
  useEffect(() => {
    setMobileSheet(null)
    setMobileSearch(false)
    if (typeof window !== 'undefined') setLocationSearch(window.location.search)
  }, [barePath])

  // No-auth mode has no identity and a single implicit org, so Profile / Settings
  // don't exist — bounce any direct navigation to those routes back to the home landing.
  useEffect(() => {
    if (!isAuthConfigured() && (barePath === '/profile' || barePath === '/settings')) {
      router.replace(orgPath('/home'))
    }
  }, [barePath, router, orgPath])

  // Until the auth check resolves, render a spinner (not the console) so an
  // unauthenticated direct hit doesn't flash the dashboard.
  if (!authReady)
    return (
      <div className="loadgate">
        <LoadingState fill />
      </div>
    )

  // Onboarding is a full-screen takeover (design: "AgentConnect Onboarding") — no rail,
  // but it keeps a slim top bar consistent with the rest of the console (theme toggle +
  // user menu), rendered here so it reuses the shell's own theme/sign-out state.
  // OnboardingView renders just the centered content. Providers (org, data, modal,
  // playground) live ABOVE ShellChrome, so the checklist CTAs' modals still work.
  if (barePath === '/onboarding')
    return (
      <div className="fixed inset-0 flex flex-col overflow-hidden bg-(--surface-app)">
        <header className="flex h-14 flex-none items-center gap-[14px] border-b border-(--border-subtle) bg-(--surface-card) px-5 desktop:px-[22px]">
          <Link
            href={orgPath('/agents')}
            className="flex items-center gap-[10px] no-underline"
            aria-label="AgentConnect"
          >
            <LogoMark size={24} />
            <span className="font-sans text-[16px] font-semibold leading-none tracking-[-.02em] text-(--text-primary)">
              Agent<span className="text-(--brand)">Connect</span>
            </span>
          </Link>
          <div className="flex-1" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          {isAuthConfigured() && <UserMenu display={display} orgPath={orgPath} onSignOut={signOut} />}
        </header>
        <div className="flex-1 overflow-auto">{children}</div>
        <TooltipLayer />
      </div>
    )

  const crumb = SECTIONS.find((s) => isActive(barePath, s.prefix))?.label ?? ''

  // Mobile chrome is route-driven (SSR-safe): a LIST route shows the list app bar +
  // bottom nav; anything deeper is a PUSH screen (back-button app bar, no nav). The
  // viewport switch (desktop rail ↔ mobile chrome) is handled by CSS, so both are in
  // the DOM and there's no hydration flash.
  const isListRoute = LIST_ROUTES.includes(barePath)
  const addKind = ADD_KIND[barePath] ?? null
  // In no-auth mode there is no user identity and one implicit org, so Profile,
  // Settings and org switching are all hidden (desktop rail + top bar + mobile More sheet).
  const authOn = isAuthConfigured()
  const closeSheets = () => {
    setMobileSheet(null)
    setMobileSearch(false)
  }

  // Mobile push-screen title: resolve the entity name from the route id (so the
  // back-button app bar reads "deploy-bot" / "edge-1" / the session title, matching
  // the design), falling back to the section crumb for top-level push pages
  // (Profile / Analytics / Tools & Skills / Settings) or before the entity has loaded.
  const seg = barePath.split('/').filter(Boolean)
  const pushTitle = (() => {
    if (seg.length < 2) return crumb
    const [section, id] = seg
    if (section === 'agents')
      return agents.find((a) => a.id === id) ? agentLabel(agents.find((a) => a.id === id)!) : crumb
    if (section === 'daemons') return daemons.find((d) => d.daemonId === id)?.name ?? crumb
    if (section === 'sessions') return allSessions.find((s) => s.id === id)?.title ?? crumb
    if (section === 'crons') return crons.find((c) => c.id === id)?.name ?? crumb
    return crumb
  })()

  // Back from a push screen: pop in-app history when there is any, else (deep-link /
  // hard refresh — no history) route to the parent list so "back" never leaves the app.
  const hasParentList = LIST_ROUTES.includes(`/${seg[0] ?? ''}`)
  const parentList = hasParentList ? `/${seg[0]}` : '/home'
  const parentListHref = orgPath(parentList + (seg[0] === 'sessions' ? sessionFilterSearch(locationSearch) : ''))
  const showDetailCrumb = hasParentList && seg.length >= 2 && crumb !== '' && pushTitle !== crumb
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push(parentListHref)
  }

  // Session detail is the one push screen with a shareable deep link. Copy the
  // org-scoped URL, matching the desktop "Copy link" button, and flash the icon
  // to a check for ~1.6s.
  const isSessionDetail = seg[0] === 'sessions' && seg.length === 2
  const copyLink = () => {
    try {
      void navigator.clipboard?.writeText?.(window.location.origin + orgPath(barePath))?.catch?.(() => {})
    } catch {
      /* noop */
    }
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1600)
  }

  return (
    <MobileFilterContext.Provider value={{ filter: mobileFilter, register: setMobileFilter }}>
      <div className={`app${isListRoute ? '' : ' pushed'}${mounted ? ' mounted' : ''}`}>
        {/* ===== RAIL =====
          No tooltips in here. The `title`s below exist as the collapsed rail's
          fallback labels, not as hints — surfacing them would just repeat the
          label already sitting next to the icon. */}
        <aside data-no-tooltip className={`rail${railCollapsed ? ' collapsed' : ''}${railAnim ? ' rail-anim' : ''}`}>
          <div className="railbrand">
            <Link href={orgPath('/home')} className="railbrand-logo cursor-pointer select-none" aria-label="Go to Home">
              <LogoMark />
              <span className="brandword font-sans text-[17px] font-semibold leading-normal tracking-[-.02em] text-white">
                Agent<span className="text-(--magenta-300)">Connect</span>
              </span>
            </Link>
            <button
              type="button"
              onClick={toggleRail}
              className="railtoggle"
              title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <Icon name={railCollapsed ? 'panel-left-open' : 'panel-left-close'} size={17} />
            </button>
          </div>
          {/* Org picker + "Organization" section label — only in auth mode; the
            no-auth default org needs neither (there's a single implicit org). A
            small spacer keeps the nav off the brand divider when both are gone. */}
          {authOn ? (
            <>
              <OrgSwitcher collapsed={railCollapsed} canCreateOrg={canCreateOrg} />
              <div className="navlbl">Organization</div>
            </>
          ) : (
            <div className="h-3" />
          )}
          {NAV_ITEMS.map((item) => {
            const on = isActive(barePath, item.href)
            return (
              <Link
                key={item.href}
                href={orgPath(item.href)}
                title={item.label}
                className={on ? 'navitem on' : 'navitem'}
              >
                <Icon name={item.icon} size={18} color={on ? '#fff' : undefined} />
                <span>{item.label}</span>
              </Link>
            )
          })}
          {/* Rail footer: Settings (auth mode only, theme toggle lives by the search)
            + a Help & resources menu that opens UPWARD. The help menu shows in every
            mode — the docs/MCP links are useful with or without sign-in. */}
          <div
            className={`mt-auto border-t border-(--border-inverse) ${railCollapsed ? 'flex flex-col items-stretch gap-1 px-2 py-[10px]' : 'flex items-center gap-[6px] px-4 py-[14px]'}`}
          >
            {authOn && (
              <Link
                href={orgPath('/settings')}
                title="Settings"
                className={`${isActive(barePath, '/settings') ? 'navitem on' : 'navitem'} my-0 rounded-[6px] border-l-0 py-[9px] ${railCollapsed ? 'w-full justify-center px-0' : 'flex-1 px-3'}`}
              >
                <Icon name="settings" size={18} color={isActive(barePath, '/settings') ? 'var(--brand)' : undefined} />
                <span>Settings</span>
              </Link>
            )}
            <div className={`relative ${railCollapsed ? 'w-full' : 'flex-none'}`}>
              <button
                type="button"
                onClick={() => setHelpMenu((v) => !v)}
                className={`navitem justify-center rounded-[6px] border-l-0 py-[9px] ${railCollapsed ? 'w-full px-0' : 'w-auto flex-none px-[11px]'}`}
                title="Help & resources"
                aria-label="Help & resources"
              >
                <Icon name="circle-question-mark" size={18} color={helpMenu ? 'var(--brand)' : undefined} />
              </button>
              {helpMenu && (
                <>
                  <div className="fixed inset-0 z-45" onClick={() => setHelpMenu(false)} />
                  <div className="absolute bottom-[calc(100%_+_8px)] left-0 z-50 w-[236px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg)">
                    <button
                      className="dmi"
                      onClick={() => {
                        setHelpMenu(false)
                        setConnectAiOpen(true)
                      }}
                    >
                      <SiModelcontextprotocol className="text-(--text-tertiary)" aria-hidden />
                      Connect your AI
                    </button>
                    <a
                      className="dmi no-underline"
                      href={help.docs}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setHelpMenu(false)}
                    >
                      <Icon name="book-open" size={15} color="var(--text-tertiary)" />
                      Documentation
                    </a>
                    <div className="dmsep" />
                    <button
                      className="dmi"
                      onClick={() => {
                        setHelpMenu(false)
                        setShortcutsOpen(true)
                      }}
                    >
                      <Icon name="command" size={15} color="var(--text-tertiary)" />
                      Keyboard shortcuts
                    </button>
                    <a
                      className="dmi no-underline"
                      href={help.releases}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setHelpMenu(false)}
                    >
                      <Icon name="gift" size={15} color="var(--text-tertiary)" />
                      What&rsquo;s new
                    </a>
                    <a className="dmi no-underline" href={help.support} onClick={() => setHelpMenu(false)}>
                      <Icon name="life-buoy" size={15} color="var(--text-tertiary)" />
                      Help &amp; support
                    </a>
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>

        {/* ===== MAIN ===== */}
        <div className="main">
          <header className="top">
            <div className="crumb min-w-0">
              {showDetailCrumb ? (
                <>
                  <Link
                    href={parentListHref}
                    className="flex-none text-(--text-tertiary) no-underline hover:text-(--text-secondary)"
                  >
                    {crumb}
                  </Link>
                  <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="flex-none" />
                  <b className="min-w-0 truncate">{pushTitle}</b>
                </>
              ) : (
                crumb
              )}
            </div>
            <div className="topspacer flex-1" />
            <GlobalSearch />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            {authOn && <UserMenu display={display} orgPath={orgPath} onSignOut={signOut} />}
          </header>

          {/* ===== MOBILE APP BAR (hidden ≥ tablet) — list-tab vs push variant ===== */}
          <header className="mtop">
            {isListRoute ? (
              <>
                <Link href={orgPath('/home')} className="mtop-logo select-none" aria-label="Go to Home">
                  <LogoMark />
                </Link>
                <span className="mtop-title">{crumb}</span>
                {addKind && (
                  <button className="mappbtn" aria-label="Add" onClick={() => openModal(addKind)}>
                    <Icon name="circle-plus" size={22} />
                  </button>
                )}
                {/* Sessions registers a filter slot; surface it as an app-bar button
                  with a dot when any filter is active (design's Sessions tab). */}
                {barePath === '/sessions' && mobileFilter && (
                  <button className="mappbtn relative" aria-label="Filter sessions" onClick={mobileFilter.open}>
                    <Icon name="sliders-horizontal" size={20} />
                    {mobileFilter.active && (
                      <span className="absolute top-[9px] right-[10px] h-[7px] w-[7px] rounded-full border-[1.5px] border-(--surface-card) bg-(--brand)" />
                    )}
                  </button>
                )}
                <button className="mappbtn" aria-label="Search" onClick={() => setMobileSearch(true)}>
                  <Icon name="search" size={20} />
                </button>
                <button
                  className="mappbtn"
                  aria-label="Toggle theme"
                  title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                  onClick={toggleTheme}
                >
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={20} />
                </button>
                {authOn && (
                  <Link
                    href={orgPath('/profile')}
                    aria-label="Profile"
                    title="Profile"
                    className="ml-[2px] flex-none leading-[0]"
                  >
                    <Avatar src={display.picture} initials={display.initials} size={30} fontSize={11} />
                  </Link>
                )}
              </>
            ) : (
              <>
                <button className="mappbtn" aria-label="Back" onClick={goBack}>
                  <Icon name="arrow-left" size={20} />
                </button>
                <span className="mtop-title">{pushTitle}</span>
                {isSessionDetail && (
                  <button className="mappbtn" aria-label={linkCopied ? 'Link copied' : 'Copy link'} onClick={copyLink}>
                    <Icon
                      name={linkCopied ? 'check' : 'link'}
                      size={20}
                      color={linkCopied ? 'var(--brand)' : undefined}
                    />
                  </button>
                )}
              </>
            )}
          </header>

          <div className="content">
            <SearchOpenContext.Provider value={openSearch}>{children}</SearchOpenContext.Provider>
          </div>

          {/* ===== MOBILE BOTTOM NAV — 4 tabs + More, hidden on push screens ===== */}
          {isListRoute && (
            <nav className="mnav">
              <div className="mnav-tabs">
                {MOBILE_NAV.map((item) => {
                  const on = isActive(barePath, item.href)
                  return (
                    <Link key={item.href} href={orgPath(item.href)} className={on ? 'mnavitem on' : 'mnavitem'}>
                      <Icon name={item.icon} size={20} color={on ? 'var(--magenta-300)' : undefined} />
                      <span>{item.label}</span>
                    </Link>
                  )
                })}
                <button type="button" className="mnavitem" onClick={() => setMobileSheet('more')}>
                  <Icon name="ellipsis" size={20} />
                  <span>More</span>
                </button>
              </div>
              <div className="mnav-home">
                <span className="home-pill" />
              </div>
            </nav>
          )}
        </div>

        {/* ===== MOBILE SHEETS + full-screen search (mobile-only; opened from the nav) ===== */}
        {mobileSheet && (
          <MobileSheets
            which={mobileSheet}
            authOn={authOn}
            orgPath={orgPath}
            orgs={orgs}
            activeOrg={activeOrg}
            setActiveOrg={setActiveOrg}
            openModal={openModal}
            canCreateOrg={canCreateOrg}
            onOpenOrg={() => setMobileSheet('org')}
            onClose={closeSheets}
          />
        )}
        {mobileSearch && <GlobalSearch mobile autoFocus onClose={() => setMobileSearch(false)} />}
        {shortcutsOpen && <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />}
        {connectAiOpen && <ConnectAiModal onClose={() => setConnectAiOpen(false)} moreUrl={help.mcp} />}
        {/* Getting-started pill + drawer (design 1a/1b): a corner checklist derived from
          live state, self-gated (desktop, setup-started, incomplete). */}
        <GettingStarted />
        {/* Renders every `title` in the console on the design system's timing
          instead of the browser's ~1s native tooltip. Portals to <body>. */}
        <TooltipLayer />
      </div>
    </MobileFilterContext.Provider>
  )
}

// Top-bar theme toggle (light ↔ dark). Shared by the console top bar and the onboarding
// header so both flip the same shell-owned theme state.
function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="iconbtn"
      onClick={onToggle}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle theme"
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
    </button>
  )
}

// Avatar button + dropdown (profile / settings / sign out). Self-manages its open state;
// shared by the console top bar and the onboarding header.
function UserMenu({
  display,
  orgPath,
  onSignOut
}: {
  display: { picture?: string | null; initials: string; name: string; email?: string }
  orgPath: (path: string) => string
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer border-0 bg-transparent p-0 leading-[0]"
        title="Your profile"
      >
        <Avatar src={display.picture} initials={display.initials} size={30} fontSize={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="usermenu">
            <div className="usermenu-head">
              <Avatar src={display.picture} initials={display.initials} size={34} fontSize={12} />
              <div className="min-w-0">
                <div className="font-sans text-[13px] font-semibold leading-normal">{display.name}</div>
                {display.email && <div className="mono text-[11px] text-(--text-tertiary)">{display.email}</div>}
              </div>
            </div>
            <Link href={orgPath('/profile')} className="usermenu-item no-underline" onClick={() => setOpen(false)}>
              <Icon name="user" size={15} color="var(--text-tertiary)" />
              Your profile
            </Link>
            <Link href={orgPath('/settings')} className="usermenu-item no-underline" onClick={() => setOpen(false)}>
              <Icon name="settings" size={15} color="var(--text-tertiary)" />
              Settings
            </Link>
            <button className="usermenu-item" onClick={onSignOut}>
              <Icon name="log-out" size={15} color="var(--text-tertiary)" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// The console's keyboard shortcuts, opened from the rail-footer help menu. Only the
// genuinely-wired bindings are listed (⌘K global search + its result navigation);
// Esc closes this dialog. Kept small — a reference card, not a settings surface.
function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const rows: { label: string; keys: string[] }[] = [
    { label: 'Open search from anywhere', keys: ['⌘', 'K'] },
    { label: 'Move through results', keys: ['↑', '↓'] },
    { label: 'Open the selected result', keys: ['↵'] },
    { label: 'Close search or dialog', keys: ['Esc'] }
  ]
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal max-w-[420px]" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <Icon name="command" size={18} color="var(--text-tertiary)" />
          <span className="font-sans text-[15px] font-semibold leading-normal">Keyboard shortcuts</span>
        </div>
        <div className="modalbody flex flex-col">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between border-b border-(--border-subtle) py-[9px] last:border-b-0"
            >
              <span className="font-sans text-[13px] font-normal leading-normal text-(--text-secondary)">
                {r.label}
              </span>
              <span className="flex items-center gap-[5px]">
                {r.keys.map((k) => (
                  <span key={k} className="kbd">
                    {k}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Mobile-only bottom sheets reachable from the nav's "More" tab: the app's overflow
// destinations (Profile/Analytics/Tools & Skills/Settings) + the org switcher — the sole
// mobile entry point for switching / creating orgs (the rail picker is hidden).
function MobileSheets({
  which,
  authOn,
  orgPath,
  orgs,
  activeOrg,
  setActiveOrg,
  openModal,
  canCreateOrg,
  onOpenOrg,
  onClose
}: {
  which: 'more' | 'org'
  authOn: boolean
  orgPath: (p: string) => string
  orgs: OrgDto[]
  activeOrg: OrgDto | null
  setActiveOrg: (id: string) => void
  openModal: (kind: 'createOrg') => void
  canCreateOrg: boolean
  onOpenOrg: () => void
  onClose: () => void
}) {
  const square = (o: OrgDto) => (
    <OrgIconView
      icon={o.icon}
      iconUrl={o.iconUrl}
      label={o.name ?? o.slug}
      fallbackColor={orgColor(o.id)}
      size={32}
      className="rounded-md text-[13px]"
    />
  )
  return (
    <div className="msheet-scrim" onClick={onClose}>
      <div className="msheet" onClick={(e) => e.stopPropagation()}>
        <div className="msheet-handle" />
        {which === 'more' ? (
          <>
            <div className="msheet-eyebrow">More</div>
            {/* Org switcher + Profile/Settings only exist in auth mode. */}
            {authOn && activeOrg && (
              <>
                <button type="button" className="msheet-row" onClick={onOpenOrg}>
                  {square(activeOrg)}
                  <span className="msheet-rowtext">
                    <span className="msheet-rowname">{activeOrg.name ?? activeOrg.slug}</span>
                    <span className="msheet-rowmeta">
                      {orgs.length} organization{orgs.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  <Icon name="chevrons-up-down" size={16} color="var(--text-tertiary)" />
                </button>
                <div className="msheet-divider" />
              </>
            )}
            {MORE_ROWS.filter((r) => authOn || r.href !== '/settings').map((r) => (
              <Link key={r.href} href={orgPath(r.href)} className="msheet-row" onClick={onClose}>
                <Icon name={r.icon} size={20} color="var(--text-tertiary)" />
                <span>{r.label}</span>
              </Link>
            ))}
            <button type="button" className="msheet-cancel" onClick={onClose}>
              Cancel
            </button>
            <div className="msheet-home">
              <span className="home-pill dark" />
            </div>
          </>
        ) : (
          <>
            <div className="msheet-eyebrow">Organization</div>
            {orgs.map((o) => (
              <button
                key={o.id}
                type="button"
                className="msheet-row"
                onClick={() => {
                  setActiveOrg(o.id)
                  onClose()
                }}
              >
                {square(o)}
                <span className="msheet-rowtext">
                  <span className="msheet-rowname">{o.name ?? o.slug}</span>
                </span>
                {o.id === activeOrg?.id && <Icon name="check" size={18} color="var(--brand)" />}
              </button>
            ))}
            {canCreateOrg && (
              <>
                <div className="msheet-divider" />
                <button
                  type="button"
                  className="msheet-row"
                  onClick={() => {
                    onClose()
                    openModal('createOrg')
                  }}
                >
                  <span className="msheet-orgsq dashed">
                    <Icon name="plus" size={16} />
                  </span>
                  <span>Create organization</span>
                </button>
              </>
            )}
            <button type="button" className="msheet-cancel" onClick={onClose}>
              Cancel
            </button>
            <div className="msheet-home">
              <span className="home-pill dark" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
