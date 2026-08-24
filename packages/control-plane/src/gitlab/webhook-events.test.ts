/** §11.1 desired-events union: the managed webhook subscribes to exactly what
 *  the enabled gitlab hooks on the project need, comments over-subscribed. */
import { describe, expect, it } from 'vitest'
import { unionGitlabWebhookEvents } from './webhook-events.js'

const PROJECT = 4455667n
const hook = (over: Partial<Parameters<typeof unionGitlabWebhookEvents>[0][number]> = {}) => ({
  enabled: true,
  kind: 'gitlab' as const,
  repoId: PROJECT,
  events: ['issues:*'],
  commentFamilies: [],
  ...over
})

describe('unionGitlabWebhookEvents', () => {
  it('returns null when no enabled gitlab hook targets the project', () => {
    expect(unionGitlabWebhookEvents([], PROJECT)).toBeNull()
    expect(unionGitlabWebhookEvents([hook({ enabled: false })], PROJECT)).toBeNull()
    expect(unionGitlabWebhookEvents([hook({ kind: 'github' })], PROJECT)).toBeNull()
    expect(unionGitlabWebhookEvents([hook({ repoId: 1n })], PROJECT)).toBeNull()
  })

  it('unions event families across hooks', () => {
    const events = unionGitlabWebhookEvents(
      [hook(), hook({ events: ['merge_request:opened'] }), hook({ events: ['push:*'] })],
      PROJECT
    )
    expect(events).toEqual({
      push_events: true,
      issues_events: true,
      merge_requests_events: true,
      note_events: true
    })
  })

  it('thread-bearing triggers and comment families subscribe notes; a push-only hook does not', () => {
    expect(unionGitlabWebhookEvents([hook({ events: ['push:*'] })], PROJECT)?.note_events).toBe(false)
    expect(
      unionGitlabWebhookEvents([hook({ events: ['push:*'], commentFamilies: ['merge_request'] })], PROJECT)?.note_events
    ).toBe(true)
    expect(unionGitlabWebhookEvents([hook({ events: ['merge_request:*'] })], PROJECT)).toMatchObject({
      merge_requests_events: true,
      note_events: true,
      issues_events: false,
      push_events: false
    })
  })
})
