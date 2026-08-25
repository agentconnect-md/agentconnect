'use client'

// Org context — the console's active organization, driven by the URL.
//
// The page tree lives at `app/(app)/[slug]/…`: EVERY console URL is `/{slug}/agents`
// etc., in both modes. The seeded local default org owns the reserved slug `-`
// (never a legal user slug), so no-auth installs read `/-/agents` with zero
// special-casing — it's just an org like any other. An unknown slug (e.g. the
// `/-/…` entry point in a hosted deployment where nobody belongs to the
// default org) falls back to the remembered / first org and fixes the URL.
//
// The resolved org's ID is handed to the API client (`setApiOrgId`) — every
// org-scoped CP call goes to `/orgs/{orgId}/…`.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import {
  fetchOrgs,
  setApiOrgId,
  selectOrg as apiSelectOrg,
  createOrg as apiCreateOrg,
  updateOrg as apiUpdateOrg,
  deleteOrg as apiDeleteOrg,
  removeMember as apiRemoveMember,
  type MemberRole,
  type OrgDto
} from '@/lib/api'
import type { AgentCallPolicy } from '@/lib/data'

// Last-used org slug kept only as a browser fallback for a renamed/unknown
// explicit URL. Bare entries restore the account's server-stored preference;
// a browser-wide cookie must not choose an organization for a different user.
const LAST_SLUG_COOKIE = 'ac.org'

function readLastSlug(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)ac\.org=([^;]+)/)
  return m ? decodeURIComponent(m[1]!) : null
}

function writeLastSlug(slug: string): void {
  try {
    document.cookie = `${LAST_SLUG_COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=31536000; samesite=lax`
  } catch {
    /* cookies unavailable — entries just take the rewrite + client-replace path */
  }
}

/** The console path under the org segment: `/acme/agents` → `/agents`.
 *  During the first-visit rewrite window the address bar may still show a
 *  BARE path (`/agents`, `/`) — only strip the first segment when it really
 *  is the current slug param. */
export function subPath(pathname: string, slug: string): string {
  const [, first, ...rest] = pathname.split('/')
  if (first === slug) return `/${rest.join('/') || 'home'}`
  return pathname === '/' ? '/home' : pathname
}

/** Deep sub-paths built from STATIC segments only, so they still name something in another
 *  org. Everything else deeper than one segment is a detail view of an id scoped to ONE org. */
const PORTABLE_DEEP_PATHS = new Set(['/daemons/cluster'])

/** Where selecting `org` should navigate — or NULL when selecting it is not a switch at all.
 *
 *  Both switchers render the current org as a clickable row, so re-selecting the one you are
 *  already in is a normal click. That is the null case, and it has to come first: the path
 *  rule below sends a detail view home, which on the same org would throw away the page the
 *  user is reading.
 *
 *  On a real switch the sub-path is kept, or replaced by `/home`. A session, agent, cron,
 *  daemon or conversation id belongs to ONE org, so carrying one across lands on the other
 *  org's not-found page — and sessions answer 404 rather than 403, so it is not even a hint
 *  about what was there. Home is the honest destination.
 *
 *  Deny by default, allow the few static deep paths: a new `[id]` route is covered here
 *  without a change, and forgetting to list a new static one only sends someone home.
 *
 *  This is NOT `subPath`'s job — that one also canonicalizes a bare URL inside the SAME org
 *  (`/sessions/abc` → `/acme/sessions/abc`), where dropping the id would break every deep
 *  link into the console. */
export function switchOrgTarget(
  org: { id: string; slug: string },
  activeOrgId: string | undefined,
  pathname: string,
  slug: string
): string | null {
  if (org.id === activeOrgId) return null
  const sub = subPath(pathname, slug)
  const deep = sub.split('/').filter(Boolean).length > 1
  return `/${org.slug}${deep && !PORTABLE_DEEP_PATHS.has(sub) ? '/home' : sub}`
}

/** The URL prefix shown next to the org slug ("appears in the URL") — THIS
 *  deployment's host, not a hardcoded domain. Client-only components call it
 *  after mount, so `window` is present; SSR falls back to a bare slash. */
export function orgUrlPrefix(): string {
  return typeof window !== 'undefined' ? `${window.location.host}/` : '/'
}

// Deterministic org avatar color (design: brand / purple / gold squares).
const ORG_COLORS = ['var(--brand)', '#7c5cbf', '#b3831a', '#2f6fd0', '#0f7a48', '#c05621']

export function orgColor(orgId: string): string {
  let h = 0
  for (let i = 0; i < orgId.length; i++) h = (h * 31 + orgId.charCodeAt(i)) >>> 0
  return ORG_COLORS[h % ORG_COLORS.length]!
}

/** Resolve the organization for the current URL. A real org segment is an
 * explicit choice; a bare entry is a proxy rewrite and must restore the
 * account's server-ordered preference instead of treating the rewritten `-`
 * segment as a choice. */
export function resolveOrgTarget(
  orgs: OrgDto[],
  activeOrg: OrgDto | null,
  lastSlug: string | null,
  hasOrgSegment: boolean
): OrgDto | undefined {
  if (!hasOrgSegment) return orgs[0]
  if (activeOrg) return activeOrg
  return orgs.find((o) => o.slug === lastSlug) ?? orgs[0]
}

interface OrgContextValue {
  /** Every org the user belongs to (empty until loaded / when the CP is down). */
  orgs: OrgDto[]
  /** The org the console is acting on; null until resolved. */
  activeOrg: OrgDto | null
  /** The caller's role in the active org (drives UI gating); null until loaded. */
  myRole: MemberRole | null
  loading: boolean
  /** Initial/list refresh failure. Existing org rows remain usable when present. */
  error: string | null
  /** Prefix a console path with the active org segment (auth mode only):
   *  `/agents` → `/o/acme/agents`. No-auth keeps bare paths. */
  orgPath: (path: string) => string
  /** Switch the active org — navigates to the same page under the new slug. */
  setActiveOrg: (orgId: string) => void
  /** Re-pull `GET /orgs` (after create / settings / membership changes). */
  refreshOrgs: () => Promise<void>
  /** Create an org (caller becomes owner) and switch into it. Display name optional. */
  createOrg: (input: { name?: string; slug: string }) => Promise<OrgDto>
  /** Update org settings (owner-only server-side), then re-sync the URL if needed. */
  updateOrg: (
    orgId: string,
    patch: { name?: string; slug?: string; defaultAgentVisibility?: AgentCallPolicy }
  ) => Promise<void>
  /** Delete an org (owner-only; 409 while it has daemons). The console then
   *  moves to a remaining org — or to org onboarding when that was the last one. */
  deleteOrg: (orgId: string) => Promise<void>
  /** Leave the active org, immediately dropping its stale local scope before
   *  re-listing and moving to a remaining org (or to org onboarding). */
  leaveOrg: (userId: string) => Promise<void>
}

const Ctx = createContext<OrgContextValue | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useParams<{ slug?: string }>()
  const slug = typeof params.slug === 'string' ? decodeURIComponent(params.slug) : '-'

  const [orgs, setOrgs] = useState<OrgDto[]>([])
  const [rememberedOrgId, setRememberedOrgId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refreshOrgs = useCallback(async () => {
    try {
      const next = await fetchOrgs()
      setOrgs(next)
      setRememberedOrgId(next[0]?.id ?? null)
      setError(null)
    } catch (cause) {
      // CP unreachable — leave whatever we had and surface the failure through
      // the provider instead of issuing requests under a fake org id.
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshOrgs()
  }, [refreshOrgs])

  const hasOrgSegment = pathname.split('/')[1] === slug
  // A proxy rewrite can supply the internal `-` param while the visible URL is
  // still bare. It is not an active-org choice until canonicalization finishes.
  const activeOrg = useMemo(
    () => (hasOrgSegment ? (orgs.find((o) => o.slug === slug) ?? null) : null),
    [orgs, slug, hasOrgSegment]
  )

  // Hand the resolved org to the API client DURING render (parent renders
  // before children, so data-context's fetch effects see it; an effect here
  // would run after the children's).
  setApiOrgId(activeOrg?.id ?? null)

  // URL canonicalization: once orgs are known, the address bar must read
  // `/{resolved-slug}/…`. Two cases converge here: an unknown slug (the
  // default-org entry when you don't belong to it, a stale link after a
  // rename, someone else's org) falls back to the last-used org — a rename
  // writes the NEW slug first, so this follows the rename instead of racing
  // it — else the first org; and the first-visit rewrite window, where the
  // bar still shows the bare entered path.
  useEffect(() => {
    if (loading || orgs.length === 0) return
    const target = resolveOrgTarget(orgs, activeOrg, readLastSlug(), hasOrgSegment)
    if (target && pathname.split('/')[1] !== target.slug) {
      router.replace(`/${target.slug}${subPath(pathname, slug)}${window.location.search}`)
    }
  }, [loading, orgs, activeOrg, hasOrgSegment, slug, pathname, router])

  // Remember an explicit org URL. During a bare-entry proxy rewrite, `slug`
  // can be `-` without the user having selected it, so wait for canonicalization.
  useEffect(() => {
    if (!activeOrg || !hasOrgSegment) return
    writeLastSlug(activeOrg.slug)
    // A different explicit URL is a new choice. Track successful writes
    // separately from the list so a quick B → A switch cannot mistake stale
    // ordering for the server's current preference.
    if (rememberedOrgId !== activeOrg.id) {
      void apiSelectOrg(activeOrg.id)
        .then(() => {
          setRememberedOrgId(activeOrg.id)
          setOrgs((prev) => {
            if (prev[0]?.id === activeOrg.id) return prev
            const selected = prev.find((org) => org.id === activeOrg.id)
            return selected ? [selected, ...prev.filter((org) => org.id !== selected.id)] : prev
          })
        })
        .catch(() => {})
    }
  }, [activeOrg, hasOrgSegment, rememberedOrgId])

  const orgPath = useCallback((path: string) => `/${activeOrg?.slug ?? slug}${path}`, [activeOrg, slug])

  const setActiveOrg = useCallback(
    (orgId: string) => {
      const org = orgs.find((o) => o.id === orgId)
      if (!org) return
      const target = switchOrgTarget(org, activeOrg?.id, pathname, slug)
      if (!target) return
      writeLastSlug(org.slug)
      router.push(target)
    },
    [orgs, activeOrg, pathname, slug, router]
  )

  const createOrg = useCallback(
    async (input: { name?: string; slug: string }) => {
      const org = await apiCreateOrg(input)
      // Append optimistically BEFORE switching so activeOrg never goes null.
      setOrgs((prev) => (prev.some((candidate) => candidate.id === org.id) ? prev : [...prev, org]))
      // A brand-new org holds nothing at all, so the same rule applies even more plainly —
      // and it is never the active one, so the no-op arm cannot fire here.
      writeLastSlug(org.slug)
      router.push(switchOrgTarget(org, undefined, pathname, slug)!)
      await refreshOrgs()
      return org
    },
    [pathname, slug, refreshOrgs, router]
  )

  const updateOrg = useCallback(
    async (orgId: string, patch: { name?: string; slug?: string; defaultAgentVisibility?: AgentCallPolicy }) => {
      const updated = await apiUpdateOrg(orgId, patch)
      // Record the new slug BEFORE the list refreshes — the URL reconciliation
      // effect fires on the refreshed list (old slug now unknown) and must
      // resolve to the renamed org, not fall back to the first one.
      const reslugged = activeOrg?.id === orgId && patch.slug && patch.slug !== activeOrg.slug
      if (reslugged) writeLastSlug(updated.slug)
      await refreshOrgs()
      if (reslugged) {
        router.replace(`/${updated.slug}${subPath(pathname, slug)}`)
      }
    },
    [activeOrg, pathname, slug, refreshOrgs, router]
  )

  const deleteOrg = useCallback(
    async (orgId: string) => {
      await apiDeleteOrg(orgId)
      // Re-list. If the ACTIVE org was deleted, its slug no longer resolves and the
      // unknown-slug reconciliation moves the console to a remaining org; an empty
      // list sends the shell to org onboarding.
      await refreshOrgs()
    },
    [refreshOrgs]
  )

  const leaveOrg = useCallback(
    async (userId: string) => {
      if (!activeOrg) throw new Error('no active organization')
      const departedOrgId = activeOrg.id
      await apiRemoveMember(userId)
      // Authorization is gone once DELETE commits. Drop the stale local row
      // before the network refresh so a transient list failure cannot keep
      // issuing requests under an organization the caller no longer belongs to.
      setOrgs((prev) => prev.filter((org) => org.id !== departedOrgId))
      await refreshOrgs()
    },
    [activeOrg, refreshOrgs]
  )

  const value = useMemo<OrgContextValue>(
    () => ({
      orgs,
      activeOrg,
      myRole: activeOrg?.role ?? null,
      loading,
      error,
      orgPath,
      setActiveOrg,
      refreshOrgs,
      createOrg,
      updateOrg,
      deleteOrg,
      leaveOrg
    }),
    [orgs, activeOrg, loading, error, orgPath, setActiveOrg, refreshOrgs, createOrg, updateOrg, deleteOrg, leaveOrg]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOrgs(): OrgContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useOrgs must be used within <OrgProvider>')
  return ctx
}
