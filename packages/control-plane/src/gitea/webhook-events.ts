/**
 * The managed webhook's subscription union (gitea-integration.md §7): every enabled gitea hook on
 * one repository, mapped from the product families to Gitea's subscription names. Comment events
 * are over-subscribed deliberately — a per-thread session opened by an issue or pull-request
 * trigger continues through comments — and the relay filters what a rule did not ask for.
 */
import type { HookRecord } from '../persistence/ports.js'

/** Every subscription name the product ever asks for; anything else Gitea silently drops (§16). */
export const GITEA_WEBHOOK_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_sync',
  'pull_request_review_request',
  'pull_request_comment',
  'pull_request_review',
  'push'
] as const
export type GiteaWebhookEvent = (typeof GITEA_WEBHOOK_EVENTS)[number]

const ISSUE_EVENTS: readonly GiteaWebhookEvent[] = ['issues', 'issue_comment']
const MERGE_REQUEST_EVENTS: readonly GiteaWebhookEvent[] = [
  'pull_request',
  'pull_request_sync',
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

/** The desired-events input of the saga; null means no enabled hook wants ingress, so no webhook. */
export function unionGiteaWebhookEvents(
  hooks: Pick<HookRecord, 'enabled' | 'kind' | 'repoId' | 'events' | 'commentFamilies'>[],
  repoId: bigint
): GiteaWebhookEvent[] | null {
  const relevant = hooks.filter((hook) => hook.enabled && hook.kind === 'gitea' && hook.repoId === repoId)
  if (relevant.length === 0) return null
  const events = new Set<GiteaWebhookEvent>()
  for (const hook of relevant) {
    for (const pattern of hook.events) {
      if (pattern.startsWith('issues:')) for (const event of ISSUE_EVENTS) events.add(event)
      else if (pattern.startsWith('merge_request:')) for (const event of MERGE_REQUEST_EVENTS) events.add(event)
      else if (pattern.startsWith('push:')) events.add('push')
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
