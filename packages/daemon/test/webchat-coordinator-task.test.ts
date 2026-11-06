// webchat-threads.md §5.4: a webchat coordinator's task is recognized by the task index, whatever its coordinate.
import { describe, expect, it } from 'vitest'
import { webchatCoordinatorTask } from '../src/auto-session/webchat-task.js'
import { requestConversation } from '../src/permissions/request-conversation.js'

const AGENT = 'bot-a'
const CONV = '88888888-8888-4888-8888-888888888888'
const ROOT = '11111111-1111-4111-8111-111111111111'
const COORDINATOR_KEY = `webchat:${CONV}:append:coordinator-1:${AGENT}`
const PAGE_THREAD = 'subsession:2'
const PAGE_KEY = `webchat:a2a:${PAGE_THREAD}:${AGENT}`
const THREAD_KEY = `webchat:${CONV}:${ROOT}:${AGENT}`

interface Row {
  parentSessionId: string
  parentSessionKey: string
  mode?: 'watch'
  threads: { platform: string; channel: string; thread: string }[]
}

function storeOf(rows: Record<string, Row>, slots: Record<string, { key: string; thread: string }> = {}) {
  return {
    assistantSubsessions: {
      get: async (_agentId: string, key: string) => {
        const row = rows[key]
        return row ? { childSessionKey: key, ...row } : undefined
      },
      threadsOf: async (_agentId: string, key: string) => rows[key]?.threads ?? []
    },
    getSessionByAcpIdForAgent: async (_agentId: string, acpId: string) => slots[acpId],
    ensureOutwardSessionId: async (key: string) => `sid:${key}`
  }
}

const webchatTask = (threads: Row['threads'] = [{ platform: 'webchat', channel: CONV, thread: ROOT }]): Row => ({
  parentSessionId: 'sid-coordinator',
  parentSessionKey: COORDINATOR_KEY,
  threads
})

describe('a webchat coordinator’s task, by the task index (webchat-threads.md §5.4)', () => {
  it('recognizes a task keyed on its thread as it does a legacy page task, and tells the two apart', async () => {
    const store = storeOf({ [PAGE_KEY]: webchatTask(), [THREAD_KEY]: webchatTask() })
    expect(await webchatCoordinatorTask(store as never, AGENT, PAGE_KEY, PAGE_THREAD)).toEqual({
      parentSessionId: 'sid-coordinator',
      parentSessionKey: COORDINATOR_KEY,
      page: true
    })
    expect(await webchatCoordinatorTask(store as never, AGENT, THREAD_KEY, ROOT)).toEqual({
      parentSessionId: 'sid-coordinator',
      parentSessionKey: COORDINATOR_KEY,
      page: false
    })
  })

  it('never takes a Slack threaded task, a follow-up, a thread-less task, an unindexed session or a check for one', async () => {
    const slackKey = `slack:C1:100.1:${AGENT}`
    const store = storeOf({
      [slackKey]: webchatTask([{ platform: 'slack', channel: 'C1', thread: '100.1' }]),
      [THREAD_KEY]: { ...webchatTask(), mode: 'watch' },
      [PAGE_KEY]: webchatTask([]),
      [`webchat:a2a:subsession:check-1:${AGENT}`]: webchatTask()
    })
    expect(await webchatCoordinatorTask(store as never, AGENT, slackKey, '100.1')).toBeUndefined()
    expect(await webchatCoordinatorTask(store as never, AGENT, THREAD_KEY, ROOT)).toBeUndefined()
    expect(await webchatCoordinatorTask(store as never, AGENT, PAGE_KEY, PAGE_THREAD)).toBeUndefined()
    expect(
      await webchatCoordinatorTask(store as never, AGENT, `webchat:${CONV}:${CONV}:${AGENT}`, CONV)
    ).toBeUndefined()
    expect(
      await webchatCoordinatorTask(
        store as never,
        AGENT,
        `webchat:a2a:subsession:check-1:${AGENT}`,
        'subsession:check-1'
      )
    ).toBeUndefined()
    expect(
      await webchatCoordinatorTask(
        storeOf({ [COORDINATOR_KEY]: webchatTask() }) as never,
        AGENT,
        COORDINATOR_KEY,
        'append:coordinator-1'
      )
    ).toBeUndefined()
  })
})

describe('where a task’s permission request lists (webchat-threads.md §5.4)', () => {
  it('lists a task keyed on its webchat thread on its coordinator, as a page task’s and a background task’s', async () => {
    const slackKey = `slack:C1:100.1:${AGENT}`
    const backgroundKey = `slack:a2a:subsession:3:${AGENT}`
    const store = storeOf(
      {
        [THREAD_KEY]: webchatTask(),
        [PAGE_KEY]: webchatTask(),
        [slackKey]: webchatTask([{ platform: 'slack', channel: 'C1', thread: '100.1' }]),
        [backgroundKey]: webchatTask([])
      },
      {
        'acp-thread': { key: THREAD_KEY, thread: ROOT },
        'acp-page': { key: PAGE_KEY, thread: PAGE_THREAD },
        'acp-slack': { key: slackKey, thread: '100.1' },
        'acp-background': { key: backgroundKey, thread: 'subsession:3' }
      }
    )
    const where = (acpId: string) => requestConversation(store as never, AGENT, acpId, 0)
    expect(await where('acp-thread')).toEqual({ sessionId: `sid:${THREAD_KEY}`, parentSessionId: 'sid-coordinator' })
    expect(await where('acp-page')).toEqual({ sessionId: `sid:${PAGE_KEY}`, parentSessionId: 'sid-coordinator' })
    expect(await where('acp-background')).toEqual({
      sessionId: `sid:${backgroundKey}`,
      parentSessionId: 'sid-coordinator'
    })
    // A Slack threaded task's requests stay in its own thread alone.
    expect(await where('acp-slack')).toEqual({ sessionId: `sid:${slackKey}` })
  })
})
