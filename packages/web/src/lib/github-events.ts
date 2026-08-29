import type { GithubCommentFamily, GithubHookFamily, HookCommentFamily } from './api'

/**
 * GitHub subscription event model shared by the Add-integration form and the
 * agent-detail pills. A stored row covers exactly ONE family (pull requests /
 * issues / commits) and carries its own TRIGGER MODE ("when"), so a repository
 * watched for both PRs and issues is two rows; the family is immutable, and the
 * row's stored `events` patterns plus its `mentionOnly` flag encode the mode:
 *
 *   opened   → `family:opened` for the regular cadence; the relay additionally accepts a later explicit
 *              @mention in the row's thread family (commits have no "first"
 *              — a push subscription is inherently per-push, so `push:*` rides
 *              along unchanged)
 *   any update → `family:*` + `issue_comment:created` on a thread family, scoped
 *              to that family by `commentFamilies`. The relay ignores
 *              close/reopen and content edits; PR target-branch changes, other
 *              supported updates, and replies run.
 *   labeled  → `issues:labeled` alone. Issues-only, and the one cadence that
 *              subscribes to no replies at all: a label is applied to a thread,
 *              not said in it. A `labelFilter` intersects the issue's CURRENT
 *              label set (relay semantics for every cadence), not the label
 *              this delivery applied; empty means any label.
 *   @-mention → the same subscriptions as any update, with `mentionOnly: true` —
 *              an event fires ONLY when its text (issue/PR body, comment body,
 *              commit message) @-mentions the assigned agent or the App. The
 *              agent handle targets one rule; the App handle broadcasts.
 *              Thread actors additionally pass the relay's live maintainer gate.
 *
 * The REST DTO accepts finer `family:action` values — these helpers just never
 * emit them.
 */

export type GhFamily = GithubHookFamily
export type GhTriggerMode = 'first' | 'every' | 'labeled' | 'mention'

export interface GhFamilyTile {
  fam: GhFamily
  pill: string
  icon: string
  label: string
}

// Every subject the wire knows, in display order — a stored push row still
// reads its own label from here even though the console never offers one. What
// a subject listens to is stated by its cadence tiles, not a subtitle.
const GH_ALL_FAMILIES: GhFamilyTile[] = [
  { fam: 'pull_request', pill: 'PRs', icon: 'git-pull-request', label: 'Pull requests' },
  { fam: 'issues', pill: 'Issues', icon: 'circle-dot', label: 'Issues' },
  { fam: 'push', pill: 'Commits', icon: 'git-commit-horizontal', label: 'Commits' }
]

// The subjects the console OFFERS. The `push` (Commits) tile is intentionally
// held back for now — the commit-subscription flow is not exposed; re-add it
// here (and restore the 3-up grid) to bring the feature back.
export const GH_FAMILIES: GhFamilyTile[] = GH_ALL_FAMILIES.filter((entry) => entry.fam !== 'push')

/** The display metadata for one family, including the held-back push subject. */
export function githubFamilyTile(fam: GhFamily): GhFamilyTile | undefined {
  return GH_ALL_FAMILIES.find((entry) => entry.fam === fam)
}

/** Reviews and Checks exist only on the change-proposal subject (the CP 400s otherwise). */
export function githubFamilyCarriesReviews(fam: GhFamily): boolean {
  return fam === 'pull_request'
}

/** The trigger modes in display order — mention deliberately last. */
export const GH_TRIGGER_MODES: readonly GhTriggerMode[] = ['first', 'every', 'labeled', 'mention']
/** The cadence vocabulary ("Trigger when …") the create surfaces spell out. */
export const GH_TRIGGER_LABEL: Record<GhTriggerMode, string> = {
  first: 'opened',
  every: 'any update',
  labeled: 'labeled',
  mention: '@-mention'
}
/** The agent-detail trigger bar's segment vocabulary — deliberately shorter than
 *  the labels above and shared with the IM bar, so the two bars read alike. */
export const GH_TRIGGER_PILL: Record<GhTriggerMode, string> = {
  first: 'create',
  every: 'update',
  labeled: 'labeled',
  mention: '@-mention'
}

/** Label events ride the issues subject alone — a PR row never offers or compiles one. */
export function githubFamilySupportsMode(fam: GhFamily, mode: GhTriggerMode): boolean {
  return mode !== 'labeled' || fam === 'issues'
}

/** The cadences one family offers, in display order. */
export function githubTriggerModes(fam: GhFamily): readonly GhTriggerMode[] {
  return GH_TRIGGER_MODES.filter((mode) => githubFamilySupportsMode(fam, mode))
}

/** Per-segment hover copy for the trigger bar. */
export function githubTriggerTooltip(mode: GhTriggerMode, agentName: string): string {
  switch (mode) {
    case 'first':
      return `Runs when an issue or PR opens, plus later @${agentName} mentions.`
    case 'every':
      return 'Runs when an issue or PR is opened and on supported updates and replies (close, reopen and title/body edits are ignored).'
    case 'labeled':
      return "Runs when a label is applied to an issue. A label filter matches the issue's current labels, not just the one applied. Replies do not run it."
    case 'mention':
      // Not "only @agent": the App handle is the repository-wide broadcast, and
      // an authorized native App review request bypasses cadence/mention/label.
      return `Runs when @${agentName} or the GitHub App is mentioned, and on explicit App review requests.`
  }
}

/** Concrete hover copy for the agent-targeted GitHub mention form. `teamOwner`
 *  is the ORGANIZATION that owns the repository: a team named after the agent
 *  makes the same handle autocomplete in GitHub's comment composer. A personal
 *  account has no teams, so callers pass none and the copy stays on the bare form. */
export function githubMentionUsage(agentName: string, teamOwner?: string | null): string {
  return teamOwner
    ? `Use @${agentName} — or @${teamOwner}/${agentName}, once the organization has a team named ${agentName} — to trigger only this agent.`
    : `Use @${agentName} to trigger only this agent.`
}

/** The default create-form selection: pull requests only. */
export const GH_DEFAULT_FAMILIES: readonly GhFamily[] = ['pull_request']

/** The cadence a create surface opens a new subject on — a change proposal on every update, the rest on the opening. */
export function githubDefaultTriggerMode(fam: GhFamily): GhTriggerMode {
  return fam === 'pull_request' ? 'every' : 'first'
}

/** The comment subscription that rides updated/mention-only modes for thread families. */
export const THREAD_COMMENT_EVENT = 'issue_comment:created'

/** Narrow a stored cross-host comment scope to the GitHub families a github hook may carry. */
export function githubCommentFamilies(families: readonly HookCommentFamily[]): GithubCommentFamily[] {
  return families.filter((family): family is GithubCommentFamily => family === 'issues' || family === 'pull_request')
}

/** A cadence a family cannot carry narrows to the opening, never widens — only issues-only `labeled` reaches this. */
function effectiveMode(fam: GhFamily, mode: GhTriggerMode): GhTriggerMode {
  return githubFamilySupportsMode(fam, mode) ? mode : 'first'
}

/** Derive the explicit comment scope from the selected issue/PR families — a
 *  labeled subscription listens to no replies, so it carries no scope. */
export function commentFamiliesForFamilies(fams: Iterable<GhFamily>, mode?: GhTriggerMode): GithubCommentFamily[] {
  if (mode === 'labeled') return []
  return [...fams].filter((fam): fam is GithubCommentFamily => fam === 'issues' || fam === 'pull_request')
}

/** Compile the console's family+mode choice into stored event patterns. */
export function eventsForFamilies(fams: Iterable<GhFamily>, mode: GhTriggerMode): string[] {
  const families = [...fams]
  const familyEvents = families.flatMap((fam) => {
    const own = effectiveMode(fam, mode)
    if (own === 'labeled') return [`${fam}:labeled`]
    if (own !== 'first' || fam === 'push') return [`${fam}:*`]
    return [`${fam}:opened`]
  })
  const listensForThreadReplies =
    families.some((fam) => {
      const own = effectiveMode(fam, mode)
      return own === 'every' || own === 'mention'
    }) && commentFamiliesForFamilies(families, mode).length > 0
  return listensForThreadReplies ? [...familyEvents, THREAD_COMMENT_EVENT] : familyEvents
}

/** Whether a hook's stored events cover a family (any action pattern counts). */
export function famCovered(events: string[], fam: GhFamily): boolean {
  return events.some((e) => e.startsWith(`${fam}:`))
}

/** The one subject family a stored row covers: its own `family`, or — for a
 *  legacy row the split could not place — the first family its events cover. */
export function githubHookFamily(hook: { family: string | null; events: string[] }): GhFamily | null {
  const declared = GH_ALL_FAMILIES.find((entry) => entry.fam === hook.family)
  if (declared) return declared.fam
  return GH_ALL_FAMILIES.find((entry) => famCovered(hook.events, entry.fam))?.fam ?? null
}

/** The subscription block ONE (family, mode) row writes — `family` itself is
 *  create-only, so it is not part of this body. */
export interface GithubFamilySubscription {
  events: string[]
  commentFamilies: GithubCommentFamily[]
  mentionOnly: boolean
}

/** Compile one row's family+mode into the fields its create/update body carries. */
export function githubFamilySubscription(fam: GhFamily, mode: GhTriggerMode): GithubFamilySubscription {
  const own = effectiveMode(fam, mode)
  return {
    events: eventsForFamilies([fam], own),
    commentFamilies: commentFamiliesForFamilies([fam], own),
    mentionOnly: own === 'mention'
  }
}

/** The one events shape the labeled cadence writes — its own round-trip anchor. */
const LABELED_EVENT = 'issues:labeled'

/** Recover the trigger mode: the mentionOnly flag wins, the bare label
 *  subscription is labeled, and `:opened` ⇒ opened. */
export function triggerModeOf(h: { events: string[]; mentionOnly: boolean }): GhTriggerMode {
  if (h.mentionOnly) return 'mention'
  if (h.events.length === 1 && h.events[0] === LABELED_EVENT) return 'labeled'
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
    !sameMembers(githubCommentFamilies(h.commentFamilies), commentFamiliesForFamilies(families, mode))
  )
}
