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
 * - Read-only viewers see a lock badge on private sessions, a provider audience
 *   badge on external sessions, and nothing on org sessions.
 * - `canChange` (server-computed: the identity-matched session owner only)
 *   renders the two-option control instead. Tightening (org → private)
 *   confirms through a dialog carrying the memory caveat; widening is immediate.
 * - `state === 'pending'` renders the spinner pill (DaemonLifecycleBadge
 *   pattern) until every affected daemon acks the change.
 */
import { useState } from 'react'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { putSessionVisibility, type MutableSessionVisibility, type SessionVisibility } from '@/lib/api'

export const SESSION_PRIVATE_TITLE = 'Private session — visible only to its owner'

export function SessionVisibilityControl({
  sessionId,
  visibility,
  state,
  canChange,
  externalProvider,
  externalResolution,
  nativeMemory = false,
  onChanged
}: {
  sessionId: string
  /** Effective visibility; undefined (legacy/mock rows) is treated as 'org'. */
  visibility: SessionVisibility | undefined
  /** §5.1 tighten cutover state; 'pending' renders the spinner pill. */
  state?: 'pending' | 'applied' | null
  canChange: boolean
  externalProvider?: string | null
  externalResolution?: 'pending' | 'settled' | 'invalid' | null
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
  const effective: SessionVisibility = visibility ?? 'org'

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
    if (busy || next === effective) return
    setError(null)
    // Tightening surfaces the memory caveat first; widening never cascades and
    // applies immediately.
    if (next === 'private') setConfirming(true)
    else void apply('org')
  }

  if (effective === 'external') {
    const provider = externalProvider === 'slack' ? 'Slack' : 'External'
    const title =
      externalResolution === 'settled'
        ? `Visible to current members of the source ${provider} conversation`
        : `${provider} membership could not be resolved; access is fail-closed`
    return (
      <span
        title={title}
        className="inline-flex items-center gap-[5px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)"
      >
        <Icon name="users" size={13} color="var(--text-tertiary)" />
        {provider} members
        {state === 'pending' && <Spinner size={10} />}
      </span>
    )
  }

  if (!canChange) {
    // Org sessions carry no badge — org is the unmarked default.
    if (effective !== 'private') return null
    return (
      <span
        title={SESSION_PRIVATE_TITLE}
        className="inline-flex items-center gap-[5px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)"
      >
        <Icon name="lock" size={13} color="var(--text-tertiary)" />
        Private
      </span>
    )
  }

  const segment = (v: MutableSessionVisibility, icon: string, label: string, title: string) => {
    const on = effective === v
    return (
      <button
        type="button"
        title={title}
        disabled={busy}
        onClick={() => pick(v)}
        className={
          on
            ? 'inline-flex items-center gap-1 border-0 bg-(--brand-soft) px-[9px] py-[3px] font-sans text-[11.5px] font-semibold leading-normal text-(--brand)'
            : 'inline-flex cursor-pointer items-center gap-1 border-0 bg-(--surface-card) px-[9px] py-[3px] font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) transition-[background-color,color] hover:bg-(--surface-hover) hover:text-(--text-primary)'
        }
      >
        <Icon name={icon} size={11} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
        {label}
      </button>
    )
  }

  return (
    <span className="inline-flex items-center gap-[6px]">
      <span className="inline-flex overflow-hidden rounded-full border border-(--border-default)">
        {segment('org', 'globe', 'Everyone', 'Visible to everyone who can view the agent')}
        {segment('private', 'lock', 'Private', SESSION_PRIVATE_TITLE)}
      </span>
      {state === 'pending' && (
        <span
          title={
            nativeMemory
              ? 'Waiting for the owning daemon to confirm the change'
              : 'Waiting for the owning daemon to confirm the change — capture stops at daemon acknowledgement'
          }
          className="inline-flex flex-none items-center gap-1 rounded-full border border-(--brand) bg-(--surface-sunken) py-[1px] pr-[7px] pl-[5px] font-sans text-[10.5px] font-semibold leading-normal text-(--brand)"
        >
          <Spinner size={10} />
          Applying…
        </span>
      )}
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
