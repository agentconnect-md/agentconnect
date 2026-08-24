'use client'

/**
 * The "Run again" action for a GitLab trigger session (gitlab-com-integration.md
 * §16.1). GitLab has no native re-run control, so this button is the console's
 * replacement for it.
 *
 * It names only the thread's subject: the Control Plane reads the merge
 * request's current head itself, so the console can never re-run a stale
 * revision. Absent — never disabled — for anything that is not a GitLab hook
 * session on a merge-request or issue thread.
 *
 * State is SUBJECT-SCOPED. The session detail view stays mounted across
 * `/sessions/a` → `/sessions/b`, so busy/started/error belong to the subject
 * they were produced for: a different subject renders pristine, and a reply that
 * lands after the reader moved on is dropped instead of painting the new thread.
 */
import { useState } from 'react'
import { Icon } from '@/components/ui'
import { ApiError, rerunGitlabHook } from '@/lib/api'
import { parseGitlabHookThread } from '@/lib/gitlab-events'
import type { HookKind } from '@/lib/api'

// The CP answers a machine category in `code`; these are the ones a reader can act
// on, in GitLab vocabulary. An unmapped code is an implementation identifier and
// never belongs on this surface — it collapses to the generic line below.
const REFUSAL: Record<string, string> = {
  GITLAB_NOT_CONFIGURED: 'GitLab is not set up on this deployment',
  HOOK_NOT_GITLAB: 'This trigger is not a GitLab trigger',
  HOOK_DISABLED: 'This trigger is turned off',
  AGENT_UNAVAILABLE: 'The agent this trigger runs is paused or gone',
  BINDING_INACTIVE: 'This GitLab project is no longer connected',
  DISPATCH_UNAVAILABLE: 'This trigger cannot run right now — check the agent',
  SUBJECT_NOT_FOUND: 'That merge request or issue no longer exists',
  SUBJECT_CLOSED: 'That merge request or issue is closed on GitLab',
  HEAD_UNAVAILABLE: 'GitLab reported no current revision to run against',
  GITLAB_UNAVAILABLE: 'GitLab could not be reached',
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

export function GitlabRerunButton({
  hookKind,
  hookId,
  thread,
  className
}: {
  hookKind: HookKind | null | undefined
  /** The hook this session belongs to — the session's channel id. */
  hookId: string | null | undefined
  /** The session's §12.3 thread key. */
  thread: string | null | undefined
  className?: string
}) {
  const [state, setState] = useState<RerunState>({ key: '', ...PRISTINE })
  const subject = parseGitlabHookThread(thread)
  const subjectKey = `${hookId ?? ''}:${thread ?? ''}`
  if (hookKind !== 'gitlab' || !hookId || !subject) return null

  // State belongs to the subject it was produced for; every other subject is pristine.
  const view = state.key === subjectKey ? state : PRISTINE

  const run = () => {
    const key = subjectKey
    setState({ key, busy: true, err: null, started: false })
    // Fence the completion on the subject captured at request time: a reply for
    // a thread the reader has left must not overwrite the one on screen.
    const settle = (next: Omit<RerunState, 'key'>) => setState((prev) => (prev.key === key ? { key, ...next } : prev))
    rerunGitlabHook(hookId, subject).then(
      () => settle({ ...PRISTINE, started: true }),
      (e: unknown) => settle({ ...PRISTINE, err: refusalText(e) })
    )
  }

  return (
    <span className={`flex min-w-0 flex-none items-center gap-[6px] ${className ?? ''}`}>
      <button
        type="button"
        data-gitlab-rerun=""
        onClick={run}
        disabled={view.busy}
        title="Run this GitLab trigger again for the current revision"
        className="inline-flex h-[22px] flex-none items-center gap-1 rounded-md border-0 bg-transparent px-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon name="refresh-cw" size={13} />
        Run again
      </button>
      {view.err ? (
        <span
          data-gitlab-rerun-error=""
          title={view.err}
          className="min-w-0 truncate font-sans text-[11.5px] font-normal leading-normal text-(--status-error)"
        >
          {view.err}
        </span>
      ) : view.started ? (
        <span
          data-gitlab-rerun-started=""
          className="min-w-0 truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          Started
        </span>
      ) : null}
    </span>
  )
}
