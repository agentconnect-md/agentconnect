import { describe, expect, it } from 'vitest'
import {
  isFlatSessionView,
  sessionListSearchParams,
  showsDreams,
  showsTasks,
  withShowDreams,
  withShowTasks
} from './session-list-view'

describe('session list view query', () => {
  it('recognizes only the explicit flat view', () => {
    expect(isFlatSessionView(new URLSearchParams('view=flat'))).toBe(true)
    expect(isFlatSessionView(new URLSearchParams('view=grouped'))).toBe(false)
  })

  it('carries flat view and active filters between list and detail routes', () => {
    const params = new URLSearchParams('view=flat&agent=agent-1&integration=all&ignored=value')
    expect(sessionListSearchParams(params).toString()).toBe('view=flat&agent=agent-1')
  })

  it('hides tasks unless the Show tasks toggle is on, and carries the toggle', () => {
    expect(showsTasks(new URLSearchParams(''))).toBe(false)
    expect(showsTasks(new URLSearchParams('tasks=hide'))).toBe(false)
    expect(showsTasks(new URLSearchParams('tasks=show'))).toBe(true)
    expect(sessionListSearchParams(new URLSearchParams('agent=agent-1&tasks=show')).toString()).toBe(
      'agent=agent-1&tasks=show'
    )
    expect(withShowTasks(new URLSearchParams('agent=agent-1'), true).toString()).toBe('agent=agent-1&tasks=show')
    expect(withShowTasks(new URLSearchParams('agent=agent-1&tasks=show'), false).toString()).toBe('agent=agent-1')
  })

  it('hides memory dream sessions unless their toggle is on, and carries the toggle', () => {
    expect(showsDreams(new URLSearchParams(''))).toBe(false)
    expect(showsDreams(new URLSearchParams('dreams=hide'))).toBe(false)
    expect(showsDreams(new URLSearchParams('dreams=show'))).toBe(true)
    expect(sessionListSearchParams(new URLSearchParams('tasks=show&dreams=show')).toString()).toBe(
      'tasks=show&dreams=show'
    )
    expect(withShowDreams(new URLSearchParams('tasks=show'), true).toString()).toBe('tasks=show&dreams=show')
    expect(withShowDreams(new URLSearchParams('tasks=show&dreams=show'), false).toString()).toBe('tasks=show')
  })
})
