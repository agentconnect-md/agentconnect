'use client'

// Onboarding step 1 (design: "AgentConnect Onboarding v2" · 01) — the full-screen
// surface a signed-in user with NO organization lands on. Signup no longer mints one,
// so this is where a brand-new account (and anyone who just left or deleted their last
// org) arrives. Creating the org here continues straight into the org-scoped wizard
// (/[slug]/onboarding), which picks up at step 2. Joining someone else's org is served
// by their invite link instead.
//
// Lives OUTSIDE the (app) route group, so it renders bare — the console shell needs
// an active org, which is exactly what the visitor does not have yet.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icon } from '@/components/ui'
import { LogoMark, Spinner } from '@/components/marks'
import { ApiError, createOrg, getMyAccess } from '@/lib/api'
import { getUser, isAuthConfigured, type AuthUser } from '@/lib/auth'
import { orgUrlPrefix } from '@/lib/org-context'

/** Lowercase letters/digits/hyphens — mirrors the CP's OrgSlug shape. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export default function OrgOnboarding() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  // ?new=1 marks a deliberate "create another org" visit from the console's org menu:
  // the orgCount bounce is skipped and a Back affordance returns to the console.
  const [creatingAnother, setCreatingAnother] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Same ordering as the console's own gate: signed out → /login, not admitted yet
  // → /waitlist, already in an org → the console (unless ?new=1). Only a signed-in,
  // admitted caller belongs here.
  useEffect(() => {
    // No-auth OSS mode owns the seeded default org — there is nothing to onboard.
    if (!isAuthConfigured()) {
      router.replace('/')
      return
    }
    const wantsAnother = new URLSearchParams(window.location.search).has('new')
    setCreatingAnother(wantsAnother)
    let active = true
    void (async () => {
      const me = await getUser()
      if (!me) {
        if (active) router.replace('/login')
        return
      }
      if (active) setUser(me)
      try {
        const access = await getMyAccess()
        if (!active) return
        if (access.waitlistMode && access.status !== 'active') {
          router.replace('/waitlist')
          return
        }
        if (access.orgCount > 0 && !wantsAnother) {
          router.replace('/')
          return
        }
      } catch {
        /* fail open — POST /orgs is the authoritative gate */
      }
      if (active) setReady(true)
    })()
    return () => {
      active = false
    }
  }, [router])

  const submit = async () => {
    if (busy) return
    if (!SLUG_RE.test(slug)) {
      setErr(slug ? 'Use lowercase letters, digits, and hyphens only.' : 'Enter a URL name.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const org = await createOrg({ name: name.trim() || undefined, slug })
      // Step 1 done — the org-scoped wizard continues from step 2 (where to run).
      router.replace(`/${org.slug}/onboarding`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr('That URL name is already taken.')
      else setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (!ready)
    return (
      <div className="loadgate flex items-center justify-center">
        <Spinner size={48} />
      </div>
    )

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-(--surface-app)">
      <header className="flex h-14 flex-none items-center gap-[14px] border-b border-(--border-subtle) bg-(--surface-card) px-5 desktop:px-[22px]">
        <span className="flex items-center gap-[10px]">
          <LogoMark size={24} />
          <span className="font-sans text-[16px] font-semibold leading-none tracking-[-.02em] text-(--text-primary)">
            Agent<span className="text-(--brand)">Connect</span>
          </span>
        </span>
        <div className="flex-1" />
        {user && (
          <span className="flex items-center gap-[9px]">
            {user.email && (
              <span className="font-mono text-[12.5px] leading-none text-(--text-tertiary)">{user.email}</span>
            )}
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-(--gray-100) font-sans text-[11px] font-semibold text-(--text-secondary)">
              {user.initials}
            </span>
          </span>
        )}
      </header>

      <div className="flex-1 overflow-auto">
        <div className="flex min-h-full flex-col">
          <div className="flex flex-1 items-center justify-center px-5 py-8 desktop:px-10 desktop:py-11">
            <div className="flex w-full max-w-[640px] flex-col">
              <div className="font-mono text-[12px] font-semibold uppercase leading-none tracking-[.1em] text-(--brand)">
                Step 1 of 2
              </div>
              <h1 className="mt-[10px] font-sans text-[26px] font-semibold leading-[1.15] tracking-[-.02em] text-(--text-primary)">
                Create your organization
              </h1>
              <p className="mt-2 font-sans text-[14px] font-normal leading-[1.5] text-(--text-secondary)">
                Everything — agents, daemons, billing — lives under it.
              </p>
              <div className="mt-7 grid grid-cols-1 items-start gap-4 desktop:grid-cols-2">
                <div className="fld">
                  <span className="fldlbl">Organization slug</span>
                  <div className={`inp justify-start gap-0 ${err ? 'border-(--status-error)' : ''}`}>
                    <span className="flex-none font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                      {orgUrlPrefix()}
                    </span>
                    <input
                      autoFocus
                      className="mono min-w-0 flex-1 border-0 bg-transparent text-[12.5px] normal-nums outline-0 [font-family:inherit]"
                      value={slug}
                      onChange={(e) => {
                        setSlug(e.target.value.toLowerCase())
                        setErr(null)
                      }}
                      placeholder="my-organization"
                    />
                  </div>
                  <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    Lowercase letters and hyphens — appears in the URL.
                  </span>
                </div>
                <div className="fld">
                  <span className="fldlbl">Display name</span>
                  <div className="inp">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Optional"
                      className="min-w-0 flex-1 border-0 bg-transparent outline-0 [font:inherit]"
                    />
                  </div>
                  <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    Shown across the console. Defaults to the slug.
                  </span>
                </div>
              </div>
              {err && (
                <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
                  Could not create — {err}
                </div>
              )}
            </div>
          </div>
          <div className="sticky bottom-0 flex flex-none items-center gap-[10px] border-t border-(--border-subtle) bg-(--surface-card) px-5 py-4 desktop:px-10">
            {creatingAnother && (
              <Button variant="ghost" disabled={busy} onClick={() => router.push('/')}>
                Back
              </Button>
            )}
            <div className="flex-1" />
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? 'Creating…' : 'Continue'}
              <Icon name="arrow-right" size={15} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
