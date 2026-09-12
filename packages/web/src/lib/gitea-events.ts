/**
 * Gitea subscription vocabulary, the counterpart of `gitlab-events.ts`.
 *
 * Gitea rows speak the GitLab family vocabulary (gitea-integration.md §8): the
 * stored families are `issues`, `merge_request` — Gitea's pull request — and
 * `push`, and the relay normalizes its own event types onto them
 * (`relay/src/hooks/gitea/events.ts`). So the console presents the same two
 * axes: SUBJECT families plus one TRIGGER MODE, one stored row per family, and
 * the row's `events` patterns, `commentFamilies` and `mentionOnly` flag encode
 * the mode:
 *
 *   opened   → `family:opened` for a thread family and NO comment family; the
 *              relay additionally accepts a later explicit @mention in an
 *              `:opened`-cadence thread family. A push subscription is
 *              inherently per-push, so `push:*` rides along.
 *   any update → `family:*` plus the row's own thread family as its comment
 *              family, so replies and submitted reviews fire too. Close, reopen
 *              and merge stay inert; supported updates and replies run.
 *   @-mention → the same subscriptions as any update, with `mentionOnly: true` —
 *              an event fires ONLY when its text @-mentions the agent or the
 *              organization's Gitea bot. The agent handle targets one rule; the
 *              bot handle broadcasts. Requesting the bot as a reviewer bypasses
 *              the gate entirely (§8).
 *
 * Where Gitea differs from GitLab is in the words, not the encoding: one
 * organization-level bot rather than a per-agent project bot, a pull request
 * rather than a merge request, and a commit status rather than a status note.
 *
 * The wire accepts finer `family:action` patterns; these helpers never emit one.
 */

import type { GiteaCommentFamily, GiteaHookFamily, HookCommentFamily } from './api'

export type GtFamily = GiteaHookFamily
export type GtTriggerMode = 'first' | 'every' | 'mention'

export interface GtFamilyTile {
  fam: GtFamily
  pill: string
  icon: string
  label: string
}

// Every subject the wire knows, in display order — a stored push row still reads its own
// label from here even though the console never offers one.
const GT_ALL_FAMILIES: GtFamilyTile[] = [
  { fam: 'issues', pill: 'Issues', icon: 'circle-dot', label: 'Issues' },
  { fam: 'merge_request', pill: 'PRs', icon: 'git-pull-request', label: 'Pull requests' },
  { fam: 'push', pill: 'Pushes', icon: 'git-commit-horizontal', label: 'Pushes' }
]

// The subjects the console OFFERS — the two the other hosts offer too. The push tile is
// intentionally held back, exactly as `GL_FAMILIES` holds it back; re-add it here (and
// restore the 3-up grid) to bring the feature back.
export const GT_FAMILIES: GtFamilyTile[] = GT_ALL_FAMILIES.filter((entry) => entry.fam !== 'push')

/** The display metadata for one family, including the held-back push subject. */
export function giteaFamilyTile(fam: GtFamily): GtFamilyTile | undefined {
  return GT_ALL_FAMILIES.find((entry) => entry.fam === fam)
}

/** Reviews and the commit status exist only on the change-proposal subject (the CP 400s otherwise). */
export function giteaFamilyCarriesReviews(fam: GtFamily): boolean {
  return fam === 'merge_request'
}

/** The trigger modes in display order — mention deliberately last. */
export const GT_TRIGGER_MODES: readonly GtTriggerMode[] = ['first', 'every', 'mention']
/** The cadence vocabulary ("Trigger when …") the create surfaces spell out. */
export const GT_TRIGGER_LABEL: Record<GtTriggerMode, string> = {
  first: 'opened',
  every: 'any update',
  mention: '@-mention'
}
/** The agent-detail trigger bar's segment vocabulary, worded like the IM bar. */
export const GT_TRIGGER_PILL: Record<GtTriggerMode, string> = {
  first: 'create',
  every: 'update',
  mention: '@-mention'
}

/** Per-segment hover copy for the trigger bar. */
export function giteaTriggerTooltip(mode: GtTriggerMode, agentName: string): string {
  switch (mode) {
    case 'first':
      return `Runs when an issue or pull request opens, plus later @${agentName} mentions.`
    case 'every':
      return 'Runs when an issue or pull request is opened and on supported updates, replies and submitted reviews (close, reopen and merge are ignored).'
    case 'mention':
      // Not "only @agent": the organization's bot handle is the repository-wide broadcast,
      // and requesting it as a reviewer bypasses cadence and mention.
      return `Runs when @${agentName} or the organization’s Gitea bot is mentioned, and on explicit reviewer requests.`
  }
}

/** Concrete hover copy for the agent-targeted Gitea mention form. */
export function giteaMentionUsage(agentName: string): string {
  return `Use @${agentName} to trigger only this agent.`
}

/** The default create-form selection: pull requests only. */
export const GT_DEFAULT_FAMILIES: readonly GtFamily[] = ['merge_request']

/** The cadence a create surface opens a new subject on — a pull request on every update, the rest on the opening. */
export function giteaDefaultTriggerMode(fam: GtFamily): GtTriggerMode {
  return fam === 'merge_request' ? 'every' : 'first'
}

/** Narrow a stored cross-host comment scope to the families a gitea hook may carry. */
export function giteaCommentFamilies(families: readonly HookCommentFamily[]): GiteaCommentFamily[] {
  return families.filter((family): family is GiteaCommentFamily => family === 'issues' || family === 'merge_request')
}

/** The comment families replies may arrive on — empty in opened mode, where a reply fires
 *  only by summoning the agent in an already-opened thread. */
export function commentFamiliesForGiteaFamilies(
  families: Iterable<GtFamily>,
  mode: GtTriggerMode
): GiteaCommentFamily[] {
  if (mode === 'first') return []
  const picked = new Set(families)
  return GT_ALL_FAMILIES.map((entry) => entry.fam).filter(
    (family): family is GiteaCommentFamily => family !== 'push' && picked.has(family)
  )
}

/** Compile the console's family+mode choice into stored event patterns, in display order —
 *  a hook's stored events must not depend on the order boxes were ticked. */
export function eventsForGiteaFamilies(families: Iterable<GtFamily>, mode: GtTriggerMode): string[] {
  const picked = new Set(families)
  return GT_ALL_FAMILIES.filter((entry) => picked.has(entry.fam)).map((entry) =>
    mode === 'first' && entry.fam !== 'push' ? `${entry.fam}:opened` : `${entry.fam}:*`
  )
}

/** Whether a hook's stored events cover a family (any action pattern counts). */
export function giteaFamCovered(events: readonly string[], family: GtFamily): boolean {
  return events.some((event) => event.startsWith(`${family}:`))
}

/** Recover the trigger mode: the mentionOnly flag wins, `:opened` ⇒ created. */
export function giteaTriggerModeOf(hook: { events: readonly string[]; mentionOnly: boolean }): GtTriggerMode {
  if (hook.mentionOnly) return 'mention'
  return hook.events.some((event) => event.endsWith(':opened')) ? 'first' : 'every'
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  return actualSet.size === expectedSet.size && [...actualSet].every((value) => expectedSet.has(value))
}

/** The stored subject families, in display order. */
function giteaFamiliesOf(events: readonly string[]): GtFamily[] {
  return GT_ALL_FAMILIES.map((entry) => entry.fam).filter((family) => giteaFamCovered(events, family))
}

/** Whether a persisted hook differs from the canonical console encoding — a stored rule the
 *  three-way trigger cannot express (replies on issues but not pull requests, or a finer
 *  `family:action` pattern an API caller wrote). Such a rule is never rewritten implicitly:
 *  the console shows the nearest trigger and flags the difference, and only an explicit
 *  cadence pick normalizes it — including a pick of the cadence already displayed. */
export function giteaHookNeedsNormalization(hook: {
  events: readonly string[]
  commentFamilies: readonly HookCommentFamily[]
  mentionOnly: boolean
}): boolean {
  const families = giteaFamiliesOf(hook.events)
  // A comment-only rule has no console family to normalize into and must remain untouched
  // even if the user reselects the displayed cadence.
  if (families.length === 0) return false
  const mode = giteaTriggerModeOf(hook)
  return (
    !sameMembers(hook.events, eventsForGiteaFamilies(families, mode)) ||
    !sameMembers(giteaCommentFamilies(hook.commentFamilies), commentFamiliesForGiteaFamilies(families, mode))
  )
}

/** The one subject family a stored row covers: its own `family`, or — for a legacy row the
 *  split could not place — the first family its events cover. */
export function giteaHookFamily(hook: { family: string | null; events: readonly string[] }): GtFamily | null {
  const declared = GT_ALL_FAMILIES.find((entry) => entry.fam === hook.family)
  if (declared) return declared.fam
  return giteaFamiliesOf(hook.events)[0] ?? null
}

/** The subscription block ONE (family, mode) row writes — `family` itself is create-only,
 *  so it is not part of this body. */
export interface GiteaFamilySubscription {
  events: string[]
  commentFamilies: GiteaCommentFamily[]
  mentionOnly: boolean
}

/** Compile one row's family+mode into the fields its create/update body carries. */
export function giteaFamilySubscription(fam: GtFamily, mode: GtTriggerMode): GiteaFamilySubscription {
  return {
    events: eventsForGiteaFamilies([fam], mode),
    commentFamilies: commentFamiliesForGiteaFamilies([fam], mode),
    mentionOnly: mode === 'mention'
  }
}

/** One edit-path write: the row's immutable family plus the cadence to store. */
export interface GiteaSubscriptionEdit {
  family: GtFamily
  mode: GtTriggerMode
}

/** A cadence pick on an existing hook — null when nothing would change, which is what keeps
 *  a stored rule the radio cannot express from being rewritten by the mere act of displaying
 *  it. Re-picking the DISPLAYED cadence on such a rule does write: that is the explicit
 *  opt-in that normalizes it. */
export function giteaCadencePick(
  hook: {
    family: string | null
    events: readonly string[]
    commentFamilies: readonly HookCommentFamily[]
    mentionOnly: boolean
  },
  mode: GtTriggerMode
): GiteaSubscriptionEdit | null {
  const family = giteaHookFamily(hook)
  if (!family) return null
  if (mode === giteaTriggerModeOf(hook) && !giteaHookNeedsNormalization(hook)) return null
  return { family, mode }
}
