/**
 * GitLab subscription vocabulary, the counterpart of `github-events.ts`.
 *
 * The console presents the same two axes GitHub does: SUBJECT families (issues
 * and merge requests — pushes are wire-supported but held back from the console,
 * see `GL_FAMILIES`) plus one TRIGGER MODE. The stored `events` patterns,
 * `commentFamilies` and the `mentionOnly` flag encode both:
 *
 *   created  → `family:opened` for the thread families and NO note family; the
 *              relay additionally accepts a later explicit @mention in an
 *              `:opened`-cadence thread family. Pushes have no "first" — a push
 *              subscription is inherently per-push, so `push:*` rides along.
 *   updated  → `family:*` plus the selected thread families as note families,
 *              so replies fire too. Close, reopen, merge and draft toggles stay
 *              inert; supported updates and replies run.
 *   mention only → the same subscriptions as updated, with `mentionOnly: true` —
 *              an event fires ONLY when its text (issue/MR description, note
 *              body, commit message) @-mentions the agent or the project's
 *              service account. The agent handle targets one rule; the service
 *              account handle broadcasts. Assigning the service account as a
 *              reviewer bypasses the gate entirely.
 *
 * One asymmetry with GitHub is deliberate: there, `commentFamilies` only
 * NARROWS a shared `issue_comment` subscription, so it may stay populated in
 * created mode. Here it is the note subscription itself, so created mode must
 * clear it or every reply would fire.
 *
 * The wire accepts finer `family:action` patterns; these helpers never emit one.
 */

import type { GitlabCommentFamily, HookCommentFamily } from './api'

export type GlFamily = 'issues' | 'merge_request' | 'push'
export type GlTriggerMode = 'first' | 'every' | 'mention'

export interface GlFamilyTile {
  fam: GlFamily
  pill: string
  icon: string
  label: string
  desc: string
}

// `desc` is the Add-integration tile subtitle — keep it to a short fragment
// naming signals the relay really forwards, on one or two 11.5px lines.
// Every subject the wire knows, in display order. The event helpers read THIS
// list, so an already-stored push subscription round-trips instead of being
// silently dropped by an edit that never mentioned pushes.
const GL_ALL_FAMILIES: GlFamilyTile[] = [
  { fam: 'issues', pill: 'Issues', icon: 'circle-dot', label: 'Issues', desc: 'opened, labels, replies' },
  {
    fam: 'merge_request',
    pill: 'MRs',
    icon: 'git-pull-request',
    label: 'Merge requests',
    desc: 'opened, new commits, replies'
  },
  { fam: 'push', pill: 'Pushes', icon: 'git-commit-horizontal', label: 'Pushes', desc: 'commits pushed to a branch' }
]

// The subjects the console OFFERS — the two GitHub offers too. The push tile is
// intentionally held back for now, exactly as `GH_FAMILIES` holds back commits;
// re-add it here (and restore the 3-up grid) to bring the feature back.
export const GL_FAMILIES: GlFamilyTile[] = GL_ALL_FAMILIES.filter((entry) => entry.fam !== 'push')

/** The subject toggles ONE stored hook shows: the offered ones, plus pushes when
 *  it already listens to them so the stored rule stays legible and removable. */
export function gitlabRowFamilies(events: readonly string[]): GlFamilyTile[] {
  return GL_ALL_FAMILIES.filter((entry) => entry.fam !== 'push' || gitlabFamCovered(events, 'push'))
}

/** The trigger modes in display order — mention deliberately last. */
export const GL_TRIGGER_MODES: readonly GlTriggerMode[] = ['first', 'every', 'mention']
/** The Add-integration cadence tiles' vocabulary ("Trigger when …"). */
export const GL_TRIGGER_LABEL: Record<GlTriggerMode, string> = {
  first: 'created',
  every: 'updated',
  mention: 'mention only'
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

/** The default create-form cadence: react to issue or merge-request updates. */
export const GL_DEFAULT_TRIGGER_MODE: GlTriggerMode = 'every'

/** Narrow a stored cross-host comment scope to the GitLab families a gitlab hook may carry. */
export function gitlabCommentFamilies(families: readonly HookCommentFamily[]): GitlabCommentFamily[] {
  return families.filter((family): family is GitlabCommentFamily => family === 'issues' || family === 'merge_request')
}

/** The note families replies may arrive on — empty in created mode, where a
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

/** One edit-path write: the whole subscription block the row must PUT. */
export interface GitlabSubscriptionEdit {
  families: GlFamily[]
  mode: GlTriggerMode
}

/** The stored subject families, in display order. */
function gitlabFamiliesOf(events: readonly string[]): GlFamily[] {
  return GL_ALL_FAMILIES.map((entry) => entry.fam).filter((family) => gitlabFamCovered(events, family))
}

/** A subject toggle on an existing hook — null when it would leave the hook
 *  watching nothing. The stored cadence rides along unchanged; a rule the radio
 *  cannot express is normalized, because the toggle is an explicit edit. */
export function gitlabFamilyToggle(
  hook: { events: readonly string[]; mentionOnly: boolean },
  fam: GlFamily
): GitlabSubscriptionEdit | null {
  const families = GL_ALL_FAMILIES.map((entry) => entry.fam).filter((family) =>
    family === fam ? !gitlabFamCovered(hook.events, family) : gitlabFamCovered(hook.events, family)
  )
  if (families.length === 0) return null
  return { families, mode: gitlabTriggerModeOf(hook) }
}

/** A cadence pick on an existing hook — null when nothing would change, which
 *  is what keeps a stored rule the radio cannot express from being rewritten by
 *  the mere act of displaying it. Re-picking the DISPLAYED cadence on such a
 *  rule does write: that is the explicit opt-in that normalizes it. */
export function gitlabCadencePick(
  hook: { events: readonly string[]; commentFamilies: readonly HookCommentFamily[]; mentionOnly: boolean },
  mode: GlTriggerMode
): GitlabSubscriptionEdit | null {
  if (mode === gitlabTriggerModeOf(hook) && !gitlabHookNeedsNormalization(hook)) return null
  return { families: gitlabFamiliesOf(hook.events), mode }
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
