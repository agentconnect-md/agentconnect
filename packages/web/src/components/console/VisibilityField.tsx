// No 'use client' here: this module is imported only by client components (the
// modals under ModalProvider + the detail/list views), so it's already in the
// client bundle — and keeping the directive off avoids Next's "props must be
// serializable" entry-file check on the onChange callback.

/**
 * Per-resource visibility / sharing UI (docs/designs/resource-visibility.md,
 * design files "AgentConnect Console" + "AgentConnect Mobile App").
 *
 * - `VisibilityField` — the create/edit control: an Everyone vs Selected picker
 *   plus, when restricted, a member multi-select. Desktop = two tiles + a searchable
 *   member list; mobile = two pills + toggleable "Share with" pills.
 * - `VisibilityRow` — the read-only detail row (globe "Everyone" or lock + an
 *   overlapping avatar stack of the shared members).
 * - `RestrictedLock` — the small lock glyph shown next to a restricted resource's
 *   name in list rows.
 *
 * The creator is pinned as a non-removable locked chip (they always have access). Every
 * OTHER member — owners included — is a normal toggleable option you can add to / remove
 * from the share set. (Org owners also always see restricted resources via the server's
 * governance override, but we still let them be added explicitly.) Sharing is gated
 * server-side by canManageSharing (=== canEdit).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Icon } from '@/components/ui'
import { useConsoleData } from '@/lib/data-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { memberDisplayName, type MemberDto } from '@/lib/api'
import { initialsFrom } from '@/lib/auth'
import type { ResourceVisibility } from '@/lib/data'

export interface SharingValue {
  visibility: ResourceVisibility
  sharedWith: string[] // app_user.id set
}

/** Order-insensitive equality — used to skip a no-op /sharing write on edit. */
export function sameSharing(a: SharingValue, b: SharingValue): boolean {
  return (
    a.visibility === b.visibility &&
    a.sharedWith.length === b.sharedWith.length &&
    a.sharedWith.every((id) => b.sharedWith.includes(id))
  )
}

const dotOn = 'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-4 border-(--brand) bg-(--surface-card)'
const dotOff =
  'mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-[1.5px] border-(--border-strong) bg-(--surface-card)'

function memberInitials(m: Pick<MemberDto, 'name' | 'email'>): string {
  return initialsFrom(m.name ?? '', m.email ?? undefined)
}

/** Members eligible to be toggled into the share set: everyone EXCEPT the creator
 *  (who is pinned as a non-removable entry, so toggling can't imply removing their
 *  access). Owners ARE included — they're addable like any other member. */
function useSharePool(creatorUserId?: string | null): MemberDto[] {
  const { members } = useConsoleData()
  return useMemo(() => members.filter((m) => m.userId !== creatorUserId), [members, creatorUserId])
}

/** The resource's creator, resolved to a member row so it can be pinned into the
 *  access list as a non-editable entry. Undefined when unknown or no longer a member. */
function useCreator(creatorUserId?: string | null): MemberDto | undefined {
  const { members } = useConsoleData()
  return useMemo(
    () => (creatorUserId ? members.find((m) => m.userId === creatorUserId) : undefined),
    [members, creatorUserId]
  )
}

// ── the create/edit control ──────────────────────────────────────────────────

export function VisibilityField({
  value,
  onChange,
  creatorUserId,
  disabled
}: {
  value: SharingValue
  onChange: (next: SharingValue) => void
  /** The resource creator's userId (self on create) — excluded from the pool. */
  creatorUserId?: string | null
  disabled?: boolean
}) {
  const isMobile = useIsMobile()
  const restricted = value.visibility === 'restricted'
  const pick = (visibility: ResourceVisibility) => !disabled && onChange({ ...value, visibility })
  const toggle = (userId: string) => {
    if (disabled) return
    const has = value.sharedWith.includes(userId)
    onChange({
      ...value,
      sharedWith: has ? value.sharedWith.filter((id) => id !== userId) : [...value.sharedWith, userId]
    })
  }

  return (
    <div className="fld mt-[14px]">
      <span className="fldlbl">Visibility</span>
      {isMobile ? (
        <VisibilityPills restricted={restricted} onPick={pick} />
      ) : (
        <VisibilityTiles restricted={restricted} onPick={pick} />
      )}
      {restricted &&
        (isMobile ? (
          <ShareWithPills selected={value.sharedWith} onToggle={toggle} creatorUserId={creatorUserId} />
        ) : (
          <ShareWithList selected={value.sharedWith} onToggle={toggle} creatorUserId={creatorUserId} />
        ))}
    </div>
  )
}

// ── desktop: two tiles ───────────────────────────────────────────────────────

function VisibilityTiles({ restricted, onPick }: { restricted: boolean; onPick: (v: ResourceVisibility) => void }) {
  const tile = (v: ResourceVisibility, icon: string, title: string, desc: string) => {
    const on = restricted ? v === 'restricted' : v === 'org'
    return (
      <div className={on ? 'ptile on items-start' : 'ptile items-start'} onClick={() => onPick(v)}>
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
          <Icon name={icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13px] font-semibold leading-normal">{title}</div>
          <div className="mt-[2px] truncate font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
            {desc}
          </div>
        </div>
        <span className={on ? dotOn : dotOff} />
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
      {tile('org', 'globe', 'Everyone', 'Everyone in your org can see it.')}
      {tile('restricted', 'lock', 'Selected', 'Only people you choose.')}
    </div>
  )
}

// ── desktop: searchable member list ──────────────────────────────────────────

function ShareWithList({
  selected,
  onToggle,
  creatorUserId
}: {
  selected: string[]
  onToggle: (userId: string) => void
  creatorUserId?: string | null
}) {
  const pool = useSharePool(creatorUserId)
  const creator = useCreator(creatorUserId)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const byId = useMemo(() => new Map(pool.map((m) => [m.userId, m])), [pool])
  const query = q.trim().toLowerCase()
  const availablePool = useMemo(() => pool.filter((m) => !selected.includes(m.userId)), [pool, selected])
  const options = useMemo(
    () =>
      availablePool.filter(
        (m) =>
          !query || memberDisplayName(m).toLowerCase().includes(query) || (m.email ?? '').toLowerCase().includes(query)
      ),
    [availablePool, query]
  )
  const chips = selected.map((id) => byId.get(id)).filter((m): m is MemberDto => !!m)

  // The member list is a dropdown: it only opens once the search field is focused,
  // and a click anywhere outside collapses it back to just the chips row.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={wrapRef} className="mt-2 overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-card)">
      <div
        onClick={() => {
          setOpen(true)
          inputRef.current?.focus()
        }}
        className={`flex cursor-text flex-wrap items-center gap-[6px] px-[11px] py-2 ${
          open ? 'border-b border-(--border-subtle)' : ''
        }`}
      >
        <Icon name="search" size={14} color="var(--text-tertiary)" className="flex-none" />
        {creator && (
          <span
            title="The creator always has access — you can’t remove them"
            className="inline-flex items-center gap-[5px] rounded-full bg-(--surface-active) py-[2px] pr-[7px] pl-[3px] font-sans text-[11.5px] font-medium leading-normal"
          >
            <Avatar src={creator.picture} initials={memberInitials(creator)} size={17} fontSize={8} />
            {memberDisplayName(creator)}
            <Icon name="lock" size={10} color="var(--text-tertiary)" className="flex-none" />
          </span>
        )}
        {chips.map((m) => (
          <span
            key={m.userId}
            className="inline-flex items-center gap-[5px] rounded-full bg-(--surface-active) py-[2px] pr-1 pl-[3px] font-sans text-[11.5px] font-medium leading-normal"
          >
            <Avatar src={m.picture} initials={memberInitials(m)} size={17} fontSize={8} />
            {memberDisplayName(m)}
            <span
              onClick={(e) => {
                e.stopPropagation()
                onToggle(m.userId)
              }}
              title="Remove access"
              className="inline-flex h-[15px] w-[15px] cursor-pointer items-center justify-center rounded-full text-(--text-tertiary)"
            >
              <Icon name="x" size={10} />
            </span>
          </span>
        ))}
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search members…"
          className="min-w-[110px] flex-1 border-0 bg-transparent py-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-primary) outline-none"
        />
      </div>
      {open && (
        <>
          <div className="max-h-[150px] overflow-auto py-1">
            {options.map((m) => {
              return (
                <button
                  key={m.userId}
                  type="button"
                  onClick={() => onToggle(m.userId)}
                  className="flex w-full cursor-pointer items-center gap-[10px] border-0 bg-transparent px-3 py-[6px] text-left"
                >
                  <Avatar src={m.picture} initials={memberInitials(m)} size={26} fontSize={10} />
                  <span className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)">
                      {memberDisplayName(m)}
                    </span>
                    <span className="mono text-[11px] text-(--text-tertiary)">{m.email ?? m.role}</span>
                  </span>
                  <span className="flex-none font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    {m.role}
                  </span>
                </button>
              )
            })}
            {options.length === 0 && (
              <div className="px-3 py-[10px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                {pool.length === 0
                  ? 'No other members to share with yet'
                  : availablePool.length === 0
                    ? 'Everyone is already selected'
                    : `No members match “${q}”`}
              </div>
            )}
          </div>
          <div className="flex items-start gap-[7px] border-t border-(--border-subtle) bg-(--surface-sunken) px-3 py-[9px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            <Icon name="info" size={13} className="mt-[2px] flex-none" />
            <span>
              The creator (pinned above) always has access — you can’t remove them. Org owners can always see restricted
              resources too.
            </span>
          </div>
        </>
      )}
    </div>
  )
}

// ── mobile: pills ────────────────────────────────────────────────────────────

function VisibilityPills({ restricted, onPick }: { restricted: boolean; onPick: (v: ResourceVisibility) => void }) {
  const pill = (v: ResourceVisibility, label: string) => {
    const on = restricted ? v === 'restricted' : v === 'org'
    return (
      <button
        type="button"
        onClick={() => onPick(v)}
        className={
          on
            ? 'h-9 cursor-pointer rounded-full border border-(--brand) bg-(--brand-soft) px-[14px] font-sans text-[13px] font-semibold leading-normal text-(--brand)'
            : 'h-9 cursor-pointer rounded-full border border-(--border-default) bg-(--surface-card) px-[14px] font-sans text-[13px] font-medium leading-normal text-(--text-secondary) transition-[background-color,border-color,color] hover:border-(--border-strong) hover:bg-(--surface-hover) hover:text-(--text-primary)'
        }
      >
        {label}
      </button>
    )
  }
  return (
    <div className="flex flex-wrap gap-2">
      {pill('org', 'Everyone')}
      {pill('restricted', 'Selected')}
    </div>
  )
}

function ShareWithPills({
  selected,
  onToggle,
  creatorUserId
}: {
  selected: string[]
  onToggle: (userId: string) => void
  creatorUserId?: string | null
}) {
  const pool = useSharePool(creatorUserId)
  const creator = useCreator(creatorUserId)

  // The creator's non-removable "always has access" pill.
  const lockedPill = (m: MemberDto) => (
    <span
      key={m.userId}
      title="Always has access — you can’t remove them"
      className="inline-flex h-9 items-center gap-[7px] rounded-full border border-(--border-default) bg-(--surface-sunken) pr-3 pl-[6px] font-sans text-[13px] font-medium leading-normal text-(--text-secondary)"
    >
      <Avatar src={m.picture} initials={memberInitials(m)} size={24} fontSize={9} />
      {memberDisplayName(m)}
      <Icon name="lock" size={12} color="var(--text-tertiary)" />
    </span>
  )

  return (
    <>
      <span className="fldlbl mt-[14px] block">Share with</span>
      <div className="mt-[6px] flex flex-wrap gap-2">
        {creator && lockedPill(creator)}
        {pool.map((m) => {
          const on = selected.includes(m.userId)
          return (
            <button
              key={m.userId}
              type="button"
              onClick={() => onToggle(m.userId)}
              className={
                on
                  ? 'inline-flex h-9 cursor-pointer items-center gap-[7px] rounded-full border border-(--brand) bg-(--brand-soft) pr-[14px] pl-[6px] font-sans text-[13px] font-semibold leading-normal text-(--brand)'
                  : 'inline-flex h-9 cursor-pointer items-center gap-[7px] rounded-full border border-(--border-default) bg-(--surface-card) pr-[14px] pl-[6px] font-sans text-[13px] font-medium leading-normal text-(--text-secondary) transition-[background-color,border-color,color] hover:border-(--border-strong) hover:bg-(--surface-hover) hover:text-(--text-primary)'
              }
            >
              <Avatar src={m.picture} initials={memberInitials(m)} size={24} fontSize={9} />
              {memberDisplayName(m)}
            </button>
          )
        })}
        {pool.length === 0 && (
          <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            No other members to share with yet
          </span>
        )}
      </div>
      <div className="mt-[10px] flex items-start gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        <Icon name="info" size={13} className="mt-[2px] flex-none" />
        <span>
          The creator always has access — you can’t remove them. Org owners can always see restricted resources too.
        </span>
      </div>
    </>
  )
}

// ── read-only detail row ─────────────────────────────────────────────────────

export function VisibilityValue({
  visibility,
  sharedWith,
  createdBy
}: {
  visibility: ResourceVisibility
  sharedWith: string[]
  /** The creator's userId. They ALWAYS have access (the share editor pins them as a
   *  non-removable chip), so they lead the access list — without them a resource
   *  restricted to just its creator would resolve to nobody. */
  createdBy?: string | null
}) {
  const { members } = useConsoleData()
  if (visibility === 'org') {
    return (
      <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal">
        <Icon name="globe" size={13} color="var(--text-tertiary)" />
        Everyone
      </span>
    )
  }
  // Creator first, then the shared set (deduped — the creator may also be listed).
  const ids = createdBy ? [createdBy, ...sharedWith.filter((id) => id !== createdBy)] : sharedWith
  const resolved = ids.map((id) => members.find((m) => m.userId === id)).filter((m): m is MemberDto => !!m)
  const shown = resolved.slice(0, 3)
  const extra = resolved.length - shown.length
  // The chips are the EXPLICIT grant (creator + share set). Org owners can always see
  // a restricted resource on top of that (governance override — the same thing the
  // share editor spells out), so name it here too rather than implying exclusivity.
  const ownerNote = 'Org owners can always see restricted resources too.'
  const title = resolved.length > 0 ? `${resolved.map(memberDisplayName).join(', ')} — ${ownerNote}` : ownerNote
  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <Icon name="lock" size={14} color="var(--text-tertiary)" className="flex-none" />
      {resolved.length === 0 ? (
        // Only when nothing resolves (no/unknown creator and an empty or stale
        // share set) — everyone with access has left the org, or a legacy row.
        <span className="font-sans text-[12.5px] font-medium leading-normal">Restricted</span>
      ) : (
        <span className="inline-flex">
          {shown.map((m, i) => (
            <span
              key={m.userId}
              // Nested titles REPLACE the parent's on hover, and the avatars are the
              // main hover target — repeat the owner disclosure so it's never hidden.
              title={`${memberDisplayName(m)} — ${ownerNote}`}
              className={i === 0 ? 'inline-flex' : 'inline-flex -ml-[6px]'}
            >
              <Avatar
                src={m.picture}
                initials={memberInitials(m)}
                size={20}
                fontSize={8}
                bg="var(--surface-active)"
                fg="var(--text-secondary)"
                style={{ border: '1.5px solid var(--surface-card)' }}
              />
            </span>
          ))}
          {extra > 0 && (
            <span className="-ml-[6px] inline-flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-(--surface-card) bg-(--surface-active) font-sans text-[8px] font-semibold leading-normal text-(--text-secondary)">
              +{extra}
            </span>
          )}
        </span>
      )}
    </span>
  )
}

// ── list-row lock glyph ──────────────────────────────────────────────────────

export function RestrictedLock({ show, title, size = 13 }: { show: boolean; title: string; size?: number }) {
  if (!show) return null
  return (
    <span title={title} className="inline-flex flex-none">
      <Icon name="lock" size={size} color="var(--text-tertiary)" />
    </span>
  )
}
