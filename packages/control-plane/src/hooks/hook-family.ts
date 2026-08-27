/**
 * `hooks/hook-family.ts` — the per-family shape of a code-host hook row
 * (webhook-triggers-and-github-events.md).
 *
 * A github/gitlab HookDef row covers exactly ONE subject family, so each family
 * carries its own cadence and its own mention gate. These are pure predicates:
 * the routes call them before any I/O, and the database's
 * (agent, kind, repo, family) uniqueness owns the duplicate rule.
 */

/** Every subject family the two code hosts between them subscribe to. */
export type HookFamily = 'issues' | 'pull_request' | 'merge_request' | 'push'

/** The families a row of each kind may declare. */
export const GITHUB_FAMILIES = ['pull_request', 'issues', 'push'] as const
export const GITLAB_FAMILIES = ['merge_request', 'issues', 'push'] as const

/** Reviews and run reporting exist only on a change-proposal subject. */
const REVIEW_FAMILIES = new Set<HookFamily>(['pull_request', 'merge_request'])

/** Whether the review/reporting axes may be non-default on this row. */
export function familyCarriesReviews(family: HookFamily): boolean {
  return REVIEW_FAMILIES.has(family)
}

/** The family a stored `family:action` pattern names, or null when it names none
 *  (GitHub's `issue_comment` covers both thread families, so alone it names no
 *  subject; the pattern's own scope comes from `commentFamilies`). */
export function familyOfEventPattern(pattern: string): HookFamily | null {
  const prefix = pattern.split(':', 1)[0]
  switch (prefix) {
    case 'issues':
    case 'pull_request':
    case 'merge_request':
    case 'push':
      return prefix
    case 'pull_request_review_comment':
      return 'pull_request'
    default:
      return null
  }
}

/** Whether one stored pattern belongs on a row of this kind and family. */
export function eventPatternFitsFamily(kind: 'github' | 'gitlab', family: HookFamily, pattern: string): boolean {
  const prefix = pattern.split(':', 1)[0]
  if (prefix === 'issue_comment') {
    return kind === 'github' && (family === 'issues' || family === 'pull_request')
  }
  if (prefix === 'pull_request_review_comment') return kind === 'github' && family === 'pull_request'
  return prefix === family
}

/** Whether any pattern rides GitHub's shared issue_comment subscription. */
export function hasSharedCommentPattern(events: readonly string[]): boolean {
  return events.some((pattern) => pattern.split(':', 1)[0] === 'issue_comment')
}

/** The per-row subscription block a write proposes. */
export interface HookFamilyShape {
  kind: 'github' | 'gitlab'
  family: HookFamily
  events: readonly string[]
  commentFamilies: readonly string[]
  reviewPolicy: string
  reportingMode: string
  gateMode: string
}

/**
 * The 400 reason this row shape is not a single-family subscription, or null.
 * Every check is a statement about ONE row: the sibling comparisons (identical
 * anchoring, one row per family) live with the route that can read siblings.
 */
export function hookFamilyShapeError(shape: HookFamilyShape): string | null {
  const offending = shape.events.find((pattern) => !eventPatternFitsFamily(shape.kind, shape.family, pattern))
  if (offending !== undefined) {
    return `event "${offending}" does not belong to the ${shape.family} family — subscribe to it on that family's own trigger`
  }
  const strayComment = shape.commentFamilies.find((candidate) => candidate !== shape.family)
  if (strayComment !== undefined) {
    return `commentFamilies may only scope this row's own ${shape.family} family, not ${strayComment}`
  }
  // GitHub narrows its shared issue_comment subscription with commentFamilies;
  // leaving it empty is the legacy repo-wide meaning, which would double-fire
  // against the sibling row that owns the other thread family.
  if (shape.kind === 'github' && hasSharedCommentPattern(shape.events) && shape.commentFamilies.length === 0) {
    return `an issue_comment subscription must set commentFamilies to ["${shape.family}"]`
  }
  if (!familyCarriesReviews(shape.family)) {
    if (shape.reviewPolicy !== 'off' || shape.reportingMode !== 'off' || shape.gateMode !== 'informational') {
      return 'reviews and run reporting apply to pull-request/merge-request rows'
    }
  }
  return null
}

/** The anchoring/session block sibling rows of one (agent, repo) must agree on:
 *  they answer the same thread, so a divergent anchor would split its replies. */
export interface HookSiblingShape {
  targetPlatform: string
  targetChannel: string | null
  targetIntegrationId: string | null
  sessionMode: string
}

/** The 409 reason this row disagrees with its siblings on that block, or null. */
export function hookSiblingShapeError(
  siblings: readonly HookSiblingShape[],
  proposed: HookSiblingShape,
  repoLabel: string
): string | null {
  const differs = siblings.find(
    (sibling) =>
      sibling.targetPlatform !== proposed.targetPlatform ||
      sibling.targetChannel !== proposed.targetChannel ||
      sibling.targetIntegrationId !== proposed.targetIntegrationId ||
      sibling.sessionMode !== proposed.sessionMode
  )
  if (!differs) return null
  return `this agent's other ${repoLabel} triggers post somewhere else — change them together, or they would answer one thread in two places`
}
