'use client'

/**
 * The "Run again" action for a GitLab trigger session (gitlab-com-integration.md
 * §16.1). GitLab has no native re-run control, so this button is the console's
 * replacement for it.
 *
 * It names only the thread's subject: the Control Plane reads the merge
 * request's current head itself, so the console can never re-run a stale
 * revision. Absent — never disabled — for anything that is not a GitLab hook
 * session on a merge-request or issue thread, and behind the `gitlab` flag with
 * the rest of the GitLab console surface.
 */
import { useState } from 'react'
import { Icon } from '@/components/ui'
import { rerunGitlabHook } from '@/lib/api'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { parseGitlabHookThread } from '@/lib/gitlab-events'
import type { HookKind } from '@/lib/api'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
  const [state, setState] = useState<{ busy: boolean; err: string | null; started: boolean }>({
    busy: false,
    err: null,
    started: false
  })
  const subject = parseGitlabHookThread(thread)
  if (!featureFlagEnabled('gitlab') || hookKind !== 'gitlab' || !hookId || !subject) return null

  const run = () => {
    setState({ busy: true, err: null, started: false })
    rerunGitlabHook(hookId, subject).then(
      () => setState({ busy: false, err: null, started: true }),
      (e: unknown) => setState({ busy: false, err: msg(e), started: false })
    )
  }

  return (
    <span className={`flex min-w-0 flex-none items-center gap-[6px] ${className ?? ''}`}>
      <button
        type="button"
        data-gitlab-rerun=""
        onClick={run}
        disabled={state.busy}
        title="Run this GitLab trigger again for the current revision"
        className="inline-flex h-[22px] flex-none items-center gap-1 rounded-md border-0 bg-transparent px-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon name="refresh-cw" size={13} />
        Run again
      </button>
      {state.err ? (
        <span
          data-gitlab-rerun-error=""
          title={state.err}
          className="min-w-0 truncate font-sans text-[11.5px] font-normal leading-normal text-(--status-error)"
        >
          {state.err}
        </span>
      ) : state.started ? (
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
