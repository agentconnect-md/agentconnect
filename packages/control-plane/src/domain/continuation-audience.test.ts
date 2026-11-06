import { describe, expect, it } from 'vitest'
import { TASK_PAGE_MESSAGES_FEATURE, WEBCHAT_THREADS_FEATURE } from '@agentconnect.md/protocol'
import { continuationAudience, continuationParentId, taskContinuationFeature } from './continuation-audience.js'

const AGENT = 'agent-1'
const coordinator = { id: 'sid-coordinator', agentId: AGENT }

describe('whose audience decides a continuation (webchat-threads.md §5.4)', () => {
  it('judges a legacy page task by the parent its lineage records', () => {
    const page = { agentId: AGENT, platform: 'webchat', thread: 'subsession:1', parentSessionId: coordinator.id }
    expect(continuationParentId(page)).toBe(coordinator.id)
    expect(continuationAudience(page, coordinator)).toBe(coordinator)
  })

  it('judges a webchat task keyed on its thread by the coordinator the task index reports', () => {
    const task = {
      agentId: AGENT,
      platform: 'webchat',
      thread: '11111111-1111-4111-8111-111111111111',
      taskParentSessionId: coordinator.id
    }
    expect(continuationParentId(task)).toBe(coordinator.id)
    expect(continuationAudience(task, coordinator)).toBe(coordinator)
    // A task whose coordinator is unread, another one, or another agent's stays unavailable rather than falling back to itself.
    expect(continuationAudience(task, null)).toBeNull()
    expect(continuationAudience(task, { id: 'sid-other', agentId: AGENT })).toBeNull()
    expect(continuationAudience(task, { ...coordinator, agentId: 'agent-2' })).toBeNull()
  })

  it('keeps a Slack threaded task, a released webchat task and an ordinary session their own audience', () => {
    const slackTask = { agentId: AGENT, platform: 'slack', thread: '100.1', taskParentSessionId: coordinator.id }
    expect(continuationParentId(slackTask)).toBeNull()
    expect(continuationAudience(slackTask, coordinator)).toBe(slackTask)
    const released = { agentId: AGENT, platform: 'webchat', thread: 'root', taskParentSessionId: null }
    expect(continuationAudience(released, coordinator)).toBe(released)
    const ordinary = { agentId: AGENT, platform: 'webchat', thread: 'webchat:conv' }
    expect(continuationAudience(ordinary, null)).toBe(ordinary)
  })

  it('leaves a background task without a recorded parent unavailable', () => {
    const orphan = { agentId: AGENT, platform: 'slack', thread: 'subsession:2', parentSessionId: null }
    expect(continuationParentId(orphan)).toBeNull()
    expect(continuationAudience(orphan, coordinator)).toBeNull()
  })

  it("asks a task's daemon to serve its console-only continuation: a page by its page feature, a thread by threads", () => {
    const root = '11111111-1111-4111-8111-111111111111'
    expect(taskContinuationFeature({ platform: 'webchat', thread: 'subsession:1' })).toBe(TASK_PAGE_MESSAGES_FEATURE)
    expect(taskContinuationFeature({ platform: 'slack', thread: 'subsession:1' })).toBe(TASK_PAGE_MESSAGES_FEATURE)
    expect(taskContinuationFeature({ platform: 'webchat', thread: root, taskParentSessionId: 'c' })).toBe(
      WEBCHAT_THREADS_FEATURE
    )
    for (const session of [
      { platform: 'slack', thread: '100.1', taskParentSessionId: 'c' },
      { platform: 'webchat', thread: root, taskParentSessionId: null },
      { platform: 'webchat', thread: 'subsession:check-1', taskParentSessionId: 'c' }
    ])
      expect(taskContinuationFeature(session)).toBeNull()
  })
})
