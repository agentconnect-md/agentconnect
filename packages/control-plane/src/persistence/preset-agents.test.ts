/**
 * Validation-parity pins for the preset seam (preset-agents.md §3.2/§3.3).
 *
 * Provisioning writes the agent row through `PgAgentRepo.create`, NOT through
 * `CreateAgentBody` — so the preset's fixed identity must be provably legal
 * under the DTO rules it bypasses, and the reserved-slug set must cover it.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_ICON_GLYPHS } from '@agentconnect.md/protocol'
import { GENERAL_PRESET, RESERVED_AGENT_SLUGS } from './preset-agents.js'
import { HEX_COLOR_RE } from '../agents/agent-icon.js'

// The DTO's AgentSlug grammar (dto/index.ts) — duplicated here as the drift
// guard: if either side changes shape, this pin fails before a preset ships.
const AGENT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe('GENERAL_PRESET validation parity', () => {
  it('carries a slug that is legal under the DTO grammar and ≤63 chars', () => {
    expect(GENERAL_PRESET.name).toMatch(AGENT_SLUG_RE)
    expect(GENERAL_PRESET.name.length).toBeLessThanOrEqual(63)
  })

  it('is protected by the reserved-slug set (not impersonable)', () => {
    expect(RESERVED_AGENT_SLUGS.has(GENERAL_PRESET.name)).toBe(true)
  })

  it('pins the fixed brand identity', () => {
    expect(GENERAL_PRESET.displayName).toBe('AgentConnect')
    expect(GENERAL_PRESET.icon.kind).toBe('glyph')
    expect(AGENT_ICON_GLYPHS).toContain(GENERAL_PRESET.icon.glyph)
    expect(GENERAL_PRESET.icon.color).toMatch(HEX_COLOR_RE)
  })
})

describe('RESERVED_AGENT_SLUGS', () => {
  it('reserves the design §3.3 set — including the M3 assistant names', () => {
    expect([...RESERVED_AGENT_SLUGS].sort()).toEqual([
      'agent-assistant',
      'agentconnect',
      'agentconnect-assistant',
      'assistant'
    ])
  })
})
