// The two pure halves of the workspace connect round trip: what the hand-off may
// offer right now, and how the funnel row's terminal codes read. Both are where a
// silent behavior change would hide — the copy is the ONLY channel a settled row
// has back to the operator, because the OAuth tab is a throwaway.

import { describe, expect, it } from 'vitest'
import { linearConnectAvailability, linearConnectFailure } from './connect'

describe('linearConnectAvailability', () => {
  it('waits rather than guessing while the deployment probe has no answer', () => {
    expect(linearConnectAvailability({ relayAvailable: null, appConfigured: null })).toBe('checking')
  })

  it('offers the hand-off once a relay is connected', () => {
    expect(linearConnectAvailability({ relayAvailable: true, appConfigured: null })).toBe('ready')
  })

  it('refuses without public callback delivery — Linear has no dial-out transport', () => {
    expect(linearConnectAvailability({ relayAvailable: false, appConfigured: null })).toBe('relay_required')
  })

  it('puts a missing deployment app ahead of every other reason', () => {
    // The one an operator cannot fix from this console at all, and the only one
    // that stays true whatever the relay is doing.
    expect(linearConnectAvailability({ relayAvailable: true, appConfigured: false })).toBe('app_required')
    expect(linearConnectAvailability({ relayAvailable: false, appConfigured: false })).toBe('app_required')
    expect(linearConnectAvailability({ relayAvailable: null, appConfigured: false })).toBe('app_required')
  })
})

describe('linearConnectFailure', () => {
  it('gives every settled code a sentence of its own', () => {
    const codes = [
      'denied',
      'expired',
      'workspace_taken',
      'wrong_workspace',
      'default_agent_required',
      'agent_missing',
      'error'
    ]
    const sentences = codes.map((code) => linearConnectFailure(code))
    // 'error' shares the fallback, so only the six named codes must be distinct.
    expect(new Set(sentences.slice(0, 6)).size).toBe(6)
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(0)
  })

  it('names the two refusals an operator has to act on elsewhere', () => {
    expect(linearConnectFailure('workspace_taken')).toContain('already connected to a different organization')
    expect(linearConnectFailure('wrong_workspace')).toContain('authorized a different workspace')
  })

  it('falls back for an unknown or absent code rather than showing one raw', () => {
    const fallback = linearConnectFailure('error')
    expect(linearConnectFailure(null)).toBe(fallback)
    expect(linearConnectFailure('a_code_this_console_has_not_been_taught')).toBe(fallback)
  })
})
