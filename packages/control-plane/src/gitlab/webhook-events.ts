import type { HookRecord } from '../persistence/ports.js'
import type { GitlabWebhookEvents } from './api.js'

// Union trigger, author-feedback and follow-up subscriptions (assistant-mode.md §5.14); null means no consumer needs ingress.
export function unionGitlabWebhookEvents(
  hooks: Pick<HookRecord, 'enabled' | 'kind' | 'repoId' | 'events' | 'commentFamilies'>[],
  projectId: bigint,
  feedback = false,
  followUps = false
): GitlabWebhookEvents | null {
  const relevant = hooks.filter((hook) => hook.enabled && hook.kind === 'gitlab' && hook.repoId === projectId)
  if (relevant.length === 0 && !feedback && !followUps) return null
  const objects = feedback || followUps
  const events: GitlabWebhookEvents = {
    push_events: false,
    issues_events: followUps,
    merge_requests_events: objects,
    note_events: objects,
    pipeline_events: objects,
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
