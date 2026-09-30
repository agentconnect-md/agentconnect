import type { HookRecord } from '../persistence/ports.js'
import type { GitlabWebhookEvents } from './api.js'

// Union trigger and author-feedback subscriptions; null means no consumer needs ingress.
export function unionGitlabWebhookEvents(
  hooks: Pick<HookRecord, 'enabled' | 'kind' | 'repoId' | 'events' | 'commentFamilies'>[],
  projectId: bigint,
  feedback = false
): GitlabWebhookEvents | null {
  const relevant = hooks.filter((hook) => hook.enabled && hook.kind === 'gitlab' && hook.repoId === projectId)
  if (relevant.length === 0 && !feedback) return null
  const events: GitlabWebhookEvents = {
    push_events: false,
    issues_events: false,
    merge_requests_events: feedback,
    note_events: feedback,
    pipeline_events: feedback,
    releases_events: false
  }
  for (const hook of relevant) {
    for (const pattern of hook.events) {
      if (pattern.startsWith('issues:')) events.issues_events = true
      else if (pattern.startsWith('merge_request:')) events.merge_requests_events = true
      else if (pattern.startsWith('push:')) events.push_events = true
      else if (pattern.startsWith('release:')) events.releases_events = true
    }
    if (events.issues_events || events.merge_requests_events || hook.commentFamilies.length > 0) {
      events.note_events = true
    }
  }
  return events
}
