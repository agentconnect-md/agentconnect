'use client'

/**
 * The "Run again" action for a Gitea trigger session, the counterpart of
 * `GitlabRerunButton`. Gitea has no native re-run control either, so this button
 * is the console's replacement for it.
 *
 * It names only the thread's subject: the Control Plane reads the pull request's
 * current head itself, so the console can never re-run a stale revision. Absent —
 * never disabled — for anything that is not a Gitea hook session on a
 * pull-request or issue thread.
 *
 * State is SUBJECT-SCOPED. The session detail view stays mounted across
 * `/sessions/a` → `/sessions/b`, so busy/started/error belong to the subject they
 * were produced for: a different subject renders pristine, and a reply that lands
 * after the reader moved on is dropped instead of painting the new thread.
 */
import { useState } from 'react'
import { Icon } from '@/components/ui'
import { ApiError, rerunGiteaHook } from '@/lib/api'
import { parseGiteaHookThread } from '@/lib/gitea-events'
import type { HookKind } from '@/lib/api'

// The CP answers a machine category in `code`; these are the ones a reader can act on, in
// Gitea's vocabulary. An unmapped code is an implementation identifier and never belongs on
// this surface — it collapses to the generic line below.
const REFUSAL: Record<string, string> = {
  GITEA_NOT_CONFIGURED: 'Gitea is not set up on this deployment',
  HOOK_NOT_GITEA: 'This trigger is not a Gitea trigger',
  HOOK_DISABLED: 'This trigger is turned off',
  AGENT_UNAVAILABLE: 'The agent this trigger runs is paused or gone',
  BINDING_INACTIVE: 'This Gitea repository is no longer connected',
  DISPATCH_UNAVAILABLE: 'This trigger cannot run right now — check the agent',
  SUBJECT_NOT_FOUND: 'That pull request or issue no longer exists',
  SUBJECT_CLOSED: 'That pull request or issue is closed on Gitea',
  HEAD_UNAVAILABLE: 'Gitea reported no current revision to run against',
  GITEA_UNAVAILABLE: 'Gitea could not be reached',
  RELAY_REJECTED: 'The run was not accepted — try again shortly',
  RELAY_AMBIGUOUS: 'The run could not be confirmed — check this trigger’s runs',
  RELAY_UNAVAILABLE: 'Nothing is connected to run this trigger'
}

// A RELAY_REJECTED body also names WHICH refusal, which is the difference between
// "still loading" and "you have run this enough for now".
const RELAY_REFUSAL: Record<string, string> = {
  replay_pending: 'This trigger is still loading — try again shortly',
  rule_mismatch: 'This trigger changed while the run was starting — try again',
  limiter_exhausted: 'This trigger has run too many times just now — try again later'
}

function refusalText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Could not run this trigger again'
  const relayCode = e.details?.relayCode
  if (typeof relayCode === 'string' && RELAY_REFUSAL[relayCode]) return RELAY_REFUSAL[relayCode]
  return (e.code && REFUSAL[e.code]) || 'Could not run this trigger again'
}

interface RerunState {
  /** The subject this state describes; anything else renders pristine. */
  key: string
  busy: boolean
  err: string | null
  started: boolean
}

const PRISTINE: Omit<RerunState, 'key'> = { busy: false, err: null, started: false }

export function GiteaRerunButton({
  hookKind,
  hookId,
  thread,
  className
}: {
  hookKind: HookKind | null | undefined
  /** The hook this session belongs to — the session's channel id. */
  hookId: string | null | undefined
  /** The session's §8 thread key. */
  thread: string | null | undefined
  className?: string
}) {
  const [state, setState] = useState<RerunState>({ key: '', ...PRISTINE })
  const subject = parseGiteaHookThread(thread)
  const subjectKey = `${hookId ?? ''}:${thread ?? ''}`
  if (hookKind !== 'gitea' || !hookId || !subject) return null

  // State belongs to the subject it was produced for; every other subject is pristine.
  const view = state.key === subjectKey ? state : PRISTINE

  const run = () => {
    const key = subjectKey
    setState({ key, busy: true, err: null, started: false })
    // Fence the completion on the subject captured at request time: a reply for a thread the
    // reader has left must not overwrite the one on screen.
    const settle = (next: Omit<RerunState, 'key'>) => setState((prev) => (prev.key === key ? { key, ...next } : prev))
    rerunGiteaHook(hookId, subject).then(
      () => settle({ ...PRISTINE, started: true }),
      (e: unknown) => settle({ ...PRISTINE, err: refusalText(e) })
    )
  }

  return (
    <span className={`flex min-w-0 flex-none items-center gap-[6px] ${className ?? ''}`}>
      <button
        type="button"
        data-gitea-rerun=""
        onClick={run}
        disabled={view.busy}
        title="Run this Gitea trigger again for the current revision"
        className="inline-flex h-[22px] flex-none items-center gap-1 rounded-md border-0 bg-transparent px-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon name="refresh-cw" size={13} />
        Run again
      </button>
      {view.err ? (
        <span
          data-gitea-rerun-error=""
          title={view.err}
          className="min-w-0 truncate font-sans text-[11.5px] font-normal leading-normal text-(--status-error)"
        >
          {view.err}
        </span>
      ) : view.started ? (
        <span
          data-gitea-rerun-started=""
          className="min-w-0 truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          Started
        </span>
      ) : null}
    </span>
  )
}
