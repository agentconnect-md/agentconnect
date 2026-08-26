import type { GithubCommentFamily, HookCommentFamily } from './api'

/**
 * GitHub subscription event model shared by the Add-integration form and the
 * agent-detail pills. The console works in FAMILIES (pull requests / issues /
 * commits) plus a per-repo TRIGGER MODE ("when"); the stored `HookDef.events`
 * patterns plus the `mentionOnly` flag encode both:
 *
 *   created  → `family:opened` for the regular cadence; the relay additionally accepts a later explicit
 *              @mention in the selected thread family (commits have no "first"
 *              — a push subscription is inherently per-push, so `push:*` rides
 *              along unchanged)
 *   updated  → `family:*` + `issue_comment:created` when a thread family is
 *              selected. The relay ignores close/reopen and content edits;
 *              PR target-branch changes, other supported updates, and replies run.
 *   mention only → the same subscriptions as updated, with `mentionOnly: true` —
 *              an event fires ONLY when its text (issue/PR body, comment body,
 *              commit message) @-mentions the assigned agent or the App. The
 *              agent handle targets one rule; the App handle broadcasts.
 *              Thread actors additionally pass the relay's live maintainer gate.
 *
 * The REST DTO accepts finer `family:action` values — these helpers just never
 * emit them.
 */

export type GhFamily = 'pull_request' | 'issues' | 'push'
export type GhTriggerMode = 'first' | 'every' | 'mention'

// `desc` is the Add-integration tile subtitle — the design's compact grid, so
// keep it to a short fragment that fits one or two 11.5px lines.
//
// The `push` (Commits) family is intentionally omitted for now — the
// commit-subscription flow is held back. `GhFamily` still includes 'push' so
// the event helpers keep reading any already-stored push subscription; re-add
// the tile here (and restore the 3-up grid) to bring the feature back.
export const GH_FAMILIES: { fam: GhFamily; pill: string; icon: string; label: string; desc: string }[] = [
  {
    fam: 'pull_request',
    pill: 'PRs',
    icon: 'git-pull-request',
    label: 'Pull requests',
    desc: 'opened, revision changes, replies'
  },
  {
    fam: 'issues',
    pill: 'Issues',
    icon: 'circle-dot',
    label: 'Issues',
    desc: 'opened, labels, replies'
  }
]

/** The trigger modes in display order — mention deliberately last. */
export const GH_TRIGGER_MODES: readonly GhTriggerMode[] = ['first', 'every', 'mention']
/** The Add-integration cadence tiles' vocabulary ("Trigger when …"). */
export const GH_TRIGGER_LABEL: Record<GhTriggerMode, string> = {
  first: 'created',
  every: 'updated',
  mention: 'mention only'
}
/** The agent-detail trigger bar's segment vocabulary (shared with the IM bar's
 *  "@-mention" wording; mention sits last there too). */
export const GH_TRIGGER_PILL: Record<GhTriggerMode, string> = {
  first: 'create',
  every: 'update',
  mention: '@-mention'
}

/** Per-segment hover copy for the trigger bar. */
export function githubTriggerTooltip(mode: GhTriggerMode, agentName: string): string {
  switch (mode) {
    case 'first':
      return `Runs when an issue or PR opens, plus later @${agentName} mentions.`
    case 'every':
      return 'Runs when an issue or PR is opened and on supported updates and replies (close, reopen and title/body edits are ignored).'
    case 'mention':
      // Not "only @agent": the App handle is the repository-wide broadcast, and
      // an authorized native App review request bypasses cadence/mention/label.
      return `Runs when @${agentName} or the GitHub App is mentioned, and on explicit App review requests.`
  }
}

/** Concrete hover copy for the agent-targeted GitHub mention form. The owner
 *  form is offered whenever a repository is known: a GitHub team named after the
 *  agent makes the same handle autocomplete in GitHub's comment composer. */
export function githubMentionUsage(agentName: string, repoFullName?: string | null): string {
  const owner = repoFullName?.split('/')[0]
  return owner
    ? `Use @${agentName} — or @${owner}/${agentName}, once the organization has a team named ${agentName} — to trigger only this agent.`
    : `Use @${agentName} to trigger only this agent.`
}

/** The default create-form selection: pull requests only. */
export const GH_DEFAULT_FAMILIES: readonly GhFamily[] = ['pull_request']

/** The default create-form cadence: react to issue or pull-request updates. */
export const GH_DEFAULT_TRIGGER_MODE: GhTriggerMode = 'every'

/** The comment subscription that rides updated/mention-only modes for thread families. */
export const THREAD_COMMENT_EVENT = 'issue_comment:created'

/** Narrow a stored cross-host comment scope to the GitHub families a github hook may carry. */
export function githubCommentFamilies(families: readonly HookCommentFamily[]): GithubCommentFamily[] {
  return families.filter((family): family is GithubCommentFamily => family === 'issues' || family === 'pull_request')
}

/** Derive the explicit comment scope from the selected issue/PR families. */
export function commentFamiliesForFamilies(fams: Iterable<GhFamily>): GithubCommentFamily[] {
  return [...fams].filter((fam): fam is GithubCommentFamily => fam === 'issues' || fam === 'pull_request')
}

/** Compile the console's family+mode choice into stored event patterns. */
export function eventsForFamilies(fams: Iterable<GhFamily>, mode: GhTriggerMode): string[] {
  const families = [...fams]
  const familyEvents = families.flatMap((fam) => {
    if (mode !== 'first' || fam === 'push') return [`${fam}:*`]
    return [`${fam}:opened`]
  })
  const listensForThreadReplies = mode !== 'first' && commentFamiliesForFamilies(families).length > 0
  return listensForThreadReplies ? [...familyEvents, THREAD_COMMENT_EVENT] : familyEvents
}

/** Whether a hook's stored events cover a family (any action pattern counts). */
export function famCovered(events: string[], fam: GhFamily): boolean {
  return events.some((e) => e.startsWith(`${fam}:`))
}

/** Recover the trigger mode: the mentionOnly flag wins, `:opened`-only ⇒ created. */
export function triggerModeOf(h: { events: string[]; mentionOnly: boolean }): GhTriggerMode {
  if (h.mentionOnly) return 'mention'
  return h.events.some((e) => e.endsWith(':opened')) ? 'first' : 'every'
}

/** Whether a persisted hook differs from the canonical console encoding.
 *  Legacy/API rules are never rewritten implicitly; this lets an explicit
 *  same-cadence selection normalize them instead of returning early. */
export function githubHookNeedsNormalization(h: {
  events: string[]
  commentFamilies: readonly HookCommentFamily[]
  mentionOnly: boolean
}): boolean {
  const families = GH_FAMILIES.map((family) => family.fam).filter((family) => famCovered(h.events, family))
  // Raw API comment-only rules have no console family to normalize into and
  // must remain untouched even if the user reselects the displayed cadence.
  if (families.length === 0) return false
  const mode = triggerModeOf(h)
  const sameMembers = (actual: string[], expected: string[]) => {
    const actualSet = new Set(actual)
    const expectedSet = new Set(expected)
    return actualSet.size === expectedSet.size && [...actualSet].every((value) => expectedSet.has(value))
  }
  return (
    !sameMembers(h.events, eventsForFamilies(families, mode)) ||
    !sameMembers(githubCommentFamilies(h.commentFamilies), commentFamiliesForFamilies(families))
  )
}
