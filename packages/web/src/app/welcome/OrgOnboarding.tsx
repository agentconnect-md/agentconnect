'use client'

// PLACEHOLDER org onboarding — the full-screen surface a signed-in user with NO
// organization lands on. Signup no longer mints one, so this is where a brand-new
// account (and anyone who just left or deleted their last org) arrives. The real
// onboarding experience is being designed separately; until it lands this keeps the
// path walkable with the one step that cannot be skipped: name an organization and
// enter it. Joining someone else's is already served by their invite link.
//
// Lives OUTSIDE the (app) route group, so it renders bare — the console shell needs
// an active org, which is exactly what the visitor does not have yet.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { ApiError, createOrg, getMyAccess } from '@/lib/api'
import { getUser, isAuthConfigured } from '@/lib/auth'
import { orgUrlPrefix } from '@/lib/org-context'

/** Lowercase letters/digits/hyphens — mirrors the CP's OrgSlug shape. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export default function OrgOnboarding() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Same ordering as the console's own gate: signed out → /login, not admitted yet
  // → /waitlist, already in an org → the console. Only a signed-in, admitted,
  // org-less caller belongs here.
  useEffect(() => {
    // No-auth OSS mode owns the seeded default org — there is nothing to onboard.
    if (!isAuthConfigured()) {
      router.replace('/')
      return
    }
    let active = true
    void (async () => {
      if (!(await getUser())) {
        if (active) router.replace('/login')
        return
      }
      try {
        const access = await getMyAccess()
        if (!active) return
        if (access.waitlistMode && access.status !== 'active') {
          router.replace('/waitlist')
          return
        }
        if (access.orgCount > 0) {
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
      router.replace(`/${org.slug}/home`)
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
    <div className="authpage">
      <div className="w-full max-w-[460px] rounded-[16px] border border-(--border-default) bg-(--surface-card) p-[38px] shadow-(--shadow-lg)">
        <Wordmark height={26} />
        <h1 className="atitle mt-[26px]">Create your organization</h1>
        <p className="asub">
          Everything in AgentConnect — daemons, agents, integrations, members — belongs to an organization. Create one
          to get started, or open the invite link a teammate sent you to join theirs.
        </p>
        <div className="fld mt-[26px]">
          <span className="fldlbl">URL name</span>
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
        <div className="fld mt-[14px]">
          <span className="fldlbl">Display name (optional)</span>
          <div className="inp">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Organization"
              className="min-w-0 flex-1 border-0 bg-transparent outline-0 [font:inherit]"
            />
          </div>
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
            Could not create — {err}
          </div>
        )}
        <Button className="mt-[22px] w-full" onClick={() => void submit()}>
          <Icon name="building-2" size={14} />
          {busy ? 'Creating…' : 'Create organization'}
        </Button>
      </div>
    </div>
  )
}
