// Union trigger and author-feedback subscriptions; the relay filters each consumer's events.
import type { HookRecord } from '../persistence/ports.js'
import type { GiteaInstanceVersion } from './version.js'

/** Every subscription name the product ever asks for; anything else Gitea silently drops (§16). */
export const GITEA_WEBHOOK_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_sync',
  'pull_request_label',
  'pull_request_review_request',
  'pull_request_comment',
  'pull_request_review',
  'push',
  'release',
  'status',
  'workflow_run'
] as const
export type GiteaWebhookEvent = (typeof GITEA_WEBHOOK_EVENTS)[number]

// `issues` expands to its label variant on Gitea's side; `pull_request` does not, so the label filter's entry event is asked for by name.
const ISSUE_EVENTS: readonly GiteaWebhookEvent[] = ['issues', 'issue_comment']
const MERGE_REQUEST_EVENTS: readonly GiteaWebhookEvent[] = [
  'pull_request',
  'pull_request_sync',
  'pull_request_label',
  'pull_request_review_request',
  'pull_request_review',
  'issue_comment',
  'pull_request_comment'
]
const PULL_REQUEST_COMMENT_EVENTS: readonly GiteaWebhookEvent[] = [
  'issue_comment',
  'pull_request_comment',
  'pull_request_review'
]

/** Null means neither triggers nor writable workspaces need ingress. */
export function unionGiteaWebhookEvents(
  hooks: Pick<HookRecord, 'enabled' | 'kind' | 'repoId' | 'events' | 'commentFamilies'>[],
  repoId: bigint,
  feedback = false,
  version?: GiteaInstanceVersion
): GiteaWebhookEvent[] | null {
  const relevant = hooks.filter((hook) => hook.enabled && hook.kind === 'gitea' && hook.repoId === repoId)
  if (relevant.length === 0 && !feedback) return null
  const events = new Set<GiteaWebhookEvent>()
  if (feedback) {
    for (const event of PULL_REQUEST_COMMENT_EVENTS) events.add(event)
    if (
      version?.product === 'gitea' &&
      version.major !== null &&
      version.minor !== null &&
      (version.major > 1 || (version.major === 1 && version.minor >= 25))
    ) {
      events.add('status')
      events.add('workflow_run')
    }
  }
  for (const hook of relevant) {
    for (const pattern of hook.events) {
      if (pattern.startsWith('issues:')) for (const event of ISSUE_EVENTS) events.add(event)
      else if (pattern.startsWith('merge_request:')) for (const event of MERGE_REQUEST_EVENTS) events.add(event)
      else if (pattern.startsWith('push:')) events.add('push')
      else if (pattern.startsWith('release:')) events.add('release')
    }
    for (const family of hook.commentFamilies) {
      if (family === 'issues') events.add('issue_comment')
      if (family === 'merge_request') for (const event of PULL_REQUEST_COMMENT_EVENTS) events.add(event)
    }
  }
  // Stable order, so the desired-events hash compares by content and not by insertion.
  return GITEA_WEBHOOK_EVENTS.filter((event) => events.has(event))
}

/** The desired names the stored webhook does NOT carry — compared by subset, because Gitea expands umbrella names (§7). */
export function giteaWebhookEventsMissing(desired: readonly string[], stored: readonly string[]): string[] {
  const present = new Set(stored)
  return desired.filter((event) => !present.has(event))
}

/** The hash the binding records the converged subscription under. */
export function giteaWebhookEventsHash(events: readonly string[]): string {
  return JSON.stringify([...events].sort())
}
