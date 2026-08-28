'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Agent, AgentCallPolicy, DaemonRow, MemberSetRow } from '@/lib/data'
import { agentCapabilitySource, agentDaemonLabel, agentLabel, agentModelDisplay } from '@/lib/data'
import { AgentIconView } from '@/components/marks'
import { Icon } from '@/components/ui'

// The "Agent visibility" control — which peer agents may call this agent as a
// sub-agent (`all` = any org peer, or a `selected` allow-list). It is a
// CONTROLLED, presentational component: the parent owns `mode`/`selectedIds`
// and reacts to `onChange`. `AgentVisibilityCard` wraps it with save-on-change
// for an existing agent; the Add-agent modal wraps it with plain local state.
export interface AgentCallVisibilityProps {
  /** Whether this control gates callers into the agent or targets from it. */
  direction?: 'inbound' | 'outbound'
  mode: AgentCallPolicy
  /** Selected caller agent ids; meaningful under `selected` but preserved under
   *  `all` so toggling back restores the chips. */
  selectedIds: string[]
  /** Peers whose opposite-direction policy also agrees, so the configured
   *  relationship is currently a direct path. Detail-card sections only. */
  effectivePeerIds?: string[]
  /** Candidate caller agents — the parent has already excluded the target. */
  peers: Agent[]
  daemons: DaemonRow[]
  /** The org's groups — a placement may name one, and without them it reads as Cloud. */
  groups: MemberSetRow[]
  /** What the copy calls the target ("deploy-bot" mono, or "this agent"). */
  target: ReactNode
  onChange: (mode: AgentCallPolicy, selectedIds: string[]) => void
  /** false ⇒ read-only (viewer / no edit rights). */
  editable?: boolean
  /** An immediate save is in flight — disable inputs without dropping edit rights. */
  busy?: boolean
  error?: string | null
  /** `card` = standalone card; `inline` = modal form control; `section` = one
   *  direction inside the combined agent-detail visibility card. */
  variant?: 'card' | 'inline' | 'section'
  /** Extra classes for the root (e.g. the detail grid's `order-*`). */
  className?: string
}

/** Stands in for granted peers this viewer can't resolve (restricted agents are
 *  filtered out of `/agents`, yet their grants remain active and are preserved
 *  by the CP on save). Without it the allow-list would under-report itself. */
function HiddenSelectionChip({ count, note }: { count: number; note?: string }) {
  return (
    <span
      title={note}
      className="flex h-6 flex-none items-center gap-[5px] rounded-full border border-dashed border-(--border-default) pr-[9px] pl-[7px]"
    >
      <Icon name="eye-off" size={12} color="var(--text-tertiary)" className="flex-none" />
      <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)">
        {count} not visible
      </span>
    </span>
  )
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

const segOn =
  'flex cursor-pointer items-center justify-center rounded-[5px] border-0 bg-(--surface-card) px-3 font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary) shadow-(--shadow-xs) disabled:cursor-default'
const segOff =
  'flex cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent px-3 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) disabled:cursor-default'

export function AgentCallVisibility({
  direction = 'inbound',
  mode,
  selectedIds,
  effectivePeerIds,
  peers,
  daemons,
  groups,
  target,
  onChange,
  editable = true,
  busy = false,
  error,
  variant = 'card',
  className
}: AgentCallVisibilityProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const peerIds = useMemo(() => new Set(peers.map((p) => p.id)), [peers])
  const visibleSelected = useMemo(() => selectedIds.filter((id) => peerIds.has(id)), [selectedIds, peerIds])
  const selectedPeers = useMemo(
    () => visibleSelected.flatMap((id) => peers.find((p) => p.id === id) ?? []),
    [peers, visibleSelected]
  )
  // Grants can point at peers this viewer cannot see: `/agents` hides restricted
  // agents from non-owners, and the CP's resolvePolicyAgentIds deliberately
  // RETAINS those existing grants when a collaborator edits the policy. So an
  // unresolvable id is an active grant we must still account for — never treat
  // `selectedPeers.length === 0` as "nothing is selected".
  const uniqueSelectedIds = useMemo(() => [...new Set(selectedIds)], [selectedIds])
  const hiddenSelectedCount = useMemo(
    () => uniqueSelectedIds.filter((id) => !peerIds.has(id)).length,
    [uniqueSelectedIds, peerIds]
  )
  const selectedTotal = selectedPeers.length + hiddenSelectedCount
  const hiddenSelectedNote =
    hiddenSelectedCount > 0
      ? `${hiddenSelectedCount} selected ${plural(hiddenSelectedCount, 'agent')} ${
          hiddenSelectedCount === 1 ? 'is' : 'are'
        } restricted and not visible to you.`
      : undefined
  const policyPeers = mode === 'all' ? peers : selectedPeers
  const effectivePeerIdSet = useMemo(() => new Set(effectivePeerIds ?? []), [effectivePeerIds])
  const effectivePeers = useMemo(
    () => policyPeers.filter((peer) => effectivePeerIdSet.has(peer.id)),
    [effectivePeerIdSet, policyPeers]
  )
  const blockedPeers = useMemo(
    () => policyPeers.filter((peer) => !effectivePeerIdSet.has(peer.id)),
    [effectivePeerIdSet, policyPeers]
  )
  const availablePeers = useMemo(() => peers.filter((p) => !selectedIds.includes(p.id)), [peers, selectedIds])

  const filteredPeers = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return availablePeers
    return availablePeers.filter((candidate) =>
      [
        agentLabel(candidate),
        candidate.name,
        candidate.model,
        candidate.runtime,
        agentDaemonLabel(candidate, daemons, groups)
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [availablePeers, daemons, groups, query])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const pickMode = (next: AgentCallPolicy) => {
    if (next === mode) return
    setOpen(false)
    setQuery('')
    // Keep the working selection when leaving `selected` so returning restores it.
    onChange(next, selectedIds)
  }

  const toggleAgent = (callerAgentId: string) => {
    const next = selectedIds.includes(callerAgentId)
      ? selectedIds.filter((id) => id !== callerAgentId)
      : [...selectedIds, callerAgentId]
    onChange('selected', next)
  }

  // Read-only surfaces (the agent page's Access card, or a viewer without
  // sharing rights) must not render a segmented toggle and a search box that
  // look editable but silently do nothing. They get the state as a plain line
  // plus a non-interactive peer list instead — same card, honest affordances.
  const toggle = !editable ? (
    <div className="flex items-center gap-2">
      <Icon name={mode === 'all' ? 'globe' : 'lock'} size={13} color="var(--text-tertiary)" className="flex-none" />
      <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
        {mode === 'all' ? 'All agents' : 'Selected agents'}
      </span>
    </div>
  ) : (
    <div
      className={
        variant === 'section'
          ? 'grid h-8 w-full flex-none grid-cols-2 gap-[2px] rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken) p-[3px]'
          : 'flex h-7 flex-none gap-[2px] rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken) p-[3px]'
      }
      role="group"
      aria-label={direction === 'inbound' ? 'Inbound agent visibility' : 'Outbound agent visibility'}
    >
      <button
        type="button"
        aria-pressed={mode === 'all'}
        disabled={!editable || busy}
        onClick={() => pickMode('all')}
        className={mode === 'all' ? segOn : segOff}
      >
        All agents
      </button>
      <button
        type="button"
        aria-pressed={mode === 'selected'}
        disabled={!editable || busy}
        onClick={() => pickMode('selected')}
        className={mode === 'selected' ? segOn : segOff}
      >
        Selected
      </button>
    </div>
  )

  const allAgentsSummary =
    effectivePeerIds === undefined || effectivePeers.length === policyPeers.length ? (
      direction === 'inbound' ? (
        <>{target} accepts calls from all agents.</>
      ) : (
        <>{target} can call all agents.</>
      )
    ) : direction === 'inbound' ? (
      <>
        {target} accepts calls from {effectivePeers.length} of {policyPeers.length}{' '}
        {plural(policyPeers.length, 'agent')}.
      </>
    ) : (
      <>
        {target} can call {effectivePeers.length} of {policyPeers.length} {plural(policyPeers.length, 'agent')}.
      </>
    )
  const blockedCallersTitle =
    direction === 'outbound' && effectivePeerIds !== undefined && blockedPeers.length > 0
      ? `${blockedPeers.map(agentLabel).join(', ')} can't accept this agent's call.`
      : undefined

  const body =
    mode === 'all' ? (
      <div className="grid min-h-[60px] grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-2 desktop:flex">
        <div className="flex flex-none -space-x-1">
          {peers.slice(0, 3).map((peer) => (
            <span
              key={peer.id}
              className="flex h-5 w-5 items-center justify-center rounded-xs border border-(--surface-card) bg-(--surface-sunken) shadow-(--shadow-xs) [&>svg]:h-full [&>svg]:w-full"
            >
              <AgentIconView icon={peer.icon} runtime={peer.runtime} size={20} />
            </span>
          ))}
          {peers.length > 3 && (
            <span className="flex h-5 w-5 items-center justify-center rounded-xs border border-(--surface-card) bg-(--surface-active) font-sans text-[9px] font-semibold leading-normal text-(--text-secondary) shadow-(--shadow-xs)">
              +{peers.length - 3}
            </span>
          )}
        </div>
        <div
          title={blockedCallersTitle}
          className="min-w-0 flex-1 font-sans text-[13px] font-normal leading-[1.45] text-(--text-secondary)"
        >
          {peers.length === 0 ? <>No other agents are available yet.</> : allAgentsSummary}
        </div>
      </div>
    ) : !editable ? (
      // Read-only `selected`: the chosen peers as plain chips — no search field,
      // no remove buttons, nothing that invites an edit this surface can't make.
      <div className="min-h-[60px] px-4 py-[14px]">
        {selectedTotal === 0 ? (
          <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            No agents selected.
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-[6px]">
            {selectedPeers.map((peer) => (
              // `displayName` is unbounded, so the chip must be able to shrink and
              // clip inside this wrapping row — otherwise one long name paints over
              // the neighbouring direction card (desktop) or past the card edge.
              <span
                key={peer.id}
                className="flex h-6 max-w-full min-w-0 items-center gap-[5px] rounded-full bg-(--surface-active) pr-[9px] pl-[5px]"
              >
                <span className="flex h-4 w-4 flex-none items-center justify-center rounded-xs border border-(--border-subtle) bg-(--surface-card) [&>svg]:h-full [&>svg]:w-full">
                  <AgentIconView icon={peer.icon} runtime={peer.runtime} size={16} />
                </span>
                <span
                  title={agentLabel(peer)}
                  className="truncate font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)"
                >
                  {agentLabel(peer)}
                </span>
              </span>
            ))}
            {hiddenSelectedCount > 0 && <HiddenSelectionChip count={hiddenSelectedCount} note={hiddenSelectedNote} />}
          </div>
        )}
      </div>
    ) : (
      <div className="relative min-h-[60px] px-4 py-[14px]">
        <div className="flex h-8 items-center gap-2 overflow-x-auto rounded-md border border-(--border-subtle) bg-(--surface-card) px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Icon name="search" size={16} color="var(--text-tertiary)" className="flex-none" />
          {selectedPeers.map((peer) => (
            <span
              key={peer.id}
              className="flex h-6 flex-none items-center gap-[5px] rounded-full bg-(--surface-active) pr-[7px] pl-[5px]"
            >
              <span className="flex h-4 w-4 flex-none items-center justify-center rounded-xs border border-(--border-subtle) bg-(--surface-card) [&>svg]:h-full [&>svg]:w-full">
                <AgentIconView icon={peer.icon} runtime={peer.runtime} size={16} />
              </span>
              <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)">
                {agentLabel(peer)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${agentLabel(peer)}`}
                disabled={!editable || busy}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleAgent(peer.id)
                }}
                className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 disabled:cursor-default"
              >
                <Icon name="x" size={12} color="var(--text-tertiary)" />
              </button>
            </span>
          ))}
          {/* Grants to peers this editor can't see are preserved by the CP on
              save — surface them so the row never reads as a smaller allow-list
              than the one actually stored. */}
          {hiddenSelectedCount > 0 && <HiddenSelectionChip count={hiddenSelectedCount} note={hiddenSelectedNote} />}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setOpen(true)}
            placeholder="Search agents..."
            disabled={!editable || busy}
            className="h-full min-w-[92px] flex-1 border-0 bg-transparent p-0 font-sans text-[13px] font-normal leading-normal text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
          />
        </div>

        {open && (
          <div className="absolute top-[calc(100%-7px)] right-4 left-4 z-40 overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-md)">
            <div className="max-h-[224px] overflow-y-auto">
              {filteredPeers.length > 0 ? (
                filteredPeers.map((peer) => (
                  <button
                    key={peer.id}
                    type="button"
                    disabled={!editable || busy}
                    onClick={() => toggleAgent(peer.id)}
                    className="flex min-h-12 w-full cursor-pointer items-center gap-[10px] border-0 bg-(--surface-card) px-3 py-2 text-left hover:bg-(--surface-hover) disabled:cursor-default disabled:hover:bg-(--surface-card)"
                  >
                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-sm border border-(--border-subtle) bg-(--surface-sunken) [&>svg]:h-full [&>svg]:w-full">
                      <AgentIconView icon={peer.icon} runtime={peer.runtime} size={28} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                        {agentLabel(peer)}
                      </span>
                      <span className="truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                        {agentModelDisplay(agentCapabilitySource(peer, daemons, groups), peer.runtime, peer.model)}
                      </span>
                    </span>
                    <span className="max-w-[90px] flex-none truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      {agentDaemonLabel(peer, daemons, groups)}
                    </span>
                  </button>
                ))
              ) : (
                <div className="flex min-h-24 items-center justify-center px-4 py-6 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                  {availablePeers.length === 0 ? 'All agents are selected' : 'No matching agents'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    )

  const errorRow = error ? (
    <div
      role="alert"
      className="border-t border-(--border-subtle) px-4 py-2 font-sans text-[12px] font-medium leading-normal text-(--status-error)"
    >
      {error}
    </div>
  ) : null

  // Whether ANYTHING is granted counts hidden peers (else a restricted-but-
  // invisible selection reads as "No peers selected"), but the reachability
  // FRACTION must not: `effectivePeerIds` is computed over the viewer-filtered
  // roster, so no reciprocal policy was ever evaluated for a hidden peer. Mixing
  // a visible-only numerator into a visible+hidden denominator would state an
  // exact negative about something unknown, so the unknown part is reported
  // separately rather than folded into the fraction.
  const hasSelection = mode === 'all' ? policyPeers.length > 0 : selectedTotal > 0
  const evaluatedCount = policyPeers.length
  const relationshipLabel = direction === 'inbound' ? 'Can call this agent' : 'This agent can call'
  const effectiveSummary =
    effectivePeerIds !== undefined && mode === 'selected' ? (
      <div
        className={`flex items-center justify-between gap-3 border-t border-(--border-subtle) bg-(--surface-sunken) px-3 py-[9px]${
          variant === 'section' && !error ? ' rounded-b-[7px]' : ''
        }`}
      >
        <span className="flex min-w-0 items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)">
          <Icon
            name={hasSelection ? 'arrow-left-right' : 'users'}
            size={13}
            color="var(--text-tertiary)"
            className="flex-none"
          />
          {hasSelection ? relationshipLabel : 'No peers selected'}
        </span>
        {hasSelection && (
          <span className="flex flex-none items-center gap-[6px] font-mono text-[11px] font-semibold leading-normal text-(--text-primary)">
            {evaluatedCount > 0 && (
              <span>
                {effectivePeers.length} of {evaluatedCount}
              </span>
            )}
            {hiddenSelectedCount > 0 && (
              <span title={hiddenSelectedNote} className="font-medium text-(--text-tertiary)">
                {hiddenSelectedCount} unknown
              </span>
            )}
          </span>
        )}
      </div>
    ) : null

  if (variant === 'section') {
    return (
      <div
        ref={rootRef}
        aria-busy={busy}
        className="overflow-visible rounded-md border border-(--border-default) bg-(--surface-card)"
      >
        <div className="p-3">
          <div className="flex items-start gap-[10px]">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--brand-soft) text-(--brand)">
              <Icon name={direction === 'inbound' ? 'arrow-down-left' : 'arrow-up-right'} size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-sans text-[10.5px] font-semibold leading-normal tracking-[.05em] text-(--text-tertiary) uppercase">
                {direction === 'inbound' ? 'Inbound' : 'Outbound'}
              </div>
              <div className="mt-1 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                {direction === 'inbound' ? 'Which agents can call this agent?' : 'Which agents can this agent call?'}
              </div>
            </div>
          </div>
          <div className="mt-3">{toggle}</div>
        </div>
        <div className="border-t border-(--border-subtle)">{body}</div>
        {effectiveSummary}
        {errorRow}
      </div>
    )
  }

  if (variant === 'inline') {
    return (
      <div ref={rootRef} aria-busy={busy} className={`fld${className ? ` ${className}` : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="fldlbl">Agent visibility</span>
          {toggle}
        </div>
        <div className="overflow-visible rounded-md border border-(--border-subtle) bg-(--surface-card)">
          {body}
          {errorRow}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      aria-busy={busy}
      className={`card relative max-desktop:rounded-lg${className ? ` ${className}` : ''}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-(--border-subtle) px-4 py-3 desktop:gap-3 desktop:py-[13px]">
        <span className="whitespace-nowrap font-sans text-[14px] font-semibold leading-normal">Agent visibility</span>
        {toggle}
      </div>
      {body}
      {errorRow}
    </div>
  )
}
