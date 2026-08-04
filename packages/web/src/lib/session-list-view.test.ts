import { describe, expect, it } from 'vitest'
import { isFlatSessionView, sessionListSearchParams } from './session-list-view'

describe('session list view query', () => {
  it('recognizes only the explicit flat view', () => {
    expect(isFlatSessionView(new URLSearchParams('view=flat'))).toBe(true)
    expect(isFlatSessionView(new URLSearchParams('view=grouped'))).toBe(false)
  })

  it('carries flat view and active filters between list and detail routes', () => {
    const params = new URLSearchParams('view=flat&agent=agent-1&integration=all&ignored=value')
    expect(sessionListSearchParams(params).toString()).toBe('view=flat&agent=agent-1')
  })
})
