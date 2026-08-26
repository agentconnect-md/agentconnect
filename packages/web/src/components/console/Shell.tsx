'use client'

// The console shell: the persistent rail that wraps every route, plus the auth gate
// and the data/playground/modal providers. Replaces the old in-component `page`
// switch — navigation is now real routing (<Link> + usePathname), so each view lives
// at its own URL.
//
// Desktop is a pure left/right split (design v2): the rail carries the brand, the
// search trigger, navigation and the account block, and the main column is content
// only — no top bar, no breadcrumb, no back-link. Mobile keeps its own app bar
// (`.mtop`), which is where the section/entity title still shows.

import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { SiModelcontextprotocol } from 'react-icons/si'
import { SWRConfig, type SWRConfiguration } from 'swr'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ConsoleDataProvider, useConsoleData } from '@/lib/data-context'
import { OrgProvider, useOrgs, orgColor, subPath } from '@/lib/org-context'
import { ApiError, getMyAccess, type OrgDto } from '@/lib/api'
import { agentLabel, poolLabel } from '@/lib/data'
import { detailCrumb, type CrumbSlot } from '@/lib/crumb'
import { PlaygroundProvider } from './PlaygroundProvider'
import { ModalProvider, useModal } from './ModalProvider'
import ConnectAiModal from './ConnectAiModal'
import GettingStarted, { openGettingStarted } from './GettingStarted'
import { GlobalSearch } from './GlobalSearch'
import { TooltipLayer } from './Tooltip'
import { SearchOpenContext } from './search-open'
import { LoadingState, LogoMark, OrgIconView } from '@/components/marks'
import { Avatar, Icon } from '@/components/ui'
import { getUser, isAuthConfigured, logout } from '@/lib/auth'
import { useProfile } from '@/lib/profile'
import { useIsMobile } from '@/lib/use-is-mobile'
import { applyTheme, clearThemeAttr, getStoredTheme, type Theme } from '@/lib/theme'
import { isFlatSessionView, sessionListSearchParams } from '@/lib/session-list-view'
import { NotificationProvider } from '@/lib/notifications'
import { NotificationBell, NotificationToastContainer } from './NotificationCenter'
import { useDaemonNotifier } from '@/lib/daemon-notifications'
import { useSessionAccessNotifier } from '@/lib/session-access-notifier'
import { useBillingSuspensionNotifier } from '@/lib/billing-notifications'
import { MOBILE_NAV, MORE_ROWS, NAV_GROUPS, SECTIONS, navVisible } from './nav'

// Top-level routes own the tab-bar + list app bar (no back button, bottom nav shown);
// every other route is a "push" screen (back-button app bar, no bottom nav) on mobile.
// Home is a top-level surface (the default landing), not a push screen.
const LIST_ROUTES = ['/home', '/agents', '/sessions', '/crons', '/daemons']
const CONSOLE_SWR_CONFIG = {
  dedupingInterval: 2_000,
  focusThrottleInterval: 5_000,
  shouldRetryOnError: (error: unknown) =>
    !(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500
} satisfies SWRConfiguration

interface GithubCallbackNotice {
  message: string
  tone: 'success' | 'warning'
}

function githubCallbackNotice(code: string): GithubCallbackNotice | null {
  if (code === 'installed') {
    return { message: 'GitHub installation connected.', tone: 'success' }
  }
  if (code === 'pending-approval') {
    return {
      message:
        'GitHub is waiting for an organization administrator to approve this installation. After approval, choose Install on GitHub again to finish connecting it.',
      tone: 'warning'
    }
  }
  if (code === 'retry-install') {
    return {
      message:
        'AgentConnect could not verify which organization this GitHub installation belongs to. Choose Install on GitHub again to restart the connection.',
      tone: 'warning'
    }
  }
  return null
}

// The per-list-tab "+" action → which modal it opens.
const ADD_KIND: Record<string, 'agent' | 'cron' | 'daemon'> = {
  '/agents': 'agent',
  '/crons': 'cron',
  '/daemons': 'daemon'
}

const isActive = (pathname: string, href: string) =>
  pathname === href ||
  pathname.startsWith(href + '/') ||
  // /conversations/:key is the Sessions section's merged detail page.
  (href === '/sessions' && pathname.startsWith('/conversations/'))

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
  support: 'mailto:contact@agentconnect.md'
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
  const qs = sessionListSearchParams(new URLSearchParams(search)).toString()
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

// The same slot idea for ONE push-screen app-bar action: the session detail's
// right rail fills it so its list can be opened from the app bar on mobile, where
// the rail has no column to live in. The shell owns the bar, so a view cannot just
// float a button there — a fixed overlay would sit on top of `.mtop-title`.
// The panel itself stays with the view that registered the slot.
export interface MobileActionSlot {
  icon: string
  label: string
  /** Lights the button while the view's panel is open. */
  active: boolean
  onClick: () => void
}
const MobileActionContext = createContext<{
  action: MobileActionSlot | null
  register: (a: MobileActionSlot | null) => void
}>({ action: null, register: () => {} })
export const useMobileActionSlot = () => useContext(MobileActionContext)

// The same slot idea for the detail crumb: the view that hydrates its own row publishes
// title + status here while mounted, and the shell's crumb prefers it over the list
// lookup. See lib/crumb.ts for why the lists can't carry this on their own.
const CrumbContext = createContext<{ register: (s: CrumbSlot | null) => void }>({ register: () => {} })
export const useCrumbSlot = () => useContext(CrumbContext)

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

// Rail-footer account block (design v2's `pf.*`) — auth mode only.
//
// With the top bar deleted this is the console's single identity surface, so its
// menu collects everything that used to be spread across the chrome: the org
// switcher that sat at the TOP of the rail, the top-bar avatar menu's Profile /
// Settings / Sign out, the rail's Settings link, and the top-bar theme toggle.
// The button face carries the two facts you need at a glance — who you are and
// which org you are acting in.
function RailAccount({
  display,
  collapsed,
  orgs,
  activeOrg,
  setActiveOrg,
  orgPath,
  onCreateOrg,
  canCreateOrg,
  theme,
  onToggleTheme,
  onSignOut
}: {
  display: { picture?: string | null; initials: string; name: string; email?: string }
  collapsed: boolean
  orgs: OrgDto[]
  activeOrg: OrgDto | null
  setActiveOrg: (id: string) => void
  orgPath: (path: string) => string
  /** Routes to /welcome?new=1 — org creation is step 1 of the onboarding flow. */
  onCreateOrg: () => void
  canCreateOrg: boolean
  theme: Theme
  onToggleTheme: () => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const orgName = activeOrg ? (activeOrg.name ?? activeOrg.slug) : ''

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pfbtn"
        title={collapsed ? display.name : 'Account'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="pfav relative">
          <Avatar src={display.picture} initials={display.initials} size={26} fontSize={10} />
          {/* The active org rides the avatar as a corner badge — its own uploaded icon
          when it has one, else its color + initial. Ringed in the rail's plum so it
          reads as a badge stamped on the avatar rather than a second avatar beside it,
          and it is the only org cue left once the rail collapses and the name goes. */}
          {activeOrg && (
            <OrgIconView
              icon={activeOrg.icon}
              iconUrl={activeOrg.iconUrl}
              label={orgName}
              fallbackColor={orgColor(activeOrg.id)}
              size={14}
              className="absolute -right-[3px] -bottom-[3px] rounded-[4px] text-[8px] ring-2 ring-(--surface-inverse)"
            />
          )}
        </span>
        <span className="pfname min-w-0 flex-1 overflow-hidden">
          <span className="block truncate font-sans text-[12.5px] font-semibold leading-normal text-white">
            {display.name}
          </span>
          {orgName && (
            <span className="mono block truncate text-[10.5px] font-medium text-(--text-inverse-dim)">{orgName}</span>
          )}
        </span>
        {/* Collapsed the rail has no room for it, and the badge above already says
        which org — so the switch affordance rides with the name, not the avatar. */}
        {!collapsed && <Icon name="chevrons-up-down" size={14} color="var(--text-inverse-dim)" className="flex-none" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-45" onClick={() => setOpen(false)} />
          <div className="absolute bottom-[calc(100%_+_8px)] left-0 z-50 w-[238px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg)">
            {display.email && (
              <div className="mono truncate px-3 pt-2 pb-[6px] text-[11px] text-(--text-tertiary)">{display.email}</div>
            )}
            {orgs.map((o) => (
              <button
                key={o.id}
                className="dmi justify-between"
                onClick={() => {
                  setActiveOrg(o.id)
                  setOpen(false)
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-[9px]">
                  <OrgIconView
                    icon={o.icon}
                    iconUrl={o.iconUrl}
                    label={o.name ?? o.slug}
                    fallbackColor={orgColor(o.id)}
                    size={22}
                    className="rounded-[5px] text-[11px]"
                  />
                  <span className="truncate">{o.name ?? o.slug}</span>
                </span>
                {o.id === activeOrg?.id && <Icon name="check" size={15} color="var(--brand)" className="flex-none" />}
              </button>
            ))}
            {canCreateOrg && (
              <button
                className="dmi"
                onClick={() => {
                  setOpen(false)
                  onCreateOrg()
                }}
              >
                <Icon name="plus" size={15} color="var(--text-tertiary)" />
                Create organization
              </button>
            )}
            <div className="dmsep" />
            <Link href={orgPath('/profile')} className="dmi no-underline" onClick={() => setOpen(false)}>
              <Icon name="circle-user-round" size={15} color="var(--text-tertiary)" />
              Profile
            </Link>
            <Link href={orgPath('/settings')} className="dmi no-underline" onClick={() => setOpen(false)}>
              <Icon name="settings" size={15} color="var(--text-tertiary)" />
              Organization settings
            </Link>
            <div className="dmsep" />
            <button className="dmi" onClick={onToggleTheme}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} color="var(--text-tertiary)" />
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <div className="dmsep" />
            <button className="dmi" onClick={onSignOut}>
              <Icon name="log-out" size={15} color="var(--text-tertiary)" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ShellChrome({ children }: { children: ReactNode }) {
  const { activeOrg } = useOrgs()
  return (
    <NotificationProvider orgId={activeOrg?.id}>
      <ShellChromeInner>{children}</ShellChromeInner>
    </NotificationProvider>
  )
}

function ShellChromeInner({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const params = useParams<{ slug?: string }>()
  const { orgPath, orgs, activeOrg, setActiveOrg, loading: orgsLoading, error: orgsError } = useOrgs()
  const { openModal } = useModal()
  const { daemons, agents, crons, allSessions, memberSets, sessionAccessSnapshot, usageAccessSnapshot } =
    useConsoleData()
  useDaemonNotifier(daemons)
  useSessionAccessNotifier({ sessionAccessSnapshot, usageAccessSnapshot, orgPath })
  useBillingSuspensionNotifier(activeOrg?.id ?? null, orgPath)
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
  // Push-screen app-bar action the current view registers (the session rail's list).
  const [mobileAction, setMobileAction] = useState<MobileActionSlot | null>(null)
  // Status slot the session detail view registers so the crumb can badge it.
  const [crumbSlot, setCrumbSlot] = useState<CrumbSlot | null>(null)
  // Active/crumb matching runs on the console path WITHOUT the org segment
  // (`/acme/agents` → `/agents`); hrefs go the other way via orgPath().
  const barePath = subPath(pathname, typeof params.slug === 'string' ? decodeURIComponent(params.slug) : '-')
  const router = useRouter()
  // Creating an org is step 1 of the onboarding flow — the menu entries route there
  // (?new=1 marks a deliberate extra-org visit so /welcome doesn't bounce back).
  const goCreateOrg = () => router.push('/welcome?new=1')
  // Rail-footer help popover + the shortcuts modal it can open.
  const [helpMenu, setHelpMenu] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [connectAiOpen, setConnectAiOpen] = useState(false)
  const [githubNotice, setGithubNotice] = useState<GithubCallbackNotice | null>(null)
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
  // yet, bounce to /waitlist; when the caller belongs to no organization at all,
  // bounce to /welcome — and keep the gate spinner either way (never flash the
  // console). No-auth OSS mode is left untouched. Fails OPEN on a transient
  // /me/access error — the server still enforces the gate on every write.
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
        // Signup mints no org, so belonging to none is an ordinary new-account
        // state — org onboarding, not a console with nothing to scope requests to.
        if (access.orgCount === 0) {
          router.replace('/welcome')
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

  // The GitHub setup callback returns through the bare console entry. Wait for
  // OrgProvider to canonicalize that entry before removing the one-shot result
  // parameter, otherwise two competing router.replace calls can lose the org URL.
  const githubCallback = searchParams.get('github')
  useEffect(() => {
    if (!activeOrg || !githubCallback) return
    const notice = githubCallbackNotice(githubCallback)
    if (notice) setGithubNotice(notice)
    const next = new URLSearchParams(searchParams.toString())
    next.delete('github')
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false })
  }, [activeOrg, githubCallback, pathname, router, searchParams])

  // Losing the LAST org (deleting it, or leaving it) empties every console scope —
  // the same place a fresh account starts. The gate above only runs once per mount,
  // so this watches the live list; a failed or in-flight /orgs must not trigger it.
  useEffect(() => {
    if (!isAuthConfigured() || !authReady || orgsLoading || orgsError != null) return
    if (orgs.length === 0) router.replace('/welcome')
  }, [authReady, orgs, orgsLoading, orgsError, router])

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
  const listTitle = (() => {
    if (seg.length < 2) return undefined
    const [section, id] = seg
    if (section === 'agents') {
      const agent = agents.find((a) => a.id === id)
      return agent ? agentLabel(agent) : undefined
    }
    if (section === 'daemons') {
      // `cluster` is the pool's own page, not a daemon id — no member id survives a rollout —
      // and `groups/<setId>` is a placement target rather than a machine, so neither resolves
      // against the daemon list.
      if (id === 'cluster') return poolLabel()
      if (id === 'groups') return memberSets.find((g) => g.setId === seg[2])?.name
      return daemons.find((d) => d.daemonId === id)?.name
    }
    if (section === 'sessions') return allSessions.find((s) => s.id === id)?.title
    if (section === 'crons') return crons.find((c) => c.id === id)?.name
    return undefined
  })()
  // The slot beats the list lookup, but only on the route it describes — see lib/crumb.ts.
  // Only the title is consumed now: the desktop crumb (which also carried the status
  // badge) is gone, and the mobile app bar shows the title alone.
  const { title: pushTitle } = detailCrumb(crumb, seg[1], listTitle ?? undefined, crumbSlot)

  // Back from a push screen: pop in-app history when there is any, else (deep-link /
  // hard refresh — no history) route to the parent list so "back" never leaves the app.
  const hasParentList = LIST_ROUTES.includes(`/${seg[0] ?? ''}`)
  const parentList = hasParentList ? `/${seg[0]}` : '/home'
  const parentListHref = orgPath(parentList + (seg[0] === 'sessions' ? sessionFilterSearch(locationSearch) : ''))
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
      const suffix = isFlatSessionView(searchParams) ? '?view=flat' : ''
      void navigator.clipboard?.writeText?.(window.location.origin + orgPath(`${barePath}${suffix}`))?.catch?.(() => {})
    } catch {
      /* noop */
    }
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1600)
  }

  return (
    <MobileFilterContext.Provider value={{ filter: mobileFilter, register: setMobileFilter }}>
      <MobileActionContext.Provider value={{ action: mobileAction, register: setMobileAction }}>
        <CrumbContext.Provider value={{ register: setCrumbSlot }}>
          <div className={`app${isListRoute ? '' : ' pushed'}${mounted ? ' mounted' : ''}`}>
            {/* ===== RAIL =====
          Only collapsed, icon-only controls get titles; the global layer turns
          those titles into the console's themed tooltips. */}
            <aside className={`rail${railCollapsed ? ' collapsed' : ''}${railAnim ? ' rail-anim' : ''}`}>
              <div className="railbrand">
                <Link
                  href={orgPath('/home')}
                  className="railbrand-logo cursor-pointer select-none"
                  aria-label="Go to Home"
                >
                  <LogoMark size={24} />
                  <span className="brandword font-sans text-[16px] font-semibold leading-normal tracking-[-.02em] text-white">
                    Agent<span className="text-(--magenta-300)">Connect</span>
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={toggleRail}
                  className="railiconbtn railtoggle"
                  // No `title`: the icon already reads as the collapse/expand affordance,
                  // and a tooltip on the collapsed rail's own toggle is noise. Screen
                  // readers still get the state from aria-label.
                  aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                  <Icon name={railCollapsed ? 'panel-left-open' : 'panel-left-close'} size={16} />
                </button>
                {/* Search sits at the rail's outer edge, permanently visible — with no
              top bar it is the console's only search affordance, so unlike the
              collapse toggle beside it, it never hides. Collapsed, CSS swaps it for
              the `.railsrnav` row below. */}
                <button
                  type="button"
                  onClick={openSearch}
                  className="railiconbtn railsrbtn"
                  title="Search"
                  aria-label="Search"
                >
                  <Icon name="search" size={16} />
                </button>
              </div>
              {/* The search dialog itself. It renders in the rail so the trigger and the
            dialog share one component; `rail` re-seats the open state as a centred
            command palette (globals.css `.railsr`). */}
              <GlobalSearch rail />
              <button
                type="button"
                onClick={openSearch}
                className="navitem railsrnav"
                title="Search"
                aria-label="Search"
              >
                <Icon name="search" size={18} />
                <span>Search</span>
              </button>
              {NAV_GROUPS.map((g) => g.filter(navVisible)).map((group, groupIndex) => (
                <Fragment key={group[0]?.href ?? groupIndex}>
                  {groupIndex > 0 && <div className="navsep" />}
                  {group.map((item) => {
                    const on = isActive(barePath, item.href)
                    return (
                      <Link
                        key={item.href}
                        href={orgPath(item.href)}
                        title={railCollapsed ? item.label : undefined}
                        className={on ? 'navitem on' : 'navitem'}
                      >
                        {/* No inline color — `.navitem.on svg` tints the active glyph brand. */}
                        <Icon name={item.icon} size={18} />
                        <span>{item.label}</span>
                      </Link>
                    )
                  })}
                </Fragment>
              ))}
              {/* Rail footer. In auth mode this is the account block: avatar + name +
            active org, whose menu carries everything the deleted top bar used to —
            org switching, Profile, Settings, the theme toggle, sign-out. No-auth has
            no identity and one implicit org, so it keeps just the theme toggle. The
            Help menu shows in both modes — the docs links are useful either way. */}
              <div className="railfoot">
                {authOn ? (
                  <RailAccount
                    display={display}
                    collapsed={railCollapsed}
                    orgs={orgs}
                    activeOrg={activeOrg}
                    setActiveOrg={setActiveOrg}
                    orgPath={orgPath}
                    onCreateOrg={goCreateOrg}
                    canCreateOrg={canCreateOrg}
                    theme={theme}
                    onToggleTheme={toggleTheme}
                    onSignOut={signOut}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="railiconbtn"
                    title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                    aria-label="Toggle theme"
                  >
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                  </button>
                )}
                <div
                  className={
                    railCollapsed ? 'flex flex-none justify-center' : 'mr-[-3px] flex flex-none justify-center'
                  }
                >
                  <NotificationBell variant="rail" />
                </div>
                {/* Same 22px box as the brand row's search button, and the same 2px
              inset from the rail's edge — the two sit on one vertical centre line. */}
                <div className="railhelp relative mr-[2px] flex-none">
                  <button
                    type="button"
                    onClick={() => setHelpMenu((v) => !v)}
                    className="railiconbtn"
                    title="Help & resources"
                    aria-label="Help & resources"
                  >
                    <Icon name="circle-question-mark" size={16} color={helpMenu ? 'var(--brand)' : undefined} />
                  </button>
                  {helpMenu && (
                    <>
                      <div className="fixed inset-0 z-45" onClick={() => setHelpMenu(false)} />
                      <div className="absolute bottom-[calc(100%_+_8px)] left-0 z-50 w-[236px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg)">
                        {/* The desktop way back to a skipped checklist, both auth modes — the
                          pill has no other desktop re-entry point. Owner-only, like the
                          checklist itself. */}
                        {activeOrg?.role === 'owner' && (
                          <button
                            className="dmi"
                            onClick={() => {
                              setHelpMenu(false)
                              openGettingStarted()
                            }}
                          >
                            <Icon name="rocket" size={15} color="var(--text-tertiary)" />
                            Getting started
                          </button>
                        )}
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

            {/* ===== MAIN =====
          Desktop has NO top bar (design v2 is a pure left/right split): no breadcrumb,
          no parent back-link, no title strip. The rail states where you are, and each
          detail view owns its own heading. Mobile still needs one — `.mtop` below. */}
            <div className="main">
              {githubNotice && (
                <div
                  role={githubNotice.tone === 'warning' ? 'alert' : 'status'}
                  className="fixed top-[72px] right-4 left-4 z-50 flex items-start gap-3 rounded-md border border-(--border-default) bg-(--surface-card) p-4 shadow-(--shadow-md) desktop:top-4 desktop:left-auto desktop:w-[460px]"
                >
                  <Icon
                    name={githubNotice.tone === 'success' ? 'circle-check' : 'triangle-alert'}
                    size={16}
                    color={githubNotice.tone === 'success' ? 'var(--status-online)' : 'var(--amber-500)'}
                    className="mt-[1px] flex-none"
                  />
                  <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    {githubNotice.message}
                  </span>
                  {authOn ? (
                    <Link
                      href={orgPath('/settings')}
                      className="lnk flex-none text-[12px]"
                      onClick={() => setGithubNotice(null)}
                    >
                      Organization settings
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="lnk flex-none text-[12px]"
                      onClick={() => {
                        setGithubNotice(null)
                        openModal('agent')
                      }}
                    >
                      Add agent
                    </button>
                  )}
                  <button
                    type="button"
                    className="iconbtn -m-1 h-7 w-7 flex-none"
                    aria-label="Dismiss GitHub installation notice"
                    onClick={() => setGithubNotice(null)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              )}
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
                    <NotificationBell variant="mobile" />
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
                    {mobileAction && (
                      <button
                        className={`mappbtn${mobileAction.active ? ' text-(--brand)' : ''}`}
                        aria-label={mobileAction.label}
                        aria-expanded={mobileAction.active}
                        onClick={mobileAction.onClick}
                      >
                        <Icon
                          name={mobileAction.icon}
                          size={20}
                          color={mobileAction.active ? 'var(--brand)' : undefined}
                        />
                      </button>
                    )}
                    {isSessionDetail && (
                      <button
                        className="mappbtn"
                        aria-label={linkCopied ? 'Link copied' : 'Copy link'}
                        onClick={copyLink}
                      >
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
                onCreateOrg={goCreateOrg}
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
            <NotificationToastContainer />
            <TooltipLayer />
          </div>
        </CrumbContext.Provider>
      </MobileActionContext.Provider>
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
              Organization settings
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
  onCreateOrg,
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
  onCreateOrg: () => void
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
            {MORE_ROWS.filter((r) => navVisible(r) && (authOn || r.href !== '/settings')).map((r) => (
              <Link key={r.href} href={orgPath(r.href)} className="msheet-row" onClick={onClose}>
                <Icon name={r.icon} size={20} color="var(--text-tertiary)" />
                <span>{r.label}</span>
              </Link>
            ))}
            {/* The rail (and both of its re-entry menus) is hidden at mobile widths, so
                this is the phone/tablet way back to a skipped checklist — both auth modes.
                Owner-only, like the checklist itself. */}
            {activeOrg?.role === 'owner' && (
              <button
                type="button"
                className="msheet-row"
                onClick={() => {
                  onClose()
                  openGettingStarted()
                }}
              >
                <Icon name="rocket" size={20} color="var(--text-tertiary)" />
                <span>Getting started</span>
              </button>
            )}
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
                    onCreateOrg()
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
