import type { HookRecord } from '../persistence/ports.js'
import type { GitlabWebhookEvents } from './api.js'

/**
 * The §11.1 desired-events input: the union every enabled gitlab hook on one
 * project wants from the managed webhook. Null means no hook wants ingress, so
 * the saga removes (or never installs) the webhook. Comment (`note`) events are
 * over-subscribed deliberately: threads opened by issue/MR triggers continue
 * through comments, so under-subscribing them would strand every per-thread
 * session; the relay filters what a rule did not ask for.
 */
export function unionGitlabWebhookEvents(
  hooks: Pick<HookRecord, 'enabled' | 'kind' | 'repoId' | 'events' | 'commentFamilies'>[],
  projectId: bigint
): GitlabWebhookEvents | null {
  const relevant = hooks.filter((hook) => hook.enabled && hook.kind === 'gitlab' && hook.repoId === projectId)
  if (relevant.length === 0) return null
  const events: GitlabWebhookEvents = {
    push_events: false,
    issues_events: false,
    merge_requests_events: false,
    note_events: false
  }
  for (const hook of relevant) {
    for (const pattern of hook.events) {
      if (pattern.startsWith('issues:')) events.issues_events = true
      else if (pattern.startsWith('merge_request:')) events.merge_requests_events = true
      else if (pattern.startsWith('push:')) events.push_events = true
    }
    if (events.issues_events || events.merge_requests_events || hook.commentFamilies.length > 0) {
      events.note_events = true
    }
  }
  return events
}
