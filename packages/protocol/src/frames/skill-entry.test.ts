import { describe, it, expect } from 'vitest'
import { AgentSkillEntry } from './agent.js'

describe('AgentSkillEntry — argument-injection guards', () => {
  it('accepts a normal entry and defaults skills to []', () => {
    const e = AgentSkillEntry.parse({ name: 'platform', source: 'acme/platform-skills' })
    expect(e.skills).toEqual([])
  })

  it('rejects an option-like source (would be parsed as a CLI flag)', () => {
    expect(AgentSkillEntry.safeParse({ name: 'x', source: '--all' }).success).toBe(false)
    expect(AgentSkillEntry.safeParse({ name: 'x', source: '-rf' }).success).toBe(false)
  })

  it('rejects a skill value starting with "-"', () => {
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', skills: ['--all'] }).success).toBe(false)
    expect(AgentSkillEntry.safeParse({ name: 'x', source: 'o/r', skills: ['ok', '-bad'] }).success).toBe(false)
  })

  it('accepts ordinary skill names', () => {
    const e = AgentSkillEntry.parse({ name: 'x', source: 'o/r', skills: ['review-pr', 'safe_deploy'] })
    expect(e.skills).toEqual(['review-pr', 'safe_deploy'])
  })
})
