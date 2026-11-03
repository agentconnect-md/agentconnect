import { describe, expect, it } from 'vitest'
import { taskLinkOfBody } from './task-link'

describe('taskLinkOfBody', () => {
  it('reads the task a coordinator’s post is marked with', () => {
    const taskLink = { sessionId: 'ses_123', title: 'Find what blocks api 1.5', how: 'opened' }
    expect(taskLinkOfBody(JSON.stringify({ taskLink }))).toEqual(taskLink)
  })

  it('leaves every other row as text', () => {
    expect(taskLinkOfBody(undefined)).toBeNull()
    expect(taskLinkOfBody('not json')).toBeNull()
    expect(
      taskLinkOfBody(JSON.stringify({ prompt: 'Started a task: [x](https://console.example.test/s/1)' }))
    ).toBeNull()
    expect(taskLinkOfBody(JSON.stringify({ taskLink: { sessionId: 'ses_1', how: 'moved' } }))).toBeNull()
  })
})
