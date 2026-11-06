import { describe, expect, it } from 'vitest'
import { takesCurrentSession } from './webchat-current-session.js'

const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('which webchat row takes the conversation’s current-session pointer (webchat-threads.md §5.4)', () => {
  it('takes it for the conversation’s own thread, its coordinator, and a row that reported none', () => {
    expect(takesCurrentSession(CONV, `webchat:${CONV}`)).toBe(true)
    expect(takesCurrentSession(CONV, 'append:coordinator-1')).toBe(true)
    expect(takesCurrentSession(CONV, null)).toBe(true)
    expect(takesCurrentSession(CONV, '')).toBe(true)
  })

  it('never takes it for a task keyed on a thread, or another conversation’s thread', () => {
    expect(takesCurrentSession(CONV, '11111111-1111-4111-8111-111111111111')).toBe(false)
    expect(takesCurrentSession(CONV, 'webchat:dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toBe(false)
  })
})
