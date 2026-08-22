'use client'

// Settings page (design: `isSettings`). Everything here is REAL and scoped to
// the active org: the Organization card (rename via PATCH /orgs/:id, owners
// only), self-service organization leave, Members & roles (GET /members;
// owners can invite-by-email, re-role and remove members — the CP enforces the
// last-owner guard), the org-wide agent policies, and the Roles explainer.
//
// The org's bots and code hosts are NOT here — they live on their own
// Integrations page (IntegrationsView), which unlike Settings is reachable in
// no-auth mode.

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { Avatar, Button, Icon, Toggle } from '@/components/ui'
import { AgentIconView, LoadingState, PlatformMark } from '@/components/marks'
import { withIconUrl } from '@/lib/agent-icon'
import { AgentIconPicker } from '@/components/console/AgentIconPicker'
import { useModal } from '@/components/console/ModalProvider'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { initialsFrom } from '@/lib/auth'
import {
  createOrgInviteLink,
  fetchMembers,
  fetchOrgInviteLink,
  fetchSessionExternalAccess,
  memberDisplayName,
  revokeOrgInviteLink,
  ROLE_LABELS,
  putSessionExternalAccess,
  updateOrg,
  uploadOrgIcon,
  type MemberDto,
  type MemberRole,
  type OrgInviteLinkDto,
  type SessionAccessProvider
} from '@/lib/api'
import { type AgentCallPolicy } from '@/lib/data'
import { consoleKeys } from '@/lib/swr-keys'
import { inviteLinkStatus, inviteLinkUrl } from '@/lib/org-invite-link'
import EditMemberModal, { type MemberTarget } from '@/components/console/modals/EditMemberModal'
import InviteMembersModal from '@/components/console/modals/InviteMembersModal'
import { OrganizationEnvironmentCard } from '@/components/console/OrganizationEnvironmentCard'

// A session-access row is a platform name and its switch. What the switch does is
// said once, in the card header — restating it per row ("People with Slack access"
// beside an on switch in a row already labelled Slack) is the same sentence three
// times. Only EXCEPTIONS get words: a chip when the setting is not fully taking
// effect, and the per-platform detail on the row's info button.
//
// A provider this deployment cannot offer at all is not an exception to explain,
// it is a row to leave out — see `hasNothingToOffer`.
//
// Two halves, and both are easy to state wrongly.
//
// "New sessions" is load-bearing in the Off half: turning the policy off stops
// NEW sessions binding to platform access. The ones already bound keep their
// `external` classification and simply stop being shown — they are not
// deleted, and turning the policy back on brings them back (each `details`
// string below says so too). That direction surprises people, because turning
// a restriction OFF shows them LESS, so it has to be spelled out rather than
// implied.
//
// And the Off half is Everyone, not the agent's audience: the session list
// reads every org agent regardless of Agent Team visibility
// (`routes/sessions.ts` — "Agent Team visibility does not narrow Session
// reads"), so promising "anyone who can view the agent" understated it.
// `Everyone` is the audience word for the internal `org` value — see
// docs/product-conventions.md.
const SESSION_ACCESS_HINT =
  "On — session visibility follows the platform's own access. Off — new sessions are visible to Everyone, and sessions synced while it was on stop showing."

const SESSION_ACCESS_COPY: Record<
  SessionAccessProvider,
  {
    name: string
    label: string
    details: string
    unavailable: string
    unresolved: (count: number) => string
    degraded: string
  }
> = {
  slack: {
    name: 'Slack',
    label: 'Follow Slack access',
    details: [
      'Public channels follow Slack workspace access; private channels, group DMs, guests and Slack Connect users need current membership.',
      'DMs stay private, and agent memory learned earlier is not erased.',
      'Sessions that predate this setting stay hidden until new trusted activity rebinds them to a Slack conversation.',
      'Turning this off hides the sessions synced while it was on — they are not deleted, and turning it back on restores them.'
    ].join('\n'),
    unavailable:
      'Unavailable until console sign-in is configured for this deployment — without it a viewer has no linked Slack identity to check.',
    unresolved: (count) => `${count} session${count === 1 ? '' : 's'} hidden — no trusted Slack scope.`,
    degraded: 'Slack scopes stopped resolving — new sessions are being hidden.'
  },
  github: {
    name: 'GitHub',
    label: 'Follow GitHub access',
    details: [
      'Public-repository sessions stay visible to Everyone; private-repository sessions need a linked GitHub profile with current access.',
      'Agent memory learned earlier is not erased.',
      'Sessions that predate this setting stay hidden until new trusted activity rebinds them to a repository.',
      'Turning this off hides the sessions synced while it was on — they are not deleted, and turning it back on restores them.'
    ].join('\n'),
    unavailable:
      'Unavailable until console sign-in and GitHub access checks are configured for this deployment — without them a viewer has no linked GitHub profile to check.',
    unresolved: (count) => `${count} session${count === 1 ? '' : 's'} hidden — no trusted repository scope.`,
    degraded: 'Repository scopes stopped resolving — new sessions are being hidden.'
  },
  feishu: {
    name: 'Feishu/Lark',
    label: 'Follow Feishu/Lark access',
    details: [
      'Group sessions created through the matching AgentConnect app follow current chat membership.',
      'DMs stay private, and agent memory learned earlier is not erased.',
      'User-built apps with a different App ID keep the ordinary organization visibility model.',
      'Turning this off hides the sessions synced while it was on — they are not deleted, and turning it back on restores them.'
    ].join('\n'),
    unavailable:
      'Unavailable until console sign-in is configured for this deployment — without it a viewer has no linked Feishu/Lark profile to check.',
    unresolved: (count) => `${count} session${count === 1 ? '' : 's'} hidden — no trusted chat scope.`,
    degraded: 'Feishu/Lark scopes stopped resolving — new sessions are being hidden.'
  }
}

/** The live policy for one provider, plus the owner's write path. */
function useSessionAccess(provider: SessionAccessProvider, orgId: string | undefined, isOwner: boolean) {
  const key = consoleKeys.sessionAccess(orgId, provider)
  const {
    data: access,
    error: loadError,
    mutate
  } = useSWR(key, ([, scopedOrgId, , scopedProvider]) => fetchSessionExternalAccess(scopedProvider, scopedOrgId))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<{ scope: string; message: string } | null>(null)
  // Keyed by org+provider: switching orgs re-keys SWR but keeps this state.
  const scope = `${orgId ?? ''}:${provider}`

  const setEnabled = async (enabled: boolean) => {
    if (!orgId || !isOwner || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const next = await putSessionExternalAccess(provider, enabled, orgId)
      await mutate(next, { revalidate: false })
    } catch (error) {
      setActionError({ scope, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return {
    provider,
    access,
    loadError,
    busy,
    actionError: actionError?.scope === scope ? actionError.message : null,
    setEnabled
  }
}

type SessionAccessState = ReturnType<typeof useSessionAccess>

/**
 * Whether the row would be a dead control: this deployment has no sign-in (and,
 * for GitHub, no access checks) wiring behind the provider, and the org is not
 * on the policy either. Nothing an owner does here can change that — the CP
 * refuses to enable it (409) and there is nothing to turn off — so the row is
 * left out rather than shown greyed with an explanation nobody can act on.
 *
 * `available === false` with the policy still ENABLED is the opposite case: the
 * wiring went away under a live policy, so sessions are being hidden and the
 * owner needs the switch to turn it back off. That row stays, with a chip.
 *
 * Unknown (still loading, or the read failed) is never hidden — absence has to
 * be a fact, not a default.
 */
function hasNothingToOffer(state: SessionAccessState): boolean {
  return state.access !== undefined && !state.access.available && !state.access.enabled
}

function SessionAccessRow({
  state,
  isOwner,
  bordered = false
}: {
  state: SessionAccessState
  isOwner: boolean
  bordered?: boolean
}) {
  const { provider, access, loadError, busy, actionError } = state
  const copy = SESSION_ACCESS_COPY[provider]
  const hiddenSessions = access?.hiddenSessions ?? 0
  // The wiring disappeared under a live policy (the hidden-row case inverted).
  const stranded = access?.available === false && access.enabled

  return (
    <div className={`flex items-center gap-3 px-4 py-[15px] ${bordered ? 'border-t border-(--border-subtle)' : ''}`}>
      <span className="flex h-[18px] w-[18px] flex-none items-center justify-center text-(--text-primary)">
        <PlatformMark platform={provider} fillPct={100} />
      </span>
      <div className="min-w-0 flex-1">
        {/* The detail is hover copy, so it needs a control that keyboard focus can
            land on — `TooltipLayer` opens from focus, and a plain span never
            takes any. Same affordance the two-line row carried. */}
        <div className="flex items-center gap-[5px]">
          <span className="font-sans text-[13px] font-medium leading-normal">{copy.name}</span>
          <button
            type="button"
            className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-(--text-tertiary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
            aria-label={`${copy.label} — what this covers`}
            title={copy.details}
          >
            <Icon name="info" size={13} />
          </button>
        </div>
        {(actionError || loadError) && (
          <div role="alert" className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">
            {actionError ?? `Could not load ${copy.name} session access.`}
          </div>
        )}
      </div>
      {/* Amber is reserved for the actionable cases — a scope that stopped
          resolving after enablement, or configuration pulled out from under a
          live policy. The hidden-session backlog is expected and permanent (the
          CP freezes it as the policy's legacy mark), so its chip reads as a
          muted fact, not a fault the owner is failing to clear.
          A chip is a shortening, not a hiding: the full sentence is hover copy
          for a pointer and screen-reader text for everyone else. */}
      {stranded && (
        <span className="badge flex-none bg-(--status-paused-soft) text-(--status-paused)" title={copy.unavailable}>
          <span aria-hidden="true">Not configured</span>
          <span className="sr-only">{copy.unavailable}</span>
        </span>
      )}
      {access?.state === 'degraded' && !stranded && (
        <span className="badge flex-none bg-(--status-paused-soft) text-(--status-paused)" title={copy.degraded}>
          <span aria-hidden="true">Scopes not resolving</span>
          <span className="sr-only">{copy.degraded}</span>
        </span>
      )}
      {hiddenSessions > 0 && (
        <span
          className="badge flex-none bg-(--surface-sunken) text-(--text-tertiary)"
          title={copy.unresolved(hiddenSessions)}
        >
          <span aria-hidden="true">{hiddenSessions} hidden</span>
          <span className="sr-only">{copy.unresolved(hiddenSessions)}</span>
        </span>
      )}
      <span title={isOwner ? undefined : 'Only organization owners can change this setting'}>
        <Toggle
          checked={access?.enabled === true}
          disabled={!isOwner || !access || busy || (!access.available && !access.enabled)}
          ariaLabel={copy.label}
          onChange={(next) => void state.setEnabled(next)}
        />
      </span>
    </div>
  )
}

export function SessionAccessCard({ orgId, isOwner }: { orgId?: string; isOwner: boolean }) {
  // Three fixed hooks, one per provider — the card decides what to render, so it
  // has to hold the reads.
  const providers = [
    useSessionAccess('github', orgId, isOwner),
    useSessionAccess('slack', orgId, isOwner),
    useSessionAccess('feishu', orgId, isOwner)
  ]
  const pending = providers.some((state) => state.access === undefined && !state.loadError)
  const rows = providers.filter((state) => !hasNothingToOffer(state))

  // Nothing wired and nothing enabled: no header over an empty card either.
  if (!pending && rows.length === 0) return null

  return (
    <div className="card mt-[18px]" id="session-access">
      <div className="cardhead justify-between">
        <span className="cardtitle">Session access</span>
        <span className="flex items-center gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          Follow platform access
          <button
            type="button"
            className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-(--text-tertiary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
            aria-label="Session access — what the toggles do"
            title={SESSION_ACCESS_HINT}
          >
            <Icon name="info" size={13} />
          </button>
        </span>
      </div>
      {/* Hold the rows until every provider has answered: a row that appears and
          then vanishes reads as a glitch, and this card can vanish whole. */}
      {pending ? (
        <LoadingState size={22} padding={20} />
      ) : (
        rows.map((state, index) => (
          <SessionAccessRow key={state.provider} state={state} isOwner={isOwner} bordered={index > 0} />
        ))
      )}
    </div>
  )
}

// Only the chosen option's consequence is spelled out — the unchosen one is a
// segment label, not a second paragraph.
const AGENT_VISIBILITY_OPTIONS = [
  {
    key: 'all',
    label: 'All agents',
    sub: 'Open in both directions to every agent.'
  },
  {
    key: 'selected',
    label: 'Isolated',
    sub: 'No peer access until agents are selected.'
  }
] as const satisfies ReadonlyArray<{ key: AgentCallPolicy; label: string; sub: string }>

function AgentVisibilityCard({
  orgId,
  policy,
  isOwner,
  onChange
}: {
  orgId?: string
  policy: AgentCallPolicy
  isOwner: boolean
  onChange: (policy: AgentCallPolicy) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setPolicy = async (next: AgentCallPolicy) => {
    if (!orgId || !isOwner || busy || next === policy) return
    setBusy(true)
    setError(null)
    try {
      await onChange(next)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setBusy(false)
    }
  }

  const disabled = !orgId || !isOwner || busy
  const selected = AGENT_VISIBILITY_OPTIONS.find((option) => option.key === policy)

  return (
    <div className="card mt-[18px]" id="agent-visibility">
      <div className="cardhead justify-between">
        <span className="cardtitle">Default agent visibility</span>
        <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          Applies to new agents only
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-[15px] desktop:flex-row desktop:items-center desktop:gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13px] font-medium leading-normal">New agents start</div>
          <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {selected?.sub}
          </div>
        </div>
        <div
          className="pillbar self-start desktop:flex-none desktop:self-auto"
          role="radiogroup"
          aria-label="Default agent visibility"
          aria-busy={busy}
          title={isOwner ? undefined : 'Only organization owners can change this setting'}
        >
          {AGENT_VISIBILITY_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="radio"
              disabled={disabled}
              aria-checked={policy === option.key}
              onClick={() => void setPolicy(option.key)}
              className={
                policy === option.key
                  ? disabled
                    ? 'pill on cursor-not-allowed opacity-50'
                    : 'pill on'
                  : disabled
                    ? 'pill cursor-not-allowed opacity-50'
                    : 'pill'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)"
        >
          {error}
        </div>
      )}
    </div>
  )
}

// One rendered member row, precomputed from the wire DTO.
interface MemberRowView {
  userId: string
  name: string
  email: string | null
  picture: string | null
  initials: string
  avBg: string
  avText: string
  roleLabel: string
  roleBg: string
  roleText: string
  role: MemberRole
  isCurrentUser: boolean
}

function rowFromDto(m: MemberDto): MemberRowView {
  const name = memberDisplayName(m)
  const owner = m.role === 'owner'
  return {
    userId: m.userId,
    name,
    email: m.email,
    picture: m.picture,
    initials: initialsFrom(m.name ?? '', m.email ?? undefined),
    avBg: owner ? 'var(--magenta-100)' : 'var(--gray-100)',
    avText: owner ? 'var(--magenta-700)' : 'var(--text-secondary)',
    roleLabel: ROLE_LABELS[m.role],
    roleBg: owner ? 'var(--brand-soft)' : 'var(--surface-active)',
    roleText: owner ? 'var(--brand-soft-text)' : 'var(--text-secondary)',
    role: m.role,
    isCurrentUser: m.isCurrentUser
  }
}

const MEMBER_GRID = 'grid-cols-[2fr_1.4fr_auto]'

function InviteLinksCard({ orgId }: { orgId: string }) {
  const key = consoleKeys.inviteLink(orgId)
  const {
    data: link,
    error: loadError,
    mutate
  } = useSWR<OrgInviteLinkDto | null>(key, ([, id]) => fetchOrgInviteLink(id as string))
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null)
  const [busy, setBusy] = useState<'generate' | 'revoke' | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    setRevealed(null)
    setCopied(false)
    setActionError(null)
  }, [orgId])

  const status = link ? inviteLinkStatus(link) : null
  const canGenerate = link !== undefined && (!link || status !== 'active')

  const generate = async () => {
    if (busy || !canGenerate) return
    setBusy('generate')
    setActionError(null)
    setCopied(false)
    try {
      const created = await createOrgInviteLink(orgId)
      setRevealed({ id: created.id, url: inviteLinkUrl(created.token, window.location.origin) })
      await mutate(created, { revalidate: false })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const revoke = async () => {
    if (!link || busy) return
    setBusy('revoke')
    setActionError(null)
    try {
      await revokeOrgInviteLink(link.id, orgId)
      setRevealed(null)
      await mutate()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the URL stays visible for manual selection */
    }
  }

  return (
    <div className="card mt-[18px]" id="invite-links">
      <div className="cardhead justify-between">
        <span className="cardtitle">Invite links</span>
        {canGenerate && (
          <Button variant="secondary" size="xs" onClick={() => void generate()}>
            <Icon name="link" size={14} />
            {busy === 'generate' ? 'Generating…' : link ? 'Generate new' : 'Generate link'}
          </Button>
        )}
      </div>

      {link === undefined && !loadError ? (
        <LoadingState size={22} padding={20} />
      ) : loadError ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          Couldn&apos;t load the invite link.
        </div>
      ) : !link ? (
        <div className="flex items-center gap-3 px-4 py-[15px]">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-(--surface-sunken)">
            <Icon name="link" size={17} color="var(--text-tertiary)" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[13px] font-semibold leading-normal">No invite link</div>
            <div className="mt-[2px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              Generate the organization&apos;s single collaborator link.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 px-4 py-[15px] desktop:flex-row desktop:items-center">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-(--brand-soft)">
              <Icon name="link" size={17} color="var(--brand)" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-sans text-[13px] font-semibold leading-normal">Organization invite link</span>
                <span
                  className={`badge ${
                    status === 'active'
                      ? 'bg-(--status-online-soft) text-(--status-online)'
                      : status === 'expired'
                        ? 'bg-(--status-paused-soft) text-(--status-paused)'
                        : 'bg-(--status-error-soft) text-(--status-error)'
                  }`}
                >
                  {status === 'active' ? 'Active' : status === 'expired' ? 'Expired' : 'Revoked'}
                </span>
              </div>
            </div>
            {status === 'active' && (
              <Button variant="secondary" size="xs" onClick={() => void revoke()}>
                <Icon name="ban" size={13} />
                {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
              </Button>
            )}
          </div>

          {revealed?.id === link.id && (
            <div className="mx-4 mb-4 overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
              <div className="flex items-center gap-2 border-b border-(--gray-800) px-[13px] py-[9px]">
                <Icon name="link" size={13} color="var(--text-inverse-dim)" />
                <span className="font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)">
                  Copy this link now — it is shown only once
                </span>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)"
                >
                  <Icon name={copied ? 'check' : 'copy'} size={12} />
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              <div className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]">
                {revealed.url}
              </div>
            </div>
          )}
        </>
      )}

      {actionError && (
        <div className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
          {actionError}
        </div>
      )}
    </div>
  )
}

export default function SettingsView() {
  const { activeOrg, myRole, refreshOrgs, updateOrg: updateOrgSettings, leaveOrg, error: orgError } = useOrgs()
  const { openModal } = useModal()
  // The organization-environment picker filters this to agents the viewer can manage.
  const { agents } = useConsoleData()
  const isOwner = myRole === 'owner'

  const membersKey = consoleKeys.members(activeOrg?.id)
  const {
    data: membersData,
    error: membersError,
    mutate: mutateMembers
  } = useSWR(membersKey, ([, orgId]) => fetchMembers(orgId))
  const loadFailed = membersData === undefined && Boolean(membersError ?? orgError)
  const members = loadFailed ? [] : (membersData ?? null)
  const [editing, setEditing] = useState<MemberTarget | null>(null)
  const [inviting, setInviting] = useState(false)

  // `?invite=1` auto-opens the invite-members dialog (the getting-started "Invite
  // teammates" CTA lands here with it). One-shot: the param is stripped immediately
  // so back/refresh doesn't reopen the modal.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  useEffect(() => {
    if (!searchParams.get('invite')) return
    setInviting(true)
    const sp = new URLSearchParams(searchParams)
    sp.delete('invite')
    router.replace(`${pathname}${sp.size ? `?${sp}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  // A member change can affect ME (self-demote/-remove) — re-pull the org list
  // too so myRole / the active org stay honest instead of 403-ing controls.
  const onMembersChanged = useCallback(() => {
    void Promise.allSettled([mutateMembers(), refreshOrgs()])
  }, [mutateMembers, refreshOrgs])

  const rows = (members ?? []).map(rowFromDto)
  const ownerCount = rows.filter((r) => r.role === 'owner').length

  const edit = (r: MemberRowView) => {
    setEditing({
      userId: r.userId,
      name: r.name,
      email: r.email,
      picture: r.picture,
      initials: r.initials,
      avBg: r.avBg,
      avText: r.avText,
      role: r.role,
      isCurrentUser: r.isCurrentUser,
      lastOwner: r.role === 'owner' && ownerCount <= 1
    })
  }

  return (
    <div className="wrap max-w-[900px] max-desktop:p-4">
      {/* Card ids are GlobalSearch anchor targets — keep in sync with nav.ts SETTING_CARDS. */}
      <div className="card" id="organization">
        <div className="cardhead justify-between">
          <span className="cardtitle">Organization</span>
          {isOwner && (
            <Button variant="secondary" size="xs" onClick={() => openModal('editOrg')}>
              <Icon name="pencil" size={14} />
              Edit
            </Button>
          )}
        </div>
        <div className="flex items-center gap-[14px] px-4 py-[15px]">
          {isOwner ? (
            // Owners edit the org avatar in place: glyph/color via onCommit, an uploaded
            // image via onUploadImage (shown only when the object store is configured).
            <AgentIconPicker
              value={withIconUrl(activeOrg?.icon, activeOrg?.iconUrl)}
              runtime=""
              size={44}
              radiusClass="rounded-[10px]"
              onCommit={(icon) =>
                activeOrg &&
                void updateOrg(activeOrg.id, { icon })
                  .then(() => refreshOrgs())
                  .catch(() => {})
              }
              onUploadImage={
                activeOrg?.iconUploadEnabled
                  ? async (blob) => {
                      await uploadOrgIcon(blob, activeOrg.id)
                      refreshOrgs()
                    }
                  : undefined
              }
            />
          ) : (
            <span className="av h-11 w-11 flex-none rounded-[10px]">
              <AgentIconView icon={withIconUrl(activeOrg?.icon, activeOrg?.iconUrl)} runtime="" size={44} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[15px] font-semibold leading-normal">
              {activeOrg?.name ?? activeOrg?.slug ?? '—'}
            </div>
            <div className="mono mt-[2px] text-[11.5px] text-(--text-tertiary)">{activeOrg?.slug ?? ''}</div>
          </div>
        </div>
      </div>

      <AgentVisibilityCard
        key={activeOrg?.id ?? 'loading'}
        orgId={activeOrg?.id}
        policy={activeOrg?.defaultAgentVisibility ?? 'all'}
        isOwner={isOwner}
        onChange={async (policy) => {
          if (!activeOrg) return
          await updateOrgSettings(activeOrg.id, { defaultAgentVisibility: policy })
        }}
      />

      <SessionAccessCard orgId={activeOrg?.id} isOwner={isOwner} />

      {/* Sits with the other organization-wide agent policies. Owner-only, so the
          card renders nothing at all for collaborators and viewers (§8.1). */}
      <OrganizationEnvironmentCard orgId={activeOrg?.id} isOwner={isOwner} agents={agents} />

      <div className="card mt-[18px]" id="members">
        <div className="cardhead justify-between">
          <span className="cardtitle">Members &amp; roles</span>
          {isOwner && (
            <Button variant="secondary" size="xs" onClick={() => setInviting(true)}>
              <Icon name="user-plus" size={14} />
              Invite
            </Button>
          )}
        </div>
        <div className={`row h ${MEMBER_GRID}`}>
          <span>Member</span>
          <span>Role</span>
          <span />
        </div>
        {rows.map((p) => (
          <div key={p.userId} className={`row ${MEMBER_GRID} gap-[11px]`}>
            <div className="flex min-w-0 items-center gap-[11px]">
              <Avatar src={p.picture} initials={p.initials} size={32} fontSize={12} bg={p.avBg} fg={p.avText} />
              <div className="min-w-0">
                <div className="truncate font-sans text-[13px] font-semibold leading-normal">{p.name}</div>
                <div className="mono truncate text-[11px] text-(--text-tertiary)">{p.email ?? '—'}</div>
              </div>
            </div>
            <span className="badge self-center justify-self-start" style={{ background: p.roleBg, color: p.roleText }}>
              {p.roleLabel}
            </span>
            {isOwner || p.isCurrentUser ? (
              <button
                className="iconbtn h-7 w-7 self-center"
                title={isOwner ? 'Edit member' : 'Manage membership'}
                onClick={() => edit(p)}
              >
                <Icon name="pencil" size={14} />
              </button>
            ) : (
              <span className="w-7" />
            )}
          </div>
        ))}
        {members === null && (
          <div className="row grid-cols-[1fr]">
            <LoadingState size={22} padding={20} />
          </div>
        )}
        {loadFailed && (
          <div className="row grid-cols-[1fr] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
            Couldn&apos;t load members — is the control plane reachable?
          </div>
        )}
      </div>

      {isOwner && activeOrg && <InviteLinksCard orgId={activeOrg.id} />}

      {inviting && (
        <div className="scrim" onClick={() => setInviting(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <InviteMembersModal onClose={() => setInviting(false)} onAdded={onMembersChanged} />
          </div>
        </div>
      )}
      {editing && (
        <div className="scrim" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <EditMemberModal
              member={editing}
              canEditRole={isOwner}
              onLeave={editing.isCurrentUser ? () => leaveOrg(editing.userId) : undefined}
              onClose={() => setEditing(null)}
              onChanged={onMembersChanged}
            />
          </div>
        </div>
      )}
    </div>
  )
}
