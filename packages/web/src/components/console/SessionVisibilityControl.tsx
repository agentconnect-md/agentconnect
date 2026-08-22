// No 'use client' here: this module is imported only by client components
// (SessionDetailView), so it's already in the client bundle — and keeping the
// directive off avoids Next's "props must be serializable" entry-file check on
// the onChanged callback.

/**
 * Session-level visibility badge + toggle (docs/designs/session-visibility.md
 * §4.3/§5.1/§6). Sessions use their own visibility enum (`org`, `private`, or
 * provider-managed `external`) — this deliberately mirrors VisibilityField's
 * look without reusing its ResourceVisibility (`org` | `restricted`) types or
 * share-set machinery.
 *
 * - Read-only viewers see the same inline audience indicator for private, org,
 *   and provider-managed sessions.
 * - `canChange` (server-computed: the identity-matched session owner only)
 *   renders a two-option dropdown instead. Tightening (org → private)
 *   confirms through a dialog carrying the memory caveat; widening is immediate.
 * - `state === 'pending'` replaces the chevron with a spinner until every
 *   affected daemon acks the change.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { putSessionVisibility, type MutableSessionVisibility, type SessionVisibility } from '@/lib/api'

export const SESSION_PRIVATE_TITLE = 'Visible only to me'
export const SESSION_EVERYONE_TITLE = 'Visible to everyone in the org'

export function SessionVisibilityControl({
  sessionId,
  visibility,
  state,
  canChange,
  loading = false,
  externalProvider,
  externalResolution,
  feishuRegion,
  nativeMemory = false,
  onChanged
}: {
  sessionId: string
  /** Effective visibility; undefined (legacy/mock rows) is treated as 'org'. */
  visibility: SessionVisibility | undefined
  /** §5.1 tighten cutover state; 'pending' renders the spinner pill. */
  state?: 'pending' | 'applied' | null
  canChange: boolean
  /** The session exists locally, but its authoritative visibility row is not
   *  readable yet. Keeps the fail-closed default in place without exposing a
   *  control that would PUT against a session the server cannot resolve. */
  loading?: boolean
  externalProvider?: string | null
  externalResolution?: 'pending' | 'settled' | 'invalid' | null
  feishuRegion?: 'feishu' | 'lark' | null
  /** The owning agent persists memory inside its runtime (provider `native`),
   *  which has no per-session gate — so the copy must NOT promise that going
   *  private stops what the agent learns. See docs/product-conventions.md. */
  nativeMemory?: boolean
  /** Reflect the PUT response into the caller's caches (detail SWR + lists). */
  onChanged: (next: { visibility: SessionVisibility; state: 'pending' | 'applied' }) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const headingId = useId()
  const effective: SessionVisibility = visibility ?? 'org'

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const apply = async (next: MutableSessionVisibility) => {
    setBusy(true)
    setError(null)
    try {
      const result = await putSessionVisibility(sessionId, next)
      setConfirming(false)
      onChanged({ visibility: result.visibility, state: result.state })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = (next: MutableSessionVisibility) => {
    if (busy) return
    setOpen(false)
    if (next === effective) return
    setError(null)
    // Tightening surfaces the memory caveat first; widening never cascades and
    // applies immediately.
    if (next === 'private') setConfirming(true)
    else void apply('org')
  }

  if (loading) {
    const privateSession = effective === 'private'
    return (
      <span
        title="Setting up session access"
        aria-label={`Session visibility: ${privateSession ? 'Private' : 'Everyone'} (loading)`}
        className="inline-flex h-[26px] flex-none items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)"
      >
        <Icon name={privateSession ? 'lock' : 'globe'} size={13} color="var(--text-tertiary)" />
        {privateSession ? 'Private' : 'Everyone'}
        <Spinner size={10} />
      </span>
    )
  }

  if (effective === 'external') {
    const github = externalProvider === 'github'
    const slack = externalProvider === 'slack'
    const provider = slack
      ? 'Slack'
      : github
        ? 'GitHub'
        : externalProvider === 'feishu'
          ? feishuRegion === 'lark'
            ? 'Lark'
            : feishuRegion === 'feishu'
              ? 'Feishu'
              : 'Feishu/Lark'
          : 'External'
    const title =
      externalResolution === 'settled'
        ? github
          ? 'Visible to everyone who can access the repo'
          : slack
            ? 'Visible to everyone who can access the channel'
            : 'Visible to everyone who can access the conversation'
        : `${provider} access could not be verified; this session remains hidden`
    return (
      <span
        title={title}
        className="inline-flex h-[26px] flex-none items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)"
      >
        <Icon name="users" size={13} color="var(--text-tertiary)" />
        {`${provider} members`}
        {state === 'pending' && <Spinner size={10} />}
      </span>
    )
  }

  if (!canChange) {
    const privateSession = effective === 'private'
    return (
      <span
        title={privateSession ? SESSION_PRIVATE_TITLE : SESSION_EVERYONE_TITLE}
        className="inline-flex h-[26px] flex-none items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)"
      >
        <Icon name={privateSession ? 'lock' : 'globe'} size={13} color="var(--text-tertiary)" />
        {privateSession ? 'Private' : 'Everyone'}
        {state === 'pending' && <Spinner size={10} />}
      </span>
    )
  }

  const choices: Array<{
    value: MutableSessionVisibility
    icon: string
    label: string
    description: string
  }> = [
    { value: 'org', icon: 'globe', label: 'Everyone', description: SESSION_EVERYONE_TITLE },
    { value: 'private', icon: 'lock', label: 'Private', description: SESSION_PRIVATE_TITLE }
  ]
  const current = choices.find((choice) => choice.value === effective) ?? choices[0]!
  const closeAndFocus = () => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndFocus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const index = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement))
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
    options[next]?.focus()
  }

  return (
    <span className="inline-flex items-center gap-[6px]">
      {/* Positioned only on desktop: on mobile the trigger sits mid-header, so a
        300px menu anchored to it runs off the left screen edge — un-positioning
        the wrapper lets the menu anchor to the (relative) mobile header row and
        align to its right gutter instead, like the Details dialog. */}
      <span ref={wrapRef} className="inline-flex flex-none desktop:relative">
        <button
          ref={triggerRef}
          type="button"
          title={
            state === 'pending'
              ? nativeMemory
                ? 'Waiting for the owning daemon to confirm the change'
                : 'Waiting for the owning daemon to confirm the change — capture stops at daemon acknowledgement'
              : current.description
          }
          disabled={busy}
          aria-label={`Session visibility: ${current.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className="inline-flex h-[26px] cursor-pointer items-center gap-[6px] rounded-sm border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) hover:text-(--brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:cursor-default disabled:opacity-60"
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            setOpen(true)
          }}
        >
          <Icon name={current.icon} size={13} color="var(--text-tertiary)" />
          {current.label}
          {state === 'pending' ? (
            <Spinner size={10} />
          ) : (
            <Icon name="chevron-down" size={12} color="var(--text-tertiary)" />
          )}
        </button>
        {open && (
          <div
            id={menuId}
            role="menu"
            aria-labelledby={headingId}
            className="absolute top-[calc(100%+7px)] left-0 z-50 w-[300px] max-w-[calc(100vw-32px)] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg) max-desktop:top-full max-desktop:right-4 max-desktop:left-auto"
            onKeyDown={moveFocus}
          >
            <span id={headingId} className="sr-only">
              Session visibility
            </span>
            {choices.map((choice) => {
              const selected = choice.value === effective
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  autoFocus={selected}
                  className={`flex w-full cursor-pointer items-start gap-[10px] rounded-md border-0 px-3 py-[9px] text-left ${
                    selected
                      ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                      : 'bg-transparent text-(--text-primary) hover:bg-(--surface-hover)'
                  }`}
                  onClick={() => pick(choice.value)}
                >
                  <Icon name={choice.icon} size={16} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-sans text-[13px] font-semibold leading-normal">{choice.label}</span>
                    <span className="mt-[2px] block font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {choice.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </span>
      {error && !confirming && (
        <span role="alert" className="font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">
          {error}
        </span>
      )}
      {confirming && (
        <ConfirmationDialog
          title="Make this session private?"
          confirmLabel="Make private"
          busy={busy}
          error={error}
          onConfirm={() => void apply('private')}
          onClose={() => {
            setConfirming(false)
            setError(null)
          }}
        >
          {nativeMemory ? (
            <>
              Making this session private hides the transcript from other members immediately. It does{' '}
              <strong>not</strong> affect this agent&rsquo;s memory: it runs on its runtime&rsquo;s own memory, which
              has no per-session control, so what the agent learns here can still surface in other people&rsquo;s
              sessions.
            </>
          ) : (
            <>
              Making this session private stops it from feeding shared agent memory once the daemon confirms, and hides
              the transcript immediately. Anything the agent already learned while it was visible to everyone is not
              removed.
            </>
          )}
        </ConfirmationDialog>
      )}
    </span>
  )
}
