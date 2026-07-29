'use client'

// Your-profile page (design: `isProfile`). Identity (name/email/initials) is the
// real signed-in OIDC user when auth is configured, else a neutral placeholder
// (the design's demo persona only in mock mode) — same fallback the shell header
// uses. Role / workspace access / member-since are the signed-in user's REAL
// membership (matched by email in GET /members, same store as the Settings page —
// the two must agree). Personal access tokens and "last active" have no backend
// yet: they render the design's demo values only in mock mode, otherwise empty / '—'.

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar, Button, Icon } from '@/components/ui'
import { useModal } from '@/components/console/ModalProvider'
import ApiKeysCard from '@/components/console/ApiKeysCard'
import SocialSignInCard from '@/components/console/SocialSignInCard'
import SlackConfigCard from '@/components/console/SlackConfigCard'
import { isAuthConfigured, logout } from '@/lib/auth'
import { useProfile } from '@/lib/profile'
import { MOCK_MODE } from '@/lib/data'
import { useIsMobile } from '@/lib/use-is-mobile'
import { useOrgs } from '@/lib/org-context'
import { fmtDate, ROLE_LABELS } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { takeAccountNotice, type AccountNotice } from '@/lib/logto-account'

function KvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row grid-cols-[1fr_auto]">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      {children}
    </div>
  )
}

export default function ProfileView() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const { openModal } = useModal()
  const { activeOrg, orgs } = useOrgs()
  const { members } = useConsoleData()
  // Merged identity (token claims + the CP /me overlay) — repaints live when
  // the edit-profile dialog saves a new name/photo.
  const { user, me: meProfile } = useProfile()
  const authOn = isAuthConfigured()
  // ProfileView survives its desktop-first hydration switch to the mobile tree,
  // so it owns the one-shot callback notice instead of either short-lived card.
  const [socialNotice, setSocialNotice] = useState<AccountNotice>()
  useEffect(() => setSocialNotice(takeAccountNotice()), [])
  // The signed-in user's membership — the same row the Settings page lists.
  // Matched by userId when the CP profile is known (exact), by email otherwise.
  // With no match (mock mode / CP down) the fields fall back to the design's
  // demo values in mock mode, otherwise a neutral '—'.
  const me = meProfile
    ? members.find((m) => m.userId === meProfile.userId)
    : members.find((m) => m.email && user.email && m.email.toLowerCase() === user.email.toLowerCase())
  const roleLabel = me ? ROLE_LABELS[me.role] : MOCK_MODE ? 'Owner' : '—'
  const owner = me ? me.role === 'owner' : MOCK_MODE
  const roleBadge = owner ? 'bg-(--brand-soft) text-(--brand)' : 'bg-(--surface-active) text-(--text-secondary)'
  const memberSince = me ? fmtDate(me.joinedAt) : MOCK_MODE ? 'Jan 12, 2026' : '—'

  // Build fingerprint (version · git sha · build time), injected at build time in
  // next.config.mjs. Rendered as a hidden, select-to-reveal line (.buildinfo).
  const buildStamp = [process.env.NEXT_PUBLIC_APP_VERSION, process.env.NEXT_PUBLIC_BUILD_TIME]
    .filter(Boolean)
    .join(' · built ')

  const signOut = () => {
    if (authOn) void logout()
    else router.push('/login')
  }

  if (isMobile) {
    const cardShell =
      'overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)'
    const cardHead = 'border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal'

    return (
      <div className="pt-4 pb-6">
        {/* Hero identity row — Edit sits at the top-right corner */}
        <div className="flex items-start gap-[14px] border-b border-(--border-subtle) bg-(--surface-card) px-4 py-[14px]">
          <Avatar src={user.picture} initials={user.initials} size={64} fontSize={20} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-sans text-[20px] font-semibold leading-normal tracking-[-.02em]">{user.name}</span>
              <span
                className={`inline-flex rounded-full px-[10px] py-[3px] font-sans text-[12px] font-semibold leading-normal ${roleBadge}`}
              >
                {roleLabel}
              </span>
            </div>
            <div className="mt-1 font-mono text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {user.email}
            </div>
          </div>
          <button
            onClick={() => openModal('editProfile')}
            aria-label="Edit profile"
            title="Edit profile"
            className="iconbtn flex-none"
          >
            <Icon name="pencil" size={15} />
          </button>
        </div>

        {/* Grouped cards */}
        <div className="flex flex-col gap-4 p-4">
          {/* Account card */}
          <div className={cardShell}>
            <div className={cardHead}>Account</div>
            <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Name</span>
              <span className="font-sans text-[14px] font-medium leading-normal">{user.name}</span>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-(--border-subtle) px-4 py-3">
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Email</span>
              <span className="font-mono text-[12px] font-medium leading-normal">{user.email}</span>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">
                Member since
              </span>
              <span className="font-mono text-[12px] font-medium leading-normal">{memberSince}</span>
            </div>
          </div>

          {authOn ? <SocialSignInCard mobile notice={socialNotice} onNotice={setSocialNotice} /> : null}

          {/* Personal API keys — the caller's own REST credentials */}
          <ApiKeysCard orgs={orgs} defaultOrgId={activeOrg?.id} mobile />

          {/* Your own Slack App Configuration token — powers one-click installs */}
          <SlackConfigCard />

          {/* Sign out */}
          <button
            onClick={signOut}
            className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[14px] font-semibold leading-normal text-(--red-600)"
          >
            <Icon name="log-out" size={16} />
            Sign out
          </button>
          <div className="text-center font-mono text-[11px] font-normal leading-normal text-(--text-disabled)">
            AgentConnect
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="wrap max-w-[900px]">
      <div className="flex items-center gap-[18px]">
        <Avatar src={user.picture} initials={user.initials} size={64} fontSize={22} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px]">
            <h1 className="ptitle">{user.name}</h1>
            <span className={`badge ${roleBadge}`}>{roleLabel}</span>
          </div>
          <div className="mono mt-1 text-[12.5px] text-(--text-tertiary)">{user.email}</div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => openModal('editProfile')}>
          <Icon name="pencil" size={14} />
          Edit profile
        </Button>
      </div>

      <div className="card mt-[22px]">
        <div className="cardhead">
          <span className="cardtitle">Account</span>
        </div>
        <div className="py-[6px]">
          <KvRow label="Full name">
            <span className="font-sans text-[12.5px] font-medium leading-normal">{user.name}</span>
          </KvRow>
          <KvRow label="Email">
            <span className="mono text-[12.5px]">{user.email}</span>
          </KvRow>
          <KvRow label="Role">
            <span className={`badge ${roleBadge}`}>{roleLabel}</span>
          </KvRow>
          <KvRow label="Member since">
            <span className="mono text-[12.5px]">{memberSince}</span>
          </KvRow>
        </div>
      </div>

      {authOn ? <SocialSignInCard notice={socialNotice} onNotice={setSocialNotice} /> : null}

      <ApiKeysCard orgs={orgs} defaultOrgId={activeOrg?.id} />

      <SlackConfigCard />

      <div className="mt-[22px] flex items-center justify-between">
        <span className="mono buildinfo text-[11.5px]">{buildStamp}</span>
        <Button variant="ghost" onClick={signOut}>
          <span className="inline-flex items-center gap-[7px] text-(--red-600)">
            <Icon name="log-out" size={15} />
            Sign out
          </span>
        </Button>
      </div>
    </div>
  )
}
