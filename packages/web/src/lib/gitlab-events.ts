/**
 * GitLab subscription vocabulary, the counterpart of `github-events.ts`.
 *
 * The console presents the same two axes GitHub does: SUBJECT families (issues
 * and merge requests — pushes are wire-supported but held back from the console,
 * see `GL_FAMILIES`) plus one TRIGGER MODE. A stored row covers exactly ONE
 * family and carries its own mode, so a project watched for both subjects is two
 * rows and the family is immutable; the row's `events` patterns,
 * `commentFamilies` and `mentionOnly` flag encode the mode:
 *
 *   opened   → `family:opened` for a thread family and NO note family; the
 *              relay additionally accepts a later explicit @mention in an
 *              `:opened`-cadence thread family. Pushes have no "first" — a push
 *              subscription is inherently per-push, so `push:*` rides along.
 *   any update → `family:*` plus the row's own thread family as its note family,
 *              so replies fire too. Close, reopen, merge and draft toggles stay
 *              inert; supported updates and replies run.
 *   @-mention → the same subscriptions as any update, with `mentionOnly: true` —
 *              an event fires ONLY when its text (issue/MR description, note
 *              body, commit message) @-mentions the agent or the project's
 *              service account. The agent handle targets one rule; the service
 *              account handle broadcasts. Assigning the service account as a
 *              reviewer bypasses the gate entirely.
 *
 * One asymmetry with GitHub is deliberate: there, `commentFamilies` only
 * NARROWS a shared `issue_comment` subscription, so it may stay populated in
 * opened mode. Here it is the note subscription itself, so opened mode must
 * clear it or every reply would fire.
 *
 * The wire accepts finer `family:action` patterns; these helpers never emit one.
 */

import type { GitlabCommentFamily, GitlabHookFamily, HookCommentFamily } from './api'

export type GlFamily = GitlabHookFamily
export type GlTriggerMode = 'first' | 'every' | 'mention'

export interface GlFamilyTile {
  fam: GlFamily
  pill: string
  icon: string
  label: string
}

// Every subject the wire knows, in display order — a stored push row still
// reads its own label from here even though the console never offers one. What
// a subject listens to is stated by its cadence tiles, not a subtitle.
const GL_ALL_FAMILIES: GlFamilyTile[] = [
  { fam: 'issues', pill: 'Issues', icon: 'circle-dot', label: 'Issues' },
  { fam: 'merge_request', pill: 'MRs', icon: 'git-pull-request', label: 'Merge requests' },
  { fam: 'push', pill: 'Pushes', icon: 'git-commit-horizontal', label: 'Pushes' }
]

// The subjects the console OFFERS — the two GitHub offers too. The push tile is
// intentionally held back for now, exactly as `GH_FAMILIES` holds back commits;
// re-add it here (and restore the 3-up grid) to bring the feature back.
export const GL_FAMILIES: GlFamilyTile[] = GL_ALL_FAMILIES.filter((entry) => entry.fam !== 'push')

/** The display metadata for one family, including the held-back push subject. */
export function gitlabFamilyTile(fam: GlFamily): GlFamilyTile | undefined {
  return GL_ALL_FAMILIES.find((entry) => entry.fam === fam)
}

/** Reviews and the run note exist only on the change-proposal subject (the CP 400s otherwise). */
export function gitlabFamilyCarriesReviews(fam: GlFamily): boolean {
  return fam === 'merge_request'
}

/** The trigger modes in display order — mention deliberately last. */
export const GL_TRIGGER_MODES: readonly GlTriggerMode[] = ['first', 'every', 'mention']
/** The cadence vocabulary ("Trigger when …") the create surfaces spell out. */
export const GL_TRIGGER_LABEL: Record<GlTriggerMode, string> = {
  first: 'opened',
  every: 'any update',
  mention: '@-mention'
}
/** The agent-detail trigger bar's segment vocabulary, worded like the IM bar. */
export const GL_TRIGGER_PILL: Record<GlTriggerMode, string> = {
  first: 'create',
  every: 'update',
  mention: '@-mention'
}

/** Per-segment hover copy for the trigger bar. */
export function gitlabTriggerTooltip(mode: GlTriggerMode, agentName: string): string {
  switch (mode) {
    case 'first':
      return `Runs when an issue or merge request opens, plus later @${agentName} mentions.`
    case 'every':
      return 'Runs when an issue or merge request is opened and on supported updates and replies (close, reopen and merge are ignored).'
    case 'mention':
      // Not "only @agent": the service-account handle is the project-wide
      // broadcast, and assigning it as a reviewer bypasses cadence and mention.
      return `Runs when @${agentName} or the project's service account is mentioned, and on explicit reviewer requests.`
  }
}

/** Concrete hover copy for the agent-targeted GitLab mention form. */
export function gitlabMentionUsage(agentName: string): string {
  return `Use @${agentName} to trigger only this agent.`
}

/** The default create-form selection: merge requests only. */
export const GL_DEFAULT_FAMILIES: readonly GlFamily[] = ['merge_request']

/** The cadence a create surface opens a new subject on — a merge request on every update, the rest on the opening. */
export function gitlabDefaultTriggerMode(fam: GlFamily): GlTriggerMode {
  return fam === 'merge_request' ? 'every' : 'first'
}

/** Narrow a stored cross-host comment scope to the GitLab families a gitlab hook may carry. */
export function gitlabCommentFamilies(families: readonly HookCommentFamily[]): GitlabCommentFamily[] {
  return families.filter((family): family is GitlabCommentFamily => family === 'issues' || family === 'merge_request')
}

/** The note families replies may arrive on — empty in opened mode, where a
 *  reply fires only by summoning the agent in an already-opened thread. */
export function commentFamiliesForGitlabFamilies(
  families: Iterable<GlFamily>,
  mode: GlTriggerMode
): GitlabCommentFamily[] {
  if (mode === 'first') return []
  const picked = new Set(families)
  return GL_ALL_FAMILIES.map((entry) => entry.fam).filter(
    (family): family is GitlabCommentFamily => family !== 'push' && picked.has(family)
  )
}

/** Compile the console's family+mode choice into stored event patterns, in
 *  display order — a hook's stored events must not depend on the order boxes
 *  were ticked. */
export function eventsForGitlabFamilies(families: Iterable<GlFamily>, mode: GlTriggerMode): string[] {
  const picked = new Set(families)
  return GL_ALL_FAMILIES.filter((entry) => picked.has(entry.fam)).map((entry) =>
    mode === 'first' && entry.fam !== 'push' ? `${entry.fam}:opened` : `${entry.fam}:*`
  )
}

/** Whether a hook's stored events cover a family (any action pattern counts). */
export function gitlabFamCovered(events: readonly string[], family: GlFamily): boolean {
  return events.some((event) => event.startsWith(`${family}:`))
}

/** Recover the trigger mode: the mentionOnly flag wins, `:opened` ⇒ created. */
export function gitlabTriggerModeOf(hook: { events: readonly string[]; mentionOnly: boolean }): GlTriggerMode {
  if (hook.mentionOnly) return 'mention'
  return hook.events.some((event) => event.endsWith(':opened')) ? 'first' : 'every'
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  return actualSet.size === expectedSet.size && [...actualSet].every((value) => expectedSet.has(value))
}

/** Whether a persisted hook differs from the canonical console encoding — a
 *  stored rule the three-way trigger cannot express (say, replies on issues but
 *  not merge requests, or a finer `family:action` pattern an API caller wrote).
 *  Such a rule is never rewritten implicitly: the console shows the nearest
 *  trigger and flags the difference, and only an explicit cadence pick
 *  normalizes it — including a pick of the cadence already displayed. */
export function gitlabHookNeedsNormalization(hook: {
  events: readonly string[]
  commentFamilies: readonly HookCommentFamily[]
  mentionOnly: boolean
}): boolean {
  const families = gitlabFamiliesOf(hook.events)
  // A note-only rule has no console family to normalize into and must remain
  // untouched even if the user reselects the displayed cadence.
  if (families.length === 0) return false
  const mode = gitlabTriggerModeOf(hook)
  return (
    !sameMembers(hook.events, eventsForGitlabFamilies(families, mode)) ||
    !sameMembers(gitlabCommentFamilies(hook.commentFamilies), commentFamiliesForGitlabFamilies(families, mode))
  )
}

/** The stored subject families, in display order. */
function gitlabFamiliesOf(events: readonly string[]): GlFamily[] {
  return GL_ALL_FAMILIES.map((entry) => entry.fam).filter((family) => gitlabFamCovered(events, family))
}

/** The one subject family a stored row covers: its own `family`, or — for a
 *  legacy row the split could not place — the first family its events cover. */
export function gitlabHookFamily(hook: { family: string | null; events: readonly string[] }): GlFamily | null {
  const declared = GL_ALL_FAMILIES.find((entry) => entry.fam === hook.family)
  if (declared) return declared.fam
  return gitlabFamiliesOf(hook.events)[0] ?? null
}

/** The subscription block ONE (family, mode) row writes — `family` itself is
 *  create-only, so it is not part of this body. */
export interface GitlabFamilySubscription {
  events: string[]
  commentFamilies: GitlabCommentFamily[]
  mentionOnly: boolean
}

/** Compile one row's family+mode into the fields its create/update body carries. */
export function gitlabFamilySubscription(fam: GlFamily, mode: GlTriggerMode): GitlabFamilySubscription {
  return {
    events: eventsForGitlabFamilies([fam], mode),
    commentFamilies: commentFamiliesForGitlabFamilies([fam], mode),
    mentionOnly: mode === 'mention'
  }
}

/** One edit-path write: the row's immutable family plus the cadence to store. */
export interface GitlabSubscriptionEdit {
  family: GlFamily
  mode: GlTriggerMode
}

/** A cadence pick on an existing hook — null when nothing would change, which
 *  is what keeps a stored rule the radio cannot express from being rewritten by
 *  the mere act of displaying it. Re-picking the DISPLAYED cadence on such a
 *  rule does write: that is the explicit opt-in that normalizes it. */
export function gitlabCadencePick(
  hook: {
    family: string | null
    events: readonly string[]
    commentFamilies: readonly HookCommentFamily[]
    mentionOnly: boolean
  },
  mode: GlTriggerMode
): GitlabSubscriptionEdit | null {
  const family = gitlabHookFamily(hook)
  if (!family) return null
  if (mode === gitlabTriggerModeOf(hook) && !gitlabHookNeedsNormalization(hook)) return null
  return { family, mode }
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
