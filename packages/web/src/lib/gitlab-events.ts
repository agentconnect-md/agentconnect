/**
 * GitLab subscription vocabulary, the counterpart of `github-events.ts`.
 *
 * The console works in SUBJECT families (issues / merge requests / pushes) and,
 * independently, in NOTE families — which conversations a reply may fire the
 * agent from. Both are stored plainly: a subject family becomes a `family:*`
 * pattern, a note family stays in `commentFamilies`, and `mentionOnly` narrows
 * every one of them to authored text that @-mentions the agent.
 *
 * The wire accepts finer `family:action` patterns; these helpers never emit one.
 */

import type { GitlabCommentFamily } from './api'

export type GlFamily = 'issues' | 'merge_request' | 'push'

export const GL_FAMILIES: { fam: GlFamily; pill: string; icon: string; label: string; desc: string }[] = [
  { fam: 'issues', pill: 'Issues', icon: 'circle-dot', label: 'Issues', desc: 'opened, updated, labelled' },
  {
    fam: 'merge_request',
    pill: 'MRs',
    icon: 'git-pull-request',
    label: 'Merge requests',
    desc: 'opened, updated, merged'
  },
  { fam: 'push', pill: 'Pushes', icon: 'git-commit-horizontal', label: 'Pushes', desc: 'commits pushed to a branch' }
]

/** The note families a reply can arrive on — pushes carry no conversation. */
export const GL_COMMENT_FAMILIES: { fam: GitlabCommentFamily; label: string }[] = [
  { fam: 'issues', label: 'Issues' },
  { fam: 'merge_request', label: 'Merge requests' }
]

/** The default create-form selection: merge requests only. */
export const GL_DEFAULT_FAMILIES: readonly GlFamily[] = ['merge_request']

/** Compile the console's family choice into stored event patterns, in display
 *  order — a hook's stored events must not depend on the order boxes were ticked. */
export function eventsForGitlabFamilies(families: Iterable<GlFamily>): string[] {
  const picked = new Set(families)
  return GL_FAMILIES.filter((family) => picked.has(family.fam)).map((family) => `${family.fam}:*`)
}

/** Whether a hook's stored events cover a family (any action pattern counts). */
export function gitlabFamCovered(events: readonly string[], family: GlFamily): boolean {
  return events.some((event) => event.startsWith(`${family}:`))
}

/** Split a comma or whitespace separated label filter into the stored array. */
export function parseLabelFilter(input: string): string[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean)
    )
  ]
}

/**
 * The rename-stable thread key a GitLab hook session carries
 * (gitlab-com-integration.md §12.3): `gitlab:<project-id>:<kind>:<iid>`. A push
 * session's `…:push:<ref>` deliberately does not parse — a branch is not a
 * subject the "Run again" action can re-run.
 */
const GITLAB_HOOK_THREAD = /^gitlab:[1-9]\d*:(merge_request|issue):([1-9]\d*)$/

export interface GitlabHookThread {
  kind: 'merge_request' | 'issue'
  iid: number
}

/** The thread's rerun subject, or null when it names none. */
export function parseGitlabHookThread(thread: string | null | undefined): GitlabHookThread | null {
  const match = thread ? GITLAB_HOOK_THREAD.exec(thread) : null
  if (!match) return null
  return { kind: match[1] as GitlabHookThread['kind'], iid: Number(match[2]) }
}
