// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { sessionFilterAgentKey } from './use-session-list'

describe('sessionFilterAgentKey', () => {
  it('addresses one cache entry per SET of agents, whatever order they were picked in', () => {
    // The rail builds the filter one chip at a time, so the same pair arrives in
    // either order. The CP's answer does not depend on that order, and neither
    // may the cache key — otherwise picking A then B refetches what B then A
    // already has.
    expect(sessionFilterAgentKey(['agent-b', 'agent-a'])).toBe(sessionFilterAgentKey(['agent-a', 'agent-b']))
  })

  it('keeps the single-agent key identical to the plain string form', () => {
    expect(sessionFilterAgentKey(['agent-a'])).toBe(sessionFilterAgentKey('agent-a'))
  })

  it('is empty for no filter, so the key says "unfiltered" rather than "filtered by nothing"', () => {
    expect(sessionFilterAgentKey(undefined)).toBe('')
    expect(sessionFilterAgentKey([])).toBe('')
  })
})
