// Client-only imports keep callbacks inside the client boundary without a 'use client' entry point.
// Sharing stores explicit selections; organization owners also have access without joining that selection.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import { useConsoleData } from '@/lib/data-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { memberDisplayName, type KnowledgeVisibility, type MemberDto } from '@/lib/api'
import { initialsFrom } from '@/lib/auth'
import { agentLabel, type Agent, type ResourceVisibility } from '@/lib/data'
import { useTranslations } from 'next-intl'

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

/** Current organization members eligible for the Selected audience. */
function useSharePool(): MemberDto[] {
  const { members } = useConsoleData()
  return members
}

// ── the create/edit control ──────────────────────────────────────────────────

export function VisibilityField({
  value,
  onChange,
  disabled,
  label
}: {
  value: SharingValue
  onChange: (next: SharingValue) => void
  disabled?: boolean
  /** Field label (e.g. "Team visibility" in the agent Access section). */
  label?: string
}) {
  const t = useTranslations('Common.visibility')
  const isMobile = useIsMobile()
  const { members } = useConsoleData()
  const restricted = value.visibility === 'restricted'
  const currentUserId = members.find((member) => member.isCurrentUser)?.userId
  const pick = (visibility: ResourceVisibility) => {
    if (disabled) return
    const sharedWith =
      visibility === 'restricted' && value.sharedWith.length === 0 && currentUserId ? [currentUserId] : value.sharedWith
    onChange({ visibility, sharedWith })
  }
  const toggle = (userId: string) => {
    if (disabled) return
    const has = value.sharedWith.includes(userId)
    if (has && value.sharedWith.length === 1) return
    onChange({
      ...value,
      sharedWith: has ? value.sharedWith.filter((id) => id !== userId) : [...value.sharedWith, userId]
    })
  }

  return (
    <div className="fld mt-[14px]">
      <span className="fldlbl">{label ?? t('label')}</span>
      {isMobile ? (
        <VisibilityPills restricted={restricted} onPick={pick} />
      ) : (
        <VisibilityTiles restricted={restricted} onPick={pick} />
      )}
      {restricted &&
        (isMobile ? (
          <ShareWithPills selected={value.sharedWith} onToggle={toggle} />
        ) : (
          <ShareWithList selected={value.sharedWith} onToggle={toggle} />
        ))}
    </div>
  )
}

// ── desktop: two tiles ───────────────────────────────────────────────────────

function VisibilityTiles({
  restricted,
  onPick,
  labels
}: {
  restricted: boolean
  onPick: (v: ResourceVisibility) => void
  labels?: { everyone: string; everyoneDescription: string; selected: string; selectedDescription: string }
}) {
  const t = useTranslations('Common.visibility')
  const tile = (v: ResourceVisibility, icon: string, title: string, desc: string) => {
    const on = restricted ? v === 'restricted' : v === 'org'
    return (
      <div className={on ? 'ptile on items-start' : 'ptile items-start'} onClick={() => onPick(v)}>
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
          <Icon name={icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13px] font-semibold leading-normal">{title}</div>
          <div className="mt-[2px] font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
            {desc}
          </div>
        </div>
        <span className={on ? dotOn : dotOff} />
      </div>
    )
  }
  return (
    // 280px is the narrowest tile that keeps the longest description on one line beside its icon and radio.
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-[10px]">
      {tile('org', 'globe', labels?.everyone ?? t('everyone'), labels?.everyoneDescription ?? t('everyoneDescription'))}
      {tile(
        'restricted',
        'lock',
        labels?.selected ?? t('selected'),
        labels?.selectedDescription ?? t('selectedDescription')
      )}
    </div>
  )
}

// ── desktop: searchable member list ──────────────────────────────────────────

function ShareWithList({ selected, onToggle }: { selected: string[]; onToggle: (userId: string) => void }) {
  const t = useTranslations('Common.visibility')
  const pool = useSharePool()
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

  // Collapse the member dropdown when the user clicks outside it.
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
              title={selected.length === 1 ? t('removeLastMember') : t('removeAccess')}
              className={
                selected.length === 1
                  ? 'inline-flex h-[15px] w-[15px] cursor-not-allowed items-center justify-center rounded-full text-(--text-tertiary) opacity-45'
                  : 'inline-flex h-[15px] w-[15px] cursor-pointer items-center justify-center rounded-full text-(--text-tertiary)'
              }
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
          placeholder={t('searchMembers')}
          className="min-w-[110px] flex-1 border-0 bg-transparent py-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-primary) outline-none"
        />
      </div>
      {selected.length === 0 && !open && (
        <div className="flex items-start gap-[7px] border-t border-(--border-subtle) bg-(--surface-sunken) px-3 py-[9px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="info" size={13} className="mt-[2px] flex-none" />
          <span>{t('selectAtLeastOne')}</span>
        </div>
      )}
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
                  ? t('noOtherMembers')
                  : availablePool.length === 0
                    ? t('everyoneSelected')
                    : t('noMembersMatch', { query: q })}
              </div>
            )}
          </div>
          <div className="flex items-start gap-[7px] border-t border-(--border-subtle) bg-(--surface-sunken) px-3 py-[9px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            <Icon name="info" size={13} className="mt-[2px] flex-none" />
            <span>{selected.length === 0 ? t('selectAtLeastOne') : t('atLeastOneMustRemain')}</span>
          </div>
        </>
      )}
    </div>
  )
}

// ── mobile: pills ────────────────────────────────────────────────────────────

function VisibilityPills({
  restricted,
  onPick,
  labels
}: {
  restricted: boolean
  onPick: (v: ResourceVisibility) => void
  labels?: { everyone: string; selected: string }
}) {
  const t = useTranslations('Common.visibility')
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
      {pill('org', labels?.everyone ?? t('everyone'))}
      {pill('restricted', labels?.selected ?? t('selected'))}
    </div>
  )
}

function ShareWithPills({ selected, onToggle }: { selected: string[]; onToggle: (userId: string) => void }) {
  const t = useTranslations('Common.visibility')
  const pool = useSharePool()

  return (
    <>
      <span className="fldlbl mt-[14px] block">{t('shareWith')}</span>
      <div className="mt-[6px] flex flex-wrap gap-2">
        {pool.map((m) => {
          const on = selected.includes(m.userId)
          const lastSelected = on && selected.length === 1
          return (
            <button
              key={m.userId}
              type="button"
              onClick={() => onToggle(m.userId)}
              title={lastSelected ? t('removeLastMember') : undefined}
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
            {t('noOtherMembers')}
          </span>
        )}
      </div>
      <div className="mt-[10px] flex items-start gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        <Icon name="info" size={13} className="mt-[2px] flex-none" />
        <span>{selected.length === 0 ? t('selectAtLeastOne') : t('atLeastOneMustRemain')}</span>
      </div>
    </>
  )
}

// ── read-only detail row ─────────────────────────────────────────────────────

export function VisibilityValue({ visibility, sharedWith }: { visibility: ResourceVisibility; sharedWith: string[] }) {
  const t = useTranslations('Common.visibility')
  const { members } = useConsoleData()
  if (visibility === 'org') {
    return (
      <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal">
        <Icon name="globe" size={13} color="var(--text-tertiary)" />
        {t('everyone')}
      </span>
    )
  }
  const resolved = members.filter((m) => m.role === 'owner' || sharedWith.includes(m.userId))
  const shown = resolved.slice(0, 3)
  const extra = resolved.length - shown.length
  const title =
    resolved.length > 0
      ? t('canAccess', { members: resolved.map(memberDisplayName).join(', ') })
      : t('restrictedResource')
  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <Icon name="lock" size={14} color="var(--text-tertiary)" className="flex-none" />
      {resolved.length === 0 ? (
        // Member details may still be loading; the tooltip states the owner exception either way.
        <span className="font-sans text-[12.5px] font-medium leading-normal">{t('selected')}</span>
      ) : (
        <span className="inline-flex">
          {shown.map((m, i) => (
            <span
              key={m.userId}
              // Repeat access on each avatar because its title replaces the parent tooltip.
              title={t('canAccess', { members: memberDisplayName(m) })}
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

// ── which agents read a knowledge entry (organization-knowledge.md §15.1) ─────

export interface AgentVisibilityValue {
  visibility: KnowledgeVisibility
  readers: string[]
}

/** The same field with All agents and Selected agents, and the agents to choose from; a selection may be empty. */
export function AgentVisibilityField({
  value,
  onChange,
  disabled
}: {
  value: AgentVisibilityValue
  onChange: (next: AgentVisibilityValue) => void
  disabled?: boolean
}) {
  const t = useTranslations('Common.visibility')
  const isMobile = useIsMobile()
  const selected = value.visibility === 'selected'
  const pick = (visibility: ResourceVisibility) => {
    if (!disabled) onChange({ ...value, visibility: visibility === 'restricted' ? 'selected' : 'all' })
  }
  const toggle = (agentId: string) => {
    if (disabled) return
    const has = value.readers.includes(agentId)
    onChange({ ...value, readers: has ? value.readers.filter((id) => id !== agentId) : [...value.readers, agentId] })
  }
  const labels = {
    everyone: t('allAgents'),
    everyoneDescription: t('allAgentsDescription'),
    selected: t('selectedAgents'),
    selectedDescription: t('selectedAgentsDescription')
  }
  return (
    <div className="fld mt-[14px]">
      <span className="fldlbl">{t('agentsLabel')}</span>
      {isMobile ? (
        <VisibilityPills restricted={selected} onPick={pick} labels={labels} />
      ) : (
        <VisibilityTiles restricted={selected} onPick={pick} labels={labels} />
      )}
      {selected && <AgentReaders selected={value.readers} onToggle={toggle} />}
    </div>
  )
}

function AgentMark({ agent, size }: { agent: Agent; size: number }) {
  return (
    <span
      className="inline-flex flex-none overflow-hidden rounded-[5px]"
      style={{ width: size, height: size }}
      title={agentLabel(agent)}
    >
      <AgentIconView icon={agent.icon} runtime={agent.runtime} size={size} />
    </span>
  )
}

/** The agents to choose from, each a toggle; one responsive tree, chips wrapping on a phone. */
function AgentReaders({ selected, onToggle }: { selected: string[]; onToggle: (agentId: string) => void }) {
  const t = useTranslations('Common.visibility')
  const { agents } = useConsoleData()
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const shown = agents.filter((agent) => !query || agentLabel(agent).toLowerCase().includes(query))
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-card)">
      <div className="flex items-center gap-[6px] border-b border-(--border-subtle) px-[11px] py-2">
        <Icon name="search" size={14} color="var(--text-tertiary)" className="flex-none" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchAgents')}
          className="min-w-[110px] flex-1 border-0 bg-transparent py-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-primary) outline-none"
        />
      </div>
      <div className="max-h-[180px] overflow-auto py-1">
        {shown.map((agent) => {
          const on = selected.includes(agent.id)
          return (
            <button
              key={agent.id}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(agent.id)}
              className="flex w-full cursor-pointer items-center gap-[10px] border-0 bg-transparent px-3 py-[6px] text-left hover:bg-(--surface-hover)"
            >
              <AgentMark agent={agent} size={22} />
              <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)">
                {agentLabel(agent)}
              </span>
              <Icon name={on ? 'check' : 'plus'} size={14} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
            </button>
          )
        })}
        {shown.length === 0 && (
          <div className="px-3 py-[10px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {agents.length === 0 ? t('noAgentsYet') : t('noAgentsMatch', { query: q })}
          </div>
        )}
      </div>
    </div>
  )
}

/** A row's visibility cell: All agents, or up to three agent marks with +N and the count, or No agents. */
export function AgentVisibilityCell({ visibility, readers }: AgentVisibilityValue) {
  const t = useTranslations('Common.visibility')
  const { agents } = useConsoleData()
  if (visibility === 'all')
    return (
      <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
        <Icon name="globe" size={13} color="var(--text-tertiary)" />
        {t('allAgents')}
      </span>
    )
  const readable = readers.map((id) => agents.find((agent) => agent.id === id)).filter((a): a is Agent => !!a)
  if (readable.length === 0)
    return (
      <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">{t('noAgents')}</span>
    )
  const shown = readable.slice(0, 3)
  const extra = readable.length - shown.length
  return (
    <span className="inline-flex min-w-0 items-center gap-[6px]" title={readable.map(agentLabel).join(', ')}>
      <span className="inline-flex flex-none items-center gap-[3px]">
        {shown.map((agent) => (
          <AgentMark key={agent.id} agent={agent} size={18} />
        ))}
        {extra > 0 && (
          <span className="font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">+{extra}</span>
        )}
      </span>
      <span className="truncate font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
        {t('agentCount', { count: readable.length })}
      </span>
    </span>
  )
}
