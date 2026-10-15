import { describe, expect, it } from 'vitest'
import { AgentSkillStatus, MAX_AGENT_SKILL_STATUS_SOURCES } from './skill.js'
import { FRAME_SCHEMAS } from '../frame.js'

const base = { agentId: '00000000-0000-4000-8000-000000000001', ts: '2026-07-05T00:00:00.000Z' }

describe('agent/skill-status (source-cache.md §11)', () => {
  it('carries Source names with an enumerated code', () => {
    expect(FRAME_SCHEMAS['agent/skill-status']).toBe(AgentSkillStatus)
    const parsed = AgentSkillStatus.parse({ ...base, failed: [{ name: 'other-host', code: 'sha_fetch_refused' }] })
    expect(parsed.failed).toEqual([{ name: 'other-host', code: 'sha_fetch_refused' }])
    expect(AgentSkillStatus.parse({ ...base, failed: [] }).failed).toEqual([])
  })

  it('refuses raw output, extra fields, duplicate names and an unbounded list', () => {
    const bad = [
      { ...base, failed: [{ name: 'x', code: 'fatal: could not read Username' }] },
      { ...base, failed: [{ name: 'x', code: 'fetch_failed', detail: 'stderr' }] },
      {
        ...base,
        failed: [
          { name: 'x', code: 'fetch_failed' },
          { name: 'x', code: 'cli_failed' }
        ]
      },
      {
        ...base,
        failed: Array.from({ length: MAX_AGENT_SKILL_STATUS_SOURCES + 1 }, (_, i) => ({
          name: `s${i}`,
          code: 'fetch_failed'
        }))
      }
    ]
    for (const payload of bad) expect(AgentSkillStatus.safeParse(payload).success).toBe(false)
  })
})
