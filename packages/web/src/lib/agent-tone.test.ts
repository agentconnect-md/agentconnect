import { describe, expect, it } from 'vitest'
import { agentToneColor, AGENT_TONE_COUNT } from './agent-tone'

describe('agentToneColor', () => {
  it('is stable per key and spreads ids across every tone', () => {
    expect(agentToneColor('agent-a')).toBe(agentToneColor('agent-a'))
    // A transcript that colours two agents the same has failed at its one job, so
    // the hash has to actually reach every tone rather than clustering.
    const seen = new Set(Array.from({ length: 200 }, (_, i) => agentToneColor(`agent-${i}`)))
    expect(seen.size).toBe(AGENT_TONE_COUNT)
  })

  it('returns an accent token, never a ready-made background', () => {
    // `.abub` mixes the accent into the live surface; a literal background here
    // would be wrong in one of the two themes.
    for (let i = 0; i < 20; i++) expect(agentToneColor(`k${i}`)).toMatch(/^var\(--[a-z]+-500\)$/)
  })
})
